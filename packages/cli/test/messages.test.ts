import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Change, Message } from "@openmessageboard/sdk";
import { parseCommandLine, UsageError } from "../src/args.ts";
import { formatChange, formatMessage } from "../src/format.ts";

const NOW = new Date("2026-11-23T12:00:00Z");
const maya = { id: "p_maya", kind: "human" as const, display_name: "Maya", via: null };

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m_1",
    board_id: "b_1",
    thread_id: "t_1",
    author: maya,
    body: "Deployed.",
    deleted: false,
    reply_to: null,
    mentions: [],
    source: null,
    created_at: "2026-11-23T11:55:00Z",
    revision: 1,
    edited_at: null,
    labels: {},
    reactions: [],
    blocks: [],
    attachments: [],
    ...over,
  };
}

describe("message commands", () => {
  it("parses edit, react, download and label with conditions", () => {
    const e = parseCommandLine(["edit", "m_1", "fixed typo", "--if-revision", "2"]);
    assert.equal(e.command, "edit");
    assert.deepEqual(e.positionals, ["m_1", "fixed typo"]);
    assert.equal(e.values["if-revision"], "2");
    const r = parseCommandLine(["react", "m_1", "eyes", "--remove"]);
    assert.deepEqual([r.command, r.positionals, r.values.remove], ["react", ["m_1", "eyes"], true]);
    const d = parseCommandLine(["download", "a_1", "-"]);
    assert.deepEqual([d.command, d.positionals], ["download", ["a_1", "-"]]);
    const l = parseCommandLine(["label", "m_1", "state=fixed", "--unset", "wip", "--if", "state=open", "--if-unset", "owner"]);
    assert.equal(l.command, "label");
    assert.deepEqual(l.values.unset, ["wip"]);
    assert.deepEqual(l.values.if, ["state=open"]);
    assert.deepEqual(l.values["if-unset"], ["owner"]);
  });

  it("parses post and reply with attachments, schema and after", () => {
    const p = parseCommandLine(["post", "Deploy", '{"id":"d1","state":"ready"}', "--schema", "deployment@1", "--attach", "a.txt", "--attach", "b.png"]);
    assert.equal(p.values.schema, "deployment@1");
    assert.deepEqual(p.values.attach, ["a.txt", "b.png"]);
    const r = parseCommandLine(["reply", "t_1", "on it", "--after", "m_9"]);
    assert.equal(r.values.after, "m_9");
  });

  it("schemas lists by default and has inspect and create", () => {
    assert.equal(parseCommandLine(["schemas"]).command, "schemas list");
    const withBoard = parseCommandLine(["schemas", "b_1"]);
    assert.deepEqual([withBoard.command, withBoard.positionals], ["schemas list", ["b_1"]]);
    assert.deepEqual(parseCommandLine(["schemas", "inspect", "git-commit@1"]).positionals, ["git-commit@1"]);
    const c = parseCommandLine(["schemas", "create", "sandbox@1", "--file", "-", "--description", "What a sandbox did."]);
    assert.deepEqual([c.command, c.values.file, c.values.description], ["schemas create", "-", "What a sandbox did."]);
    assert.throws(() => parseCommandLine(["react", "m_1", "eyes", "--bogus"]), UsageError);
  });

  it("formats a message with its edit, labels, data, files and reactions", () => {
    const text = formatMessage(
      message({
        revision: 2,
        edited_at: "2026-11-23T11:58:00Z",
        labels: { state: "open" },
        blocks: [{ schema: "git-commit", version: 1, data: { sha: "abcdef1" } }],
        attachments: [{ id: "a_1", name: "trace.txt", type: "text/plain", size: 12 }],
        reactions: [{ emoji: "eyes", count: 2, me: true }],
      }),
      NOW,
    );
    assert.match(text, /edited \(revision 2\)/);
    assert.match(text, /labels: state=open/);
    assert.match(text, /git-commit@1: \{"sha":"abcdef1"\}/);
    assert.match(text, /file: trace.txt \(text\/plain, 12 bytes\) a_1/);
    assert.match(text, /reactions: eyes 2 \(you\)/);
  });

  it("formats edit, reaction and label changes for tail", () => {
    const base = { seq: 1, board_id: "b_1", thread_id: "t_1", message_id: "m_1", actor: maya, created_at: "2026-11-23T11:59:00Z", thread: null, member: null };
    const m = message({ labels: { state: "done" }, reactions: [{ emoji: "tada", count: 1, me: false }] });
    assert.match(formatChange({ ...base, type: "message.edited", message: m } as Change, NOW), /^~ message m_1 in t_1 edited by Maya/);
    assert.equal(formatChange({ ...base, type: "reactions.changed", message: m } as Change, NOW), "~ reactions on m_1 by Maya (tada 1)");
    assert.equal(formatChange({ ...base, type: "labels.changed", message: m } as Change, NOW), "~ labels on m_1 by Maya [state=done]");
  });
});
