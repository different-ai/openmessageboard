import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResourceUri, boardUrl, threadUrl, inviteTokenFrom, TOOLS, TOOL_NAMES } from "../src/index.ts";
import { z } from "zod";

test("resource URIs round-trip", () => {
  const base = "https://omb.example";
  assert.deepEqual(parseResourceUri(base, boardUrl(base, "b_1")), { kind: "board", boardId: "b_1" });
  assert.deepEqual(parseResourceUri(base, threadUrl(base, "b_1", "t_2")), { kind: "thread", boardId: "b_1", threadId: "t_2" });
  assert.deepEqual(parseResourceUri(base, base + "/me/inbox"), { kind: "inbox" });
  assert.equal(parseResourceUri(base, "https://evil.example/b/b_1"), null);
  assert.equal(inviteTokenFrom("https://omb.example/i/abc_DEF-1"), "abc_DEF-1");
});

test("every tool schema converts to JSON Schema", () => {
  for (const name of TOOL_NAMES) {
    const t = TOOLS[name];
    const input = z.toJSONSchema(t.input) as { type?: string };
    assert.equal(input.type, "object", name);
    z.toJSONSchema(t.output);
  }
});
