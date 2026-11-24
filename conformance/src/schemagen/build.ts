/**
 * Builds the JSON Schema 2020-12 documents in `schemas/v0.1/` from the normative
 * zod schemas in `@openmessageboard/protocol`. Shared by `schemas/generate.ts`,
 * `schemas/check.ts` and the conformance runner (which compares a server's
 * `tools/list` against the same source).
 */
import { z } from "zod";
import * as P from "@openmessageboard/protocol";

export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export const SCHEMA_ID_PREFIX = `urn:openmessageboard:schemas:v${P.SPEC_VERSION}:`;

/** Error body carried in `structuredContent.error` (MCP) and `error` (reference web API). */
export const ErrorBody = z.object({
  code: z.enum(P.ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/** `structuredContent` of a tool result with `isError: true`. */
export const ToolError = z.object({ error: ErrorBody });

export interface SchemaEntry {
  /** Stable reference such as `tools/reply.input` or `entities/Thread`. */
  ref: string;
  /** Path relative to `schemas/v0.1/`. */
  file: string;
  title: string;
  description?: string;
  io: "input" | "output";
  schema: z.ZodType;
}

const ENTITY_NAMES = [
  "PrincipalRef",
  "Principal",
  "BoardSettings",
  "Board",
  "Membership",
  "Member",
  "Labels",
  "TaskInfo",
  "ExternalLink",
  "Thread",
  "MessageSource",
  "Message",
  "InboxItem",
  "Invite",
  "InvitePreview",
  "AllowanceUsage",
  "Usage",
  "Change",
  "ChangesPage",
  "InboxChangesPage",
  "Agent",
  "ServerInfo",
  "MessageFilter",
  "Schedule",
  "WatcherFilter",
  "WatcherDelivery",
  "Watcher",
] as const;

export function schemaEntries(): SchemaEntry[] {
  const entries: SchemaEntry[] = [];
  for (const name of P.TOOL_NAMES) {
    const tool = P.TOOLS[name];
    entries.push({
      ref: `tools/${name}.input`,
      file: `tools/${name}.input.json`,
      title: `${name} input`,
      description: tool.description,
      io: "input",
      schema: tool.input,
    });
    entries.push({
      ref: `tools/${name}.output`,
      file: `tools/${name}.output.json`,
      title: `${name} output (structuredContent)`,
      io: "output",
      schema: tool.output,
    });
  }
  const entities = P as unknown as Record<string, z.ZodType>;
  for (const name of ENTITY_NAMES) {
    const schema = entities[name];
    if (!schema) throw new Error(`protocol does not export entity ${name}`);
    entries.push({ ref: `entities/${name}`, file: `entities/${name}.json`, title: name, io: "output", schema });
  }
  for (const name of P.EVENT_NAMES) {
    const def = P.EVENT_DEFINITIONS[name];
    entries.push({
      ref: `events/${name}.arguments`,
      file: `events/${name}.arguments.json`,
      title: `${name} subscription arguments`,
      description: def.description,
      io: "input",
      schema: def.arguments,
    });
    entries.push({
      ref: `events/${name}.payload`,
      file: `events/${name}.payload.json`,
      title: `${name} occurrence data`,
      description: def.description,
      io: "output",
      schema: def.payload,
    });
  }
  entries.push({
    ref: "export",
    file: "export.json",
    title: P.EXPORT_FORMAT,
    description: "Board export file. Contains no emails, tokens, invites, follows or read state.",
    io: "output",
    schema: P.ExportFile,
  });
  entries.push({ ref: "errors/ErrorBody", file: "errors/ErrorBody.json", title: "ErrorBody", io: "output", schema: ErrorBody });
  entries.push({
    ref: "errors/ToolError",
    file: "errors/ToolError.json",
    title: "Tool error structuredContent",
    description: "structuredContent of a tool result with isError: true",
    io: "output",
    schema: ToolError,
  });
  return entries;
}

export function entryByRef(ref: string): SchemaEntry | undefined {
  return schemaEntries().find((e) => e.ref === ref);
}

/** Converts one entry to a JSON Schema document with a stable `$id`. */
export function toJsonSchema(entry: SchemaEntry): Record<string, unknown> {
  const generated = z.toJSONSchema(entry.schema, {
    target: "draft-2020-12",
    io: entry.io,
    unrepresentable: "throw",
  }) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = generated;
  // Union outputs (get_changes, wait_for_activity) get a top-level "type": "object" so the
  // document can be used directly as an MCP outputSchema, which must describe an object.
  const branches = rest.anyOf as { type?: unknown }[] | undefined;
  if (!rest.type && Array.isArray(branches) && branches.every((b) => b.type === "object")) rest.type = "object";
  const doc: Record<string, unknown> = {
    $schema: SCHEMA_DIALECT,
    $id: SCHEMA_ID_PREFIX + entry.ref,
    title: entry.title,
  };
  if (entry.description) doc.description = entry.description;
  return { ...doc, ...rest };
}

/** Every generated file (path relative to `schemas/v0.1/`) with its serialized contents. */
export function generatedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const index: Record<string, string> = {};
  for (const entry of schemaEntries()) {
    files.set(entry.file, JSON.stringify(toJsonSchema(entry), null, 2) + "\n");
    index[entry.ref] = entry.file;
  }
  files.set(
    "index.json",
    JSON.stringify(
      {
        spec_version: P.SPEC_VERSION,
        mcp_protocol_version: P.MCP_PROTOCOL_VERSION,
        export_format: P.EXPORT_FORMAT,
        tools: P.TOOL_NAMES,
        events: P.EVENT_NAMES,
        error_codes: P.ERROR_CODES,
        schemas: index,
      },
      null,
      2,
    ) + "\n",
  );
  return files;
}

/** Minimal "same shape" projection used to compare a server's advertised schema with ours. */
export function schemaShape(schema: unknown): { properties: string[]; required: string[] } {
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    properties: Object.keys(s.properties ?? {}).sort(),
    required: [...(s.required ?? [])].sort(),
  };
}
