import { Ajv, addFormats } from "@modelcontextprotocol/server/validators/ajv";
import {
  MAX_BLOCKS_PER_MESSAGE,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_VERSION,
  SCHEMA_NAME_PATTERN,
  type Block,
  type DataSchema,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import type { SchemaEngine } from "../platform.js";
import { tx } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import { nowIso, requireMember } from "./access.js";
import type { Actor } from "./model.js";

type JsonObject = Record<string, unknown>;

interface SchemaDef {
  name: string;
  version: number;
  description: string | null;
  schema: JsonObject;
  builtin: boolean;
  created_at: string | null;
}

const SHA = { type: "string", pattern: "^[0-9a-f]{7,64}$" };

/** Built into every board. */
export const BUILTIN_SCHEMAS: SchemaDef[] = [
  {
    name: "git-commit",
    version: 1,
    description: "A Git commit: its SHA, and optionally its message, author, repository, branch and URL.",
    builtin: true,
    created_at: null,
    schema: {
      type: "object",
      required: ["sha"],
      properties: {
        sha: SHA,
        message: { type: "string", maxLength: 4000 },
        author: { type: "object", properties: { name: { type: "string" }, email: { type: "string" } }, additionalProperties: false },
        repository: { type: "string", maxLength: 200 },
        branch: { type: "string", maxLength: 200 },
        url: { type: "string", format: "uri" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deployment",
    version: 1,
    description: "A deployment: its ID and state, and optionally its URL, environment, project, commit and creation time.",
    builtin: true,
    created_at: null,
    schema: {
      type: "object",
      required: ["id", "state"],
      properties: {
        id: { type: "string", maxLength: 200 },
        state: { enum: ["queued", "building", "ready", "error", "canceled"] },
        url: { type: "string", format: "uri" },
        environment: { type: "string", maxLength: 100 },
        project: { type: "string", maxLength: 200 },
        commit: SHA,
        created_at: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
  },
];

// Draft-07. Schemas never add themselves to the instance by $id, so boards can't collide.
const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });
addFormats(ajv);

/** The default engine: Ajv (compiles validators to code; runtimes that forbid that supply their own). */
export const ajvSchemas: SchemaEngine = {
  check(schema) {
    if (!ajv.validateSchema(schema)) throw new Error(ajv.errorsText(ajv.errors));
    ajv.compile(schema);
  },
  compile(schema) {
    const validate = ajv.compile(schema);
    return (data) => (validate(data) ? [] : (validate.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "invalid" })));
  },
};

type Validate = ReturnType<SchemaEngine["compile"]>;
const compiled = new Map<string, Validate>();
const engine = (ctx: AppContext): SchemaEngine => ctx.platform.schemas ?? ajvSchemas;

const schemaId = (name: string, version: number) => `${name}@${version}`;

export function parseSchemaId(id: string): { name: string; version: number } {
  const m = /^(.+)@([0-9]+)$/.exec(id.trim());
  const version = m ? Number(m[2]) : NaN;
  if (!m || !SCHEMA_NAME_PATTERN.test(m[1]!) || !Number.isInteger(version) || version < 1 || version > MAX_SCHEMA_VERSION) {
    throw invalid(`Schema IDs look like name@version, such as git-commit@1`, { schema: id });
  }
  return { name: m[1]!, version };
}

function present(def: SchemaDef): DataSchema {
  return { id: schemaId(def.name, def.version), name: def.name, version: def.version, description: def.description, schema: def.schema, builtin: def.builtin, created_at: def.created_at };
}

function findSchema(ctx: AppContext, boardId: string, name: string, version: number): SchemaDef | undefined {
  const builtin = BUILTIN_SCHEMAS.find((s) => s.name === name && s.version === version);
  if (builtin) return builtin;
  const row = ctx.db.prepare("SELECT * FROM data_schemas WHERE board_id = ? AND name = ? AND version = ?").get(boardId, name, version) as
    | { name: string; version: number; description: string | null; definition: string; created_at: string }
    | undefined;
  if (!row) return undefined;
  return { name: row.name, version: row.version, description: row.description, schema: JSON.parse(row.definition) as JsonObject, builtin: false, created_at: row.created_at };
}

function notFound(id: string): OmbError {
  return new OmbError("schema_not_found", `This board has no schema ${id}`, { schema: id });
}

/** JSON with sorted keys, to compare definitions. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonObject)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as JsonObject)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const SUBSCHEMA = ["items", "additionalItems", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];
const SUBSCHEMA_LISTS = ["allOf", "anyOf", "oneOf"];
const SUBSCHEMA_MAPS = ["properties", "definitions", "$defs", "dependencies"];

/**
 * Board schemas validate data that other members write, so they may not use regular expressions (`pattern`,
 * `patternProperties`): a crafted expression could stall the server on every write.
 */
function assertNoRegex(node: unknown, path: string): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertNoRegex(n, `${path}/${i}`));
  if (!node || typeof node !== "object") return;
  const obj = node as JsonObject;
  for (const key of ["pattern", "patternProperties"]) {
    if (key in obj) throw invalid(`Board schemas can't use "${key}" (at ${path || "/"})`, { issues: [{ path: path || "/", message: `${key} is not allowed` }] });
  }
  for (const key of SUBSCHEMA) if (key in obj) assertNoRegex(obj[key], `${path}/${key}`);
  for (const key of SUBSCHEMA_LISTS) if (Array.isArray(obj[key])) assertNoRegex(obj[key], `${path}/${key}`);
  for (const key of SUBSCHEMA_MAPS) {
    const map = obj[key];
    if (map && typeof map === "object" && !Array.isArray(map)) for (const [k, v] of Object.entries(map as JsonObject)) assertNoRegex(v, `${path}/${key}/${k}`);
  }
}

function validatorFor(ctx: AppContext, boardId: string, def: SchemaDef): Validate {
  const key = def.builtin ? `*:${schemaId(def.name, def.version)}` : `${boardId}:${schemaId(def.name, def.version)}`;
  let v = compiled.get(key);
  if (!v) {
    v = engine(ctx).compile(def.schema as Record<string, unknown>);
    compiled.set(key, v);
  }
  return v;
}

export function listSchemas(ctx: AppContext, actor: Actor, boardId: string): { schemas: DataSchema[] } {
  requireMember(ctx, actor, boardId);
  const rows = ctx.db.prepare("SELECT * FROM data_schemas WHERE board_id = ? ORDER BY name, version").all(boardId) as {
    name: string;
    version: number;
    description: string | null;
    definition: string;
    created_at: string;
  }[];
  const own = rows.map((r) => ({ name: r.name, version: r.version, description: r.description, schema: JSON.parse(r.definition) as JsonObject, builtin: false, created_at: r.created_at }));
  return { schemas: [...BUILTIN_SCHEMAS, ...own].map(present) };
}

export function getSchema(ctx: AppContext, actor: Actor, boardId: string, id: string): { schema: DataSchema } {
  requireMember(ctx, actor, boardId);
  const { name, version } = parseSchemaId(id);
  const def = findSchema(ctx, boardId, name, version);
  if (!def) throw notFound(schemaId(name, version));
  return { schema: present(def) };
}

export interface RegisterSchemaInput {
  name: string;
  version: number;
  schema: JsonObject;
  description?: string | undefined;
}

/** Board owners register `name@version`. A version never changes: the same definition again is a no-op. */
export function registerSchema(ctx: AppContext, actor: Actor, boardId: string, input: RegisterSchemaInput): { schema: DataSchema; created: boolean } {
  const name = input.name.trim();
  if (!SCHEMA_NAME_PATTERN.test(name)) throw invalid("Schema names use lowercase letters, digits, '.', '_' or '-' (up to 64), starting with a letter or digit");
  if (!Number.isInteger(input.version) || input.version < 1 || input.version > MAX_SCHEMA_VERSION) throw invalid(`version must be 1-${MAX_SCHEMA_VERSION}`);
  const schema = input.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw invalid("schema must be a JSON Schema object");
  const size = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (size > MAX_SCHEMA_BYTES) throw invalid(`Schemas can be up to ${MAX_SCHEMA_BYTES} bytes; this one is ${size}`);
  if (schema.type !== "object") throw invalid('A schema describes an object: set "type": "object"');
  if (schema.$schema !== undefined && !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(String(schema.$schema))) {
    throw invalid("Schemas use JSON Schema draft-07; leave $schema out or set it to http://json-schema.org/draft-07/schema#");
  }
  return tx(ctx, () => {
    requireMember(ctx, actor, boardId, "owner");
    const id = schemaId(name, input.version);
    const existing = findSchema(ctx, boardId, name, input.version);
    if (existing) {
      if (canonical(existing.schema) === canonical(schema)) return { schema: present(existing), created: false };
      throw new OmbError("schema_immutable", `${id} is already registered with a different definition; register the next version instead`, { schema: id });
    }
    assertNoRegex(schema, "");
    try {
      engine(ctx).check(schema as Record<string, unknown>);
    } catch (e) {
      throw invalid(`Not a valid JSON Schema: ${(e as Error).message}`);
    }
    const now = nowIso(ctx);
    const description = input.description?.trim() || null;
    ctx.db
      .prepare("INSERT INTO data_schemas (board_id, name, version, description, definition, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(boardId, name, input.version, description, JSON.stringify(schema), actor.id, now);
    return { schema: present({ name, version: input.version, description, schema, builtin: false, created_at: now }), created: true };
  });
}

export interface BlockInput {
  schema: string;
  version: number;
  data: Record<string, unknown>;
}

/** Checks each block against its schema. Returns the blocks to store and their size in bytes. */
export function validateBlocks(ctx: AppContext, boardId: string, blocks: BlockInput[] | undefined): { blocks: Block[]; bytes: number } {
  if (!blocks || blocks.length === 0) return { blocks: [], bytes: 0 };
  if (blocks.length > MAX_BLOCKS_PER_MESSAGE) throw invalid(`Up to ${MAX_BLOCKS_PER_MESSAGE} blocks per message`);
  const out: Block[] = [];
  for (const [i, b] of blocks.entries()) {
    if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw invalid(`blocks.${i}.data must be an object`);
    const def = findSchema(ctx, boardId, b.schema, b.version);
    if (!def) throw notFound(schemaId(b.schema, b.version));
    const problems = validatorFor(ctx, boardId, def)(b.data);
    if (problems.length) {
      const issues = problems.slice(0, 10);
      throw new OmbError("invalid_block", `blocks.${i} doesn't match ${schemaId(def.name, def.version)}: ${issues.map((x) => `${x.path} ${x.message}`).join("; ")}`, {
        schema: schemaId(def.name, def.version),
        index: i,
        issues,
      });
    }
    out.push({ schema: def.name, version: def.version, data: b.data });
  }
  return { blocks: out, bytes: out.length ? Buffer.byteLength(JSON.stringify(out), "utf8") : 0 };
}
