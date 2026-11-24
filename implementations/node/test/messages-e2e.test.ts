import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOLS } from "@openmessageboard/protocol";
import { loadConfig } from "../src/config.ts";
import { startServer, type Running } from "../src/main.ts";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { freePort } from "./helpers.ts";

let running: Running;
let base: string;
const tokens: Record<string, string> = {};

before(async () => {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "omb-msg-e2e-"));
  const config = loadConfig({ OMB_DATA_DIR: dir, OMB_PORT: String(port), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${port}` });
  running = await startServer(config, { features: {} });
  base = config.publicUrl;
  for (const [name, email] of [["owner", "owner@example.test"], ["maya", "maya@example.test"], ["outsider", "out@elsewhere.test"]] as const) {
    tokens[name] = mintToken(running.ctx, ensureHuman(running.ctx, { email, displayName: name }).id, "test").token;
  }
});

after(async () => {
  await running.stop();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call<T = Record<string, unknown>>(client: Client, name: keyof typeof TOOLS, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown };
  if (r.isError) throw Object.assign(new Error(JSON.stringify(r.structuredContent)), { body: r.structuredContent });
  const parsed = TOOLS[name].output.safeParse(r.structuredContent);
  assert.ok(parsed.success, `${name} output matches the protocol: ${JSON.stringify(parsed.error?.issues ?? [])}`);
  return r.structuredContent as T;
}

async function fails(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: { error?: { code?: string } } };
  assert.equal(r.isError, true, `${name} should fail`);
  return r.structuredContent?.error?.code ?? "";
}

const auth = (name: string) => ({ Authorization: `Bearer ${tokens[name]}` });

test("message features over MCP and the web API: upload, attach, download, edit, react, label", async () => {
  const owner = await connect(tokens.owner!);
  const maya = await connect(tokens.maya!);
  const outsider = await connect(tokens.outsider!);
  const boardId = (await call<{ owned_board: { id: string } }>(owner, "whoami")).owned_board.id;
  const inv = await call<{ invite: { url: string } }>(owner, "create_invite", { board_id: boardId, audience: "email", value: "maya@example.test", role: "contributor" });
  await call(maya, "redeem_invite", { invite: inv.invite.url });

  // Upload over MCP (base64) and over the web API (raw body and multipart).
  const mcpFile = await call<{ attachment: { id: string; size: number } }>(maya, "upload_attachment", {
    board_id: boardId,
    name: "notes.md",
    type: "text/markdown",
    data_base64: Buffer.from("# notes\n").toString("base64"),
  });
  assert.equal(mcpFile.attachment.size, 8);
  assert.equal(await fails(maya, "upload_attachment", { board_id: boardId, name: "x", data_base64: "not base64!" }), "invalid_argument");
  const raw = await fetch(`${base}/api/boards/${boardId}/attachments?name=page.html`, { method: "POST", headers: { ...auth("maya"), "content-type": "text/html" }, body: "<script>alert(1)</script>" });
  assert.equal(raw.status, 200);
  const rawFile = ((await raw.json()) as { attachment: { id: string; type: string } }).attachment;
  assert.equal(rawFile.type, "text/html");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }), "bytes.bin");
  const multi = await fetch(`${base}/api/boards/${boardId}/attachments`, { method: "POST", headers: auth("maya"), body: form });
  assert.equal(multi.status, 200);
  const multiFile = ((await multi.json()) as { attachment: { id: string; name: string; size: number } }).attachment;
  assert.deepEqual([multiFile.name, multiFile.size], ["bytes.bin", 3]);
  const tooBig = await fetch(`${base}/api/boards/${boardId}/attachments?name=big.bin`, { method: "POST", headers: auth("maya"), body: new Uint8Array(4 * 1024 * 1024 + 1) });
  assert.equal(tooBig.status, 413);
  assert.equal(((await tooBig.json()) as { error: { code: string } }).error.code, "attachment_too_large");

  const started = await call<{ thread: { id: string }; message: { id: string; attachments: { id: string }[]; revision: number } }>(maya, "start_thread", {
    board_id: boardId,
    title: "Files",
    body: "see files, cc @owner",
    attachments: [mcpFile.attachment.id, rawFile.id, multiFile.id],
    blocks: [{ schema: "git-commit", version: 1, data: { sha: "abcdef1" } }],
    idempotency_key: "files-1",
  });
  assert.deepEqual(started.message.attachments.map((a) => a.id), [mcpFile.attachment.id, rawFile.id, multiFile.id]);

  // Downloads are files to save: attachment disposition, nosniff, sandboxed, members only.
  const dl = await fetch(`${base}/api/attachments/${rawFile.id}`, { headers: auth("owner") });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") ?? "", /^attachment; filename="page.html"/);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.match(dl.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(await dl.text(), "<script>alert(1)</script>");
  assert.equal((await fetch(`${base}/api/attachments/${rawFile.id}`, { headers: auth("outsider") })).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/${rawFile.id}`)).status, 401);
  const got = await call<{ data_base64: string | null; url: string }>(owner, "get_attachment", { attachment_id: mcpFile.attachment.id });
  assert.equal(Buffer.from(got.data_base64!, "base64").toString(), "# notes\n");
  assert.equal(await fails(outsider, "get_attachment", { attachment_id: mcpFile.attachment.id }), "not_found");

  // Edit, react and label over MCP.
  const edited = await call<{ message: { revision: number } }>(maya, "edit_message", { message_id: started.message.id, body: "see the files", revision: 1 });
  assert.equal(edited.message.revision, 2);
  assert.equal(await fails(maya, "edit_message", { message_id: started.message.id, body: "x", revision: 1 }), "revision_conflict");
  const reacted = await call<{ message: { reactions: { emoji: string; count: number; me: boolean }[] } }>(owner, "react", { message_id: started.message.id, emoji: "🎉" });
  assert.deepEqual(reacted.message.reactions, [{ emoji: "tada", count: 1, me: true }]);
  await call(owner, "label_message", { message_id: started.message.id, set: { state: "open" } });
  assert.equal(await fails(owner, "label_message", { message_id: started.message.id, set: { state: "done" }, if: { state: "closed" } }), "label_conflict");
  const filtered = await call<{ threads: { id: string; labels: Record<string, string> }[] }>(maya, "list_threads", { board_id: boardId, labels: { state: "open" } });
  assert.deepEqual(filtered.threads.map((t) => t.labels), [{ state: "open" }]);

  // Web API routes for the same actions.
  const patch = await fetch(`${base}/api/messages/${started.message.id}`, { method: "PATCH", headers: { ...auth("maya"), "content-type": "application/json" }, body: JSON.stringify({ body: "final", revision: 1 }) });
  assert.equal(patch.status, 409);
  const schemas = (await (await fetch(`${base}/api/boards/${boardId}/schemas`, { headers: auth("maya") })).json()) as { schemas: { id: string }[] };
  assert.ok(schemas.schemas.some((s) => s.id === "deployment@1"));

  // Deleting the message frees the files; the uploader's links stop working too.
  await call(maya, "delete_message", { message_id: started.message.id });
  assert.equal((await fetch(`${base}/api/attachments/${rawFile.id}`, { headers: auth("maya") })).status, 404);
  for (const c of [owner, maya, outsider]) await c.close();
});
