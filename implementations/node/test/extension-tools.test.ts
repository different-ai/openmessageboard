import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOL_NAMES } from "@openmessageboard/protocol";
import type { ExtensionModule } from "@openmessageboard/core";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { createScopedToken } from "@openmessageboard/core/domain/tokens";
import { actorFromPrincipal } from "@openmessageboard/core/domain/access";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { freePort } from "./helpers.ts";

// An extension's MCP tools (spec README §Extensions): listed after the specification's, and run under the same
// rules: sign-in, structured argument errors, token scopes.
const calls: string[] = [];
const example: ExtensionModule = {
  id: "test.example/echo",
  info: { version: "0.1.0", description: "Echo tools" },
  register() {},
  tools: (z) => [
    { name: "echo_read", description: "Returns its text.", input: z.object({ text: z.string() }), scope: "read", readOnly: true, handler: (_ctx, actor, args) => ({ text: args.text, by: actor.displayName }) },
    { name: "echo_manage", description: "Records its text.", input: z.object({ text: z.string() }), scope: "manage", readOnly: false, handler: (_ctx, _actor, args) => (calls.push(String(args.text)), { ok: true }) },
  ],
};

let running: Running;
let base: string;
let token: string;
let readOnlyToken: string;

before(async () => {
  const port = await freePort();
  const config = loadConfig({ OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-ext-tools-")), OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: { extensions: [example] } });
  base = config.publicUrl;
  const maya = ensureHuman(running.ctx, { email: "maya@example.test", displayName: "Maya" });
  token = mintToken(running.ctx, maya.id, "test").token;
  readOnlyToken = createScopedToken(running.ctx, actorFromPrincipal(maya, "personal_token"), { can: ["read"] }).token;
});
after(() => running.stop());

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "ext-tools", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}
type Result = { isError?: boolean; structuredContent?: Record<string, unknown> & { error?: { code: string } } };

test("extension tools are listed after every tool of the specification", async () => {
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.slice(0, TOOL_NAMES.length), [...TOOL_NAMES]);
  assert.deepEqual(names.slice(TOOL_NAMES.length), ["echo_read", "echo_manage"]);
  await client.close();
});

test("an extension tool runs as the caller, and a bad argument is a structured invalid_argument", async () => {
  const client = await connect(token);
  const good = (await client.callTool({ name: "echo_read", arguments: { text: "hello" } })) as Result;
  assert.deepEqual(good.structuredContent, { text: "hello", by: "Maya" });
  const bad = (await client.callTool({ name: "echo_read", arguments: { text: 7 } })) as Result;
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent?.error?.code, "invalid_argument");
  await client.close();
});

test("a scoped token calls only the extension tools its permissions allow", async () => {
  const client = await connect(readOnlyToken);
  assert.equal(((await client.callTool({ name: "echo_read", arguments: { text: "hi" } })) as Result).isError, undefined);
  const refused = (await client.callTool({ name: "echo_manage", arguments: { text: "nope" } })) as Result;
  assert.equal(refused.structuredContent?.error?.code, "forbidden");
  assert.deepEqual(calls, []);
  await client.close();
});

test("an extension can't take a specification tool's name", async () => {
  const port = await freePort();
  const config = loadConfig({ OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-ext-tools-")), OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  const clash: ExtensionModule = { ...example, tools: (z) => [{ name: "whoami", description: "x", input: z.object({}), scope: "read", readOnly: true, handler: () => ({}) }] };
  const server = await startServer(config, { features: { extensions: [clash] } });
  try {
    const bearer = mintToken(server.ctx, ensureHuman(server.ctx, { email: "a@example.test" }).id, "test").token;
    const res = await fetch(`${config.publicUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
  } finally {
    await server.stop();
  }
});
