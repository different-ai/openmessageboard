/**
 * Checks that:
 *  1. schemas/v0.1/** and the generated spec tables match the protocol package;
 *  2. every sample in schemas/v0.1/samples/valid passes, and every sample in
 *     samples/invalid fails, both the zod schema and the generated JSON Schema;
 *  3. every worked exchange in spec/v0.1/examples/*.json conforms to the schemas.
 *
 * Run from the repository root:
 *   conformance/node_modules/.bin/tsx --conditions=source schemas/check.ts
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import * as P from "@openmessageboard/protocol";
import { z } from "zod";
import { entryByRef, generatedFiles, schemaEntries, ToolError } from "./build.ts";
import { EXAMPLES_DIR, GENERATED_DIRS, REPO_ROOT, SAMPLES_DIR, SCHEMAS_DIR, SPEC_DIR } from "./paths.ts";
import { applyTables, SPEC_TABLES } from "./spec-tables.ts";
import { strictCheck } from "./strict.ts";

const failures: string[] = [];
let checks = 0;
const fail = (where: string, msg: string): void => {
  failures.push(`${where}: ${msg}`);
};
const rel = (p: string) => relative(REPO_ROOT, p);

// ---------------------------------------------------------------- 1. freshness
function checkFreshness(): void {
  const files = generatedFiles();
  for (const [file, contents] of files) {
    checks++;
    const path = join(SCHEMAS_DIR, file);
    if (!existsSync(path)) fail(rel(path), "missing; run schemas/generate.ts");
    else if (readFileSync(path, "utf8") !== contents) fail(rel(path), "stale; run schemas/generate.ts");
  }
  for (const dir of GENERATED_DIRS) {
    const full = join(SCHEMAS_DIR, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith(".json") && !files.has(`${dir}/${name}`)) fail(rel(join(full, name)), "not produced by the generator");
    }
  }
  const expected = new Map<string, string[]>();
  for (const [name, t] of Object.entries(SPEC_TABLES)) expected.set(t.file, [...(expected.get(t.file) ?? []), name]);
  for (const [file, names] of expected) {
    checks++;
    const path = join(SPEC_DIR, file);
    if (!existsSync(path)) {
      fail(rel(path), "missing");
      continue;
    }
    const text = readFileSync(path, "utf8");
    const out = applyTables(file, text);
    for (const n of names) if (!out.found.includes(n)) fail(rel(path), `generated table "${n}" markers not found`);
    if (out.text !== text) fail(rel(path), "generated tables are stale; run schemas/generate.ts");
  }
}

// ---------------------------------------------------------------- 2. samples
const ajv = new AjvJsonSchemaValidator();
const jsonValidators = new Map<string, (v: unknown) => { valid: boolean; errorMessage?: string }>();
function jsonSchemaCheck(ref: string, value: unknown): string | null {
  let v = jsonValidators.get(ref);
  if (!v) {
    const entry = entryByRef(ref);
    if (!entry) return `unknown schema ref ${ref}`;
    const doc = JSON.parse(readFileSync(join(SCHEMAS_DIR, entry.file), "utf8")) as Record<string, unknown>;
    delete doc.$id;
    v = ajv.getValidator(doc as never);
    jsonValidators.set(ref, v);
  }
  const r = v(value);
  return r.valid ? null : (r.errorMessage ?? "invalid");
}

function zodFor(ref: string): z.ZodType | undefined {
  return entryByRef(ref)?.schema;
}

function checkSamples(): void {
  for (const kind of ["valid", "invalid"] as const) {
    const dir = join(SAMPLES_DIR, kind);
    if (!existsSync(dir)) {
      fail(rel(dir), "missing samples directory");
      continue;
    }
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      checks++;
      const path = join(dir, name);
      const where = rel(path);
      let sample: { schema?: string; description?: string; instance?: unknown };
      try {
        sample = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        fail(where, `not JSON: ${(e as Error).message}`);
        continue;
      }
      if (!sample.schema || !("instance" in sample) || !sample.description) {
        fail(where, 'sample must have "schema", "description" and "instance"');
        continue;
      }
      const schema = zodFor(sample.schema);
      if (!schema) {
        fail(where, `unknown schema ref ${sample.schema}`);
        continue;
      }
      const zodIssues = strictCheck(schema, sample.instance);
      const jsonIssue = jsonSchemaCheck(sample.schema, sample.instance);
      if (kind === "valid") {
        if (zodIssues.length) fail(where, `zod rejected a valid sample: ${zodIssues.join("; ")}`);
        if (jsonIssue) fail(where, `JSON Schema rejected a valid sample: ${jsonIssue}`);
      } else {
        if (schema.safeParse(sample.instance).success) fail(where, "zod accepted an invalid sample");
        if (!jsonIssue) fail(where, "JSON Schema accepted an invalid sample");
      }
    }
  }
}

// ---------------------------------------------------------------- 3. examples
interface Step {
  principal?: string;
  send?: Record<string, unknown>;
  receive?: Record<string, unknown>;
  note?: string;
  http?: { request: { method: string; url: string; headers?: Record<string, string>; body?: unknown }; response: { status: number; headers?: Record<string, string>; body?: unknown } };
  schema?: string;
  webhook?: boolean;
}
interface Example {
  title?: string;
  summary?: string;
  profiles?: string[];
  sections?: string[];
  base_url?: string;
  webhook_secret?: string;
  steps?: Step[];
}

const PV = "io.modelcontextprotocol/protocolVersion";
const SUB = "io.modelcontextprotocol/subscriptionId";

function verifySignature(secret: string, headers: Record<string, string>, body: unknown): string | null {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sig = headers["webhook-signature"];
  if (!id || !ts || !sig) return "webhook-id, webhook-timestamp and webhook-signature are required";
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return `webhook-id "${id}" uses characters outside [A-Za-z0-9_-]`;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${JSON.stringify(body)}`).digest();
  const ok = sig.split(" ").some((part) => {
    const [v, b64] = part.split(",");
    if (v !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return ok ? null : "webhook-signature does not verify against webhook_secret";
}

function checkExample(path: string): void {
  checks++;
  const where = rel(path);
  let ex: Example;
  try {
    ex = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(where, `not JSON: ${(e as Error).message}`);
    return;
  }
  if (!ex.title || !ex.summary || !Array.isArray(ex.steps) || !ex.base_url || !Array.isArray(ex.profiles)) {
    fail(where, 'example needs "title", "summary", "profiles", "base_url" and "steps"');
    return;
  }
  for (const p of ex.profiles) if (!(P.PROFILES as readonly string[]).includes(p)) fail(where, `unknown profile ${p}`);
  for (const s of ex.sections ?? []) {
    const file = s.split("#")[0]!;
    if (!existsSync(join(SPEC_DIR, file))) fail(where, `section reference ${s} names a missing file`);
  }
  const base = ex.base_url;
  const requests = new Map<string, { method: string; params: Record<string, unknown> }>();
  ex.steps.forEach((step, i) => {
    const at = `${where} step ${i + 1}`;
    const key = (id: unknown) => `${step.principal ?? "?"}:${JSON.stringify(id)}`;
    if (step.send) {
      const m = step.send;
      if (m.jsonrpc !== "2.0") fail(at, 'send must be JSON-RPC 2.0 ("jsonrpc": "2.0")');
      const method = m.method as string | undefined;
      const params = (m.params ?? {}) as Record<string, unknown>;
      if (!method) return fail(at, "send has no method");
      if ("id" in m) {
        requests.set(key(m.id), { method, params });
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        if (meta[PV] !== P.MCP_PROTOCOL_VERSION) fail(at, `requests carry _meta["${PV}"] = "${P.MCP_PROTOCOL_VERSION}"`);
      }
      if (method === "tools/call") {
        const name = params.name as P.ToolName;
        if (!P.TOOL_NAMES.includes(name)) return fail(at, `unknown tool ${String(name)}`);
        for (const issue of strictCheck(P.TOOLS[name].input, params.arguments ?? {})) fail(at, `${name} arguments ${issue}`);
      }
      if (method === "events/poll" || method === "events/subscribe" || method === "events/unsubscribe") {
        const name = params.name as P.EventName;
        if (!P.EVENT_NAMES.includes(name)) return fail(at, `unknown event ${String(name)}`);
        for (const issue of strictCheck(P.EVENT_DEFINITIONS[name].arguments, params.arguments ?? {})) fail(at, `${name} arguments ${issue}`);
        if (method === "events/subscribe") {
          const d = params.delivery as { mode?: string; url?: string; secret?: string } | undefined;
          if (d?.mode !== "webhook" || !d.url || !/^whsec_/.test(d.secret ?? "")) fail(at, "events/subscribe needs delivery {mode: webhook, url, secret: whsec_...}");
        }
      }
      if (method === "subscriptions/listen") {
        const uris = ((params.notifications as { resourceSubscriptions?: unknown[] } | undefined)?.resourceSubscriptions ?? []) as unknown[];
        for (const u of uris) if (typeof u !== "string") fail(at, "resourceSubscriptions must be strings");
      }
    }
    if (step.receive) {
      const m = step.receive;
      if (m.jsonrpc !== "2.0") fail(at, 'receive must be JSON-RPC 2.0 ("jsonrpc": "2.0")');
      if (typeof m.method === "string") {
        const params = (m.params ?? {}) as Record<string, unknown>;
        if (m.method === "notifications/resources/updated") {
          if (!P.parseResourceUri(base, String(params.uri))) fail(at, `updated URI ${String(params.uri)} is not a board, thread or inbox URI under ${base}`);
          if (!(params._meta as Record<string, unknown> | undefined)?.[SUB]) fail(at, "listen notifications carry the subscription id in _meta");
        }
        if (m.method === "notifications/subscriptions/acknowledged") {
          const subId = (params._meta as Record<string, unknown> | undefined)?.[SUB];
          const req = requests.get(key(subId));
          if (!req || req.method !== "subscriptions/listen") fail(at, "acknowledgement must reference a subscriptions/listen request id");
          else {
            const asked = new Set(((req.params.notifications as { resourceSubscriptions?: string[] }).resourceSubscriptions ?? []) as string[]);
            const got = ((params.notifications as { resourceSubscriptions?: string[] } | undefined)?.resourceSubscriptions ?? []) as string[];
            for (const u of got) if (!asked.has(u)) fail(at, `acknowledged URI ${u} was not requested`);
          }
        }
        return;
      }
      const req = requests.get(key(m.id));
      if (!req) return fail(at, `response id ${JSON.stringify(m.id)} matches no earlier request from ${step.principal}`);
      if (m.error) {
        const e = m.error as { code?: unknown; message?: unknown };
        if (typeof e.code !== "number" || typeof e.message !== "string") fail(at, "JSON-RPC error needs numeric code and message");
        return;
      }
      const result = (m.result ?? {}) as Record<string, unknown>;
      if (result.resultType !== "complete") fail(at, 'results carry resultType: "complete"');
      if (req.method === "tools/call") {
        const name = req.params.name as P.ToolName;
        if (!Array.isArray(result.content) || !(result.content as { type?: string }[]).some((c) => c.type === "text")) fail(at, "tool results include a text content block");
        if (result.isError === true) {
          for (const issue of strictCheck(ToolError, result.structuredContent)) fail(at, `${name} error ${issue}`);
        } else {
          for (const issue of strictCheck(P.TOOLS[name].output, result.structuredContent)) fail(at, `${name} output ${issue}`);
        }
      }
      if (req.method === "events/list") {
        const names = ((result.events ?? []) as { name: string }[]).map((e) => e.name).sort();
        if (JSON.stringify(names) !== JSON.stringify([...P.EVENT_NAMES].sort())) fail(at, `events/list must list exactly ${P.EVENT_NAMES.join(", ")}`);
      }
      if (req.method === "events/poll") {
        const name = req.params.name as P.EventName;
        for (const occ of (result.events ?? []) as { name: string; eventId: string; data: unknown; timestamp: string }[]) {
          if (occ.name !== name) fail(at, `occurrence name ${occ.name} differs from polled ${name}`);
          if (!occ.eventId || !occ.timestamp) fail(at, "occurrences carry eventId and timestamp");
          for (const issue of strictCheck(P.EVENT_DEFINITIONS[name].payload, occ.data)) fail(at, `${name} data ${issue}`);
        }
        if (!("cursor" in result) || typeof result.truncated !== "boolean" || typeof result.hasMore !== "boolean") fail(at, "poll results carry cursor, truncated and hasMore");
      }
      if (req.method === "resources/read") {
        const contents = (result.contents ?? []) as { text?: string; mimeType?: string }[];
        for (const c of contents) {
          try {
            JSON.parse(c.text ?? "");
          } catch {
            fail(at, "resource contents are JSON text");
          }
        }
        if (typeof result.ttlMs !== "number" || result.cacheScope !== "private") fail(at, 'resources/read results carry ttlMs and cacheScope: "private"');
      }
    }
    if (step.http) {
      const { request, response } = step.http;
      if (step.schema) {
        const schema = zodFor(step.schema);
        if (!schema) fail(at, `unknown schema ref ${step.schema}`);
        else for (const issue of strictCheck(schema, response.body)) fail(at, `${step.schema} ${issue}`);
      }
      if (step.webhook) {
        const body = request.body as Record<string, unknown>;
        const headers = request.headers ?? {};
        if (!ex.webhook_secret) fail(at, "webhook steps need webhook_secret on the example");
        else {
          const err = verifySignature(ex.webhook_secret, headers, body);
          if (err) fail(at, err);
        }
        if (!headers["x-mcp-subscription-id"]) fail(at, "webhook requests carry X-MCP-Subscription-Id");
        if (body.type === "verification") {
          if ((response.body as { challenge?: unknown } | undefined)?.challenge !== body.challenge) fail(at, "verification response echoes the challenge");
        } else if (body.type === "terminated") {
          const e = body.error as { code?: unknown } | undefined;
          if (typeof e?.code !== "number") fail(at, "terminated envelope carries error.code");
        } else {
          const name = body.name as P.EventName;
          if (!P.EVENT_NAMES.includes(name)) fail(at, `unknown event ${String(name)}`);
          else for (const issue of strictCheck(P.EVENT_DEFINITIONS[name].payload, body.data)) fail(at, `${name} data ${issue}`);
          if (headers["webhook-id"] !== body.eventId) fail(at, "webhook-id equals the occurrence eventId");
        }
      }
    }
  });
}

function checkExamples(): void {
  if (!existsSync(EXAMPLES_DIR)) return fail(rel(EXAMPLES_DIR), "missing examples directory");
  const names = readdirSync(EXAMPLES_DIR).filter((n) => n.endsWith(".json")).sort();
  if (!names.length) fail(rel(EXAMPLES_DIR), "no examples");
  for (const n of names) checkExample(join(EXAMPLES_DIR, n));
}

export function main(): number {
  // Every schema entry must convert; generatedFiles() throws otherwise.
  checks += schemaEntries().length;
  checkFreshness();
  checkSamples();
  checkExamples();
  if (failures.length) {
    console.error(`schema check: ${failures.length} problem(s) in ${checks} checks`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log(`schema check: ${checks} checks passed (schemas fresh, samples and spec examples conform)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
