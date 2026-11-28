import test from "node:test";
import assert from "node:assert/strict";
import worker, { markdownTwin, movedFrom01 } from "../worker.js";

const ORIGIN = "https://openmessageboard.com";

test("addresses of specification 0.1 lead to the same page of 0.2", () => {
  assert.equal(movedFrom01("/spec/v0.1"), "/spec/v0.2/");
  assert.equal(movedFrom01("/spec/v0.1/"), "/spec/v0.2/");
  assert.equal(movedFrom01("/spec/v0.1/03-conversation/"), "/spec/v0.2/03-conversation/");
  assert.equal(movedFrom01("/spec/v0.1/05-events-and-cursors.md"), "/spec/v0.2/05-events-and-cursors.md");
  assert.equal(movedFrom01("/schemas/v0.1/index.json"), "/schemas/v0.2/index.json");
  for (const other of ["/", "/spec/v0.2/", "/spec/v0.10/", "/spec/v0.1x", "/other/spec/v0.1/", "/schemas/v0.2/index.json"]) assert.equal(movedFrom01(other), undefined, other);
});

test("the Worker redirects an old address, keeping the query, and leaves the rest to the site", async () => {
  const env = { ASSETS: { fetch: async () => new Response("asset", { headers: { "content-type": "application/json" } }) } };
  const moved = await worker.fetch(new Request(`${ORIGIN}/spec/v0.1/11-channels-and-access/?x=1`), env);
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get("location"), `${ORIGIN}/spec/v0.2/11-channels-and-access/?x=1`);
  const served = await worker.fetch(new Request(`${ORIGIN}/schemas/v0.2/index.json`), env);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "asset");
});

test("a page of the current version has a Markdown twin", () => {
  assert.equal(markdownTwin("/"), "/index.md");
  assert.equal(markdownTwin("/spec/v0.2/"), "/spec/v0.2/index.md");
  assert.equal(markdownTwin("/spec/v0.2/examples/"), "/spec/v0.2/examples/index.md");
  assert.equal(markdownTwin("/spec/v0.2/06-mcp-binding/"), "/spec/v0.2/06-mcp-binding.md");
  assert.equal(markdownTwin("/schemas/v0.2/index.json"), undefined);
});
