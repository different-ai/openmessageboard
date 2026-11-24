import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { OmbClient, OmbError } from "../src/index.ts";
import { FakeServer } from "./fake-server.ts";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: Buffer;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("upload() and download() over the web API", () => {
  const seen: Seen[] = [];
  let url = "";
  const server = createServer(async (req, res) => {
    const b = await body(req);
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, type: req.headers["content-type"], body: b });
    if (req.method === "POST" && req.url?.startsWith("/api/boards/b_1/attachments")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ attachment: { id: "a_1", name: "trace.txt", type: "text/plain", size: b.byteLength } }));
    } else if (req.method === "GET" && req.url === "/api/attachments/a_1") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": `attachment; filename="r_sum_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt` });
      res.end("hello");
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "Attachment not found" } }));
    }
  });
  let client: OmbClient;
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new OmbClient({ server: url, token: "tok" });
  });
  after(async () => {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("uploads the raw bytes with the name, media type and bearer token", async () => {
    const a = await client.upload("b_1", { data: new TextEncoder().encode("line 1\n"), name: "trace.txt", type: "text/plain" });
    assert.deepEqual(a, { id: "a_1", name: "trace.txt", type: "text/plain", size: 7 });
    const req = seen.at(-1)!;
    assert.equal(req.url, "/api/boards/b_1/attachments?name=trace.txt");
    assert.equal(req.auth, "Bearer tok");
    assert.equal(req.type, "text/plain");
    assert.equal(req.body.toString(), "line 1\n");
  });

  it("refuses files over 4 MiB before sending them", async () => {
    await assert.rejects(client.upload("b_1", { data: new Uint8Array(4 * 1024 * 1024 + 1), name: "big.bin" }), (e: unknown) => e instanceof OmbError && e.code === "attachment_too_large");
  });

  it("downloads with the UTF-8 file name and type, and maps web API errors", async () => {
    const file = await client.download("a_1");
    assert.equal(file.name, "résumé.txt");
    assert.equal(file.type, "text/plain");
    assert.equal(Buffer.from(file.data).toString(), "hello");
    await assert.rejects(client.download("a_missing"), (e: unknown) => e instanceof OmbError && e.code === "not_found");
  });
});

describe("typed methods for message features", () => {
  let fake: FakeServer;
  let client: OmbClient;
  before(async () => {
    fake = await new FakeServer().start();
    client = new OmbClient({ server: fake.url, token: "good-token" });
  });
  after(async () => {
    await client.close();
    await fake.stop();
  });

  it("calls edit_message, react and label_message with their arguments", async () => {
    const { message: m } = fake.addThread("Status", undefined, "step 1");
    fake.tools.edit_message = (args) => ({ message: { ...m, body: args.body, revision: 2, edited_at: new Date().toISOString() } });
    fake.tools.react = () => ({ message: { ...m, reactions: [{ emoji: "eyes", count: 1, me: true }] } });
    fake.tools.label_message = (args) => ({ message: { ...m, labels: args.set } });
    assert.equal((await client.editMessage({ message_id: m.id, body: "step 2", revision: 1 })).message.revision, 2);
    assert.deepEqual(fake.calls.at(-1)?.args, { message_id: m.id, body: "step 2", revision: 1 });
    assert.equal((await client.react({ message_id: m.id, emoji: "eyes" })).message.reactions[0]?.emoji, "eyes");
    assert.deepEqual((await client.labelMessage({ message_id: m.id, set: { state: "open" }, if: { state: null } })).message.labels, { state: "open" });
    assert.deepEqual(fake.calls.at(-1)?.args, { message_id: m.id, set: { state: "open" }, if: { state: null } });
  });
});
