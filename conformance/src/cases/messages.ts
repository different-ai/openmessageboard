/** Message features: edit, reactions, labels on messages, mentions in text, reply-after, structured data, attachments. */
import type { Message } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { httpRequest } from "../http.ts";
import type { McpSession } from "../mcp.ts";
import { newKey } from "../util.ts";
import { assertNoLeak, boardCursor, mayaOnOwnerBoard, quotaReaderOnOwnerBoard, readAll, reply, startThread } from "./helpers.ts";

const MESSAGE_FIELDS = ["revision", "edited_at", "labels", "reactions", "blocks", "attachments"] as const;

async function messageIn(s: McpSession, threadId: string, messageId: string): Promise<Message> {
  const r = await s.ok("get_thread", { thread_id: threadId, limit: 200 });
  const m = r.messages.find((x) => x.id === messageId);
  if (!m) throw new Failure(`get_thread ${threadId} does not include message ${messageId}`);
  return m;
}

const ids = async (ctx: Ctx) => ({ owner: (await ctx.me("owner")).id, maya: (await ctx.me("maya")).id });

export const messageCases: CaseDef[] = [
  {
    id: "core.message-edit",
    profile: "core",
    title: "edit_message: author only, revision checks, edited_at, message.edited, tombstones refuse",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const t = await startThread(maya, board, `Edit ${ctx.runId}`, "step 1 of 3");
      for (const f of MESSAGE_FIELDS) check(f in t.message, `Message has ${f} (03 §Messages)`);
      check(t.message.revision === 1 && t.message.edited_at === null, "a new message is at revision 1 with edited_at null");
      const c0 = await boardCursor(owner, board);
      const e = await maya.ok("edit_message", { message_id: t.message.id, body: "step 2 of 3", revision: 1 });
      check(e.message.body === "step 2 of 3" && e.message.revision > 1 && e.message.edited_at !== null, "an edit replaces the body, changes revision and sets edited_at");
      const conflict = await maya.fails("edit_message", { message_id: t.message.id, body: "stale", revision: 1 }, "revision_conflict");
      check((conflict.details as { revision?: unknown } | undefined)?.revision === e.message.revision, "revision_conflict reports the current revision in details.revision");
      await owner.fails("edit_message", { message_id: t.message.id, body: "not mine" }, "forbidden");
      const outsider = await ctx.session("outsider");
      await outsider.fails("edit_message", { message_id: t.message.id, body: "x" }, "not_found");
      const read = await messageIn(owner, t.thread.id, t.message.id);
      check(read.body === "step 2 of 3" && read.revision === e.message.revision, "get_thread shows the edited body and revision");
      const { changes } = await readAll(owner, board, c0);
      const edits = changes.filter((c) => c.type === "message.edited" && c.message_id === t.message.id);
      check(edits.length === 1, `expected one message.edited change, got ${edits.length}`);
      const same = await maya.ok("edit_message", { message_id: t.message.id, body: "step 2 of 3" });
      check(same.message.revision === e.message.revision, "writing the same body again changes nothing");
      const del = await maya.ok("delete_message", { message_id: t.message.id });
      check(del.message.revision > e.message.revision, "deleting changes the revision");
      await maya.fails("edit_message", { message_id: t.message.id, body: "back" }, "message_deleted");
    },
  },
  {
    id: "core.reactions",
    profile: "core",
    title: "react: short names, colons and emoji are one reaction; counts, me, readers, reactions.changed",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      await quotaReaderOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const reader = await ctx.session("quota");
      const t = await startThread(owner, board, `Reactions ${ctx.runId}`, "Ship it?");
      const c0 = await boardCursor(owner, board);
      await maya.ok("react", { message_id: t.message.id, emoji: "+1" });
      await reader.ok("react", { message_id: t.message.id, emoji: "👍" });
      const r = await owner.ok("react", { message_id: t.message.id, emoji: ":thumbs_up:" });
      const up = r.message.reactions.find((x) => x.emoji === "thumbs_up");
      check(up && up.count === 3 && up.me === true, `expected thumbs_up x3 with me: true, got ${JSON.stringify(r.message.reactions)}`);
      check(r.message.revision === t.message.revision, "reactions leave the revision as it is");
      const again = await owner.ok("react", { message_id: t.message.id, emoji: "thumbs_up" });
      check(again.message.reactions.find((x) => x.emoji === "thumbs_up")?.count === 3, "reacting twice with one emoji counts once");
      const asMaya = await messageIn(maya, t.thread.id, t.message.id);
      check(asMaya.reactions.find((x) => x.emoji === "thumbs_up")?.me === true, "me is computed for the reader");
      const removed = await maya.ok("react", { message_id: t.message.id, emoji: "thumbs_up", remove: true });
      check(removed.message.reactions.find((x) => x.emoji === "thumbs_up")?.count === 2, "remove: true takes the caller's reaction away");
      await maya.fails("react", { message_id: t.message.id, emoji: "not an emoji!" }, "invalid_argument");
      const { changes } = await readAll(owner, board, c0);
      const rx = changes.filter((c) => c.type === "reactions.changed" && c.message_id === t.message.id);
      check(rx.length === 4, `expected 4 reactions.changed changes (3 adds, 1 remove; the repeat emits nothing), got ${rx.length}`);
      await owner.ok("delete_message", { message_id: t.message.id });
      check((await messageIn(owner, t.thread.id, t.message.id)).reactions.length === 0, "a tombstone has no reactions");
      await maya.fails("react", { message_id: t.message.id, emoji: "eyes" }, "message_deleted");
    },
  },
  {
    id: "tasks.message-labels",
    profile: "tasks",
    title: "label_message: conditions, reserved keys, root labels are thread labels, filters match message or root",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      await quotaReaderOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const reader = await ctx.session("quota");
      const run = { run: ctx.runId };
      const t = await startThread(owner, board, `Labels ${ctx.runId}`, "checkout times out", { labels: { ...run, kind: "bug" } });
      check(t.message.labels.kind === "bug" && t.message.labels.run === ctx.runId, "the root message carries the thread's labels");
      const r1 = await reply(maya, t.thread.id, "fix in review");
      const c0 = await boardCursor(owner, board);
      const l1 = await maya.ok("label_message", { message_id: r1.message.id, set: { state: "review" } });
      check(l1.message.labels.state === "review", "label_message sets labels on a reply");
      check(l1.message.revision === r1.message.revision, "labels leave the revision as it is");
      const conflict = await maya.fails("label_message", { message_id: r1.message.id, set: { state: "fixing" }, if: { state: "open" } }, "label_conflict");
      check((conflict.details as { key?: unknown } | undefined)?.key === "state", "label_conflict names the key in details.key");
      assertNoLeak(conflict, ["review"], "label_conflict");
      await maya.fails("label_message", { message_id: r1.message.id, set: { owner: "fx" }, if: { state: null } }, "label_conflict");
      await maya.ok("label_message", { message_id: r1.message.id, set: { state: "fixing" }, unset: ["missing"], if: { state: "review", owner: null } });
      await maya.fails("label_message", { message_id: r1.message.id, set: { "board.task": "x" } }, "reserved_label");
      await maya.fails("set_labels", { thread_id: t.thread.id, set: { "board.x": "y" } }, "reserved_label");
      await reader.fails("label_message", { message_id: r1.message.id, set: { a: "b" } }, "forbidden");

      const { changes } = await readAll(owner, board, c0);
      check(changes.filter((c) => c.type === "labels.changed" && c.message_id === r1.message.id).length === 2, "each label change on a message emits labels.changed");
      check(!changes.some((c) => c.type === "thread.updated" && c.thread_id === t.thread.id), "a reply's labels don't change the thread");

      const c1 = await boardCursor(owner, board);
      await maya.ok("label_message", { message_id: t.message.id, set: { area: "web" } });
      const thread = (await owner.ok("get_thread", { thread_id: t.thread.id, limit: 1 })).thread;
      check(thread.labels.area === "web" && thread.labels.kind === "bug", "labeling the root changes the thread's labels");
      const types = (await readAll(owner, board, c1)).changes.filter((c) => c.thread_id === t.thread.id).map((c) => c.type);
      check(types.includes("labels.changed") && types.includes("thread.updated"), `a root label change emits labels.changed and thread.updated, got ${types.join(", ")}`);
      await owner.ok("set_labels", { thread_id: t.thread.id, remove: ["area"] });
      check((await messageIn(owner, t.thread.id, t.message.id)).labels.area === undefined, "set_labels changes the root message's labels");

      const listed = async (labels: Record<string, string>) => (await owner.ok("list_threads", { board_id: board, labels: { ...run, ...labels } })).threads.map((x) => x.id);
      check((await listed({ kind: "bug" })).includes(t.thread.id), "list_threads matches the root's labels");
      check((await listed({ state: "fixing" })).includes(t.thread.id), "list_threads matches a reply's labels (with the root's)");
      check(!(await listed({ state: "review" })).includes(t.thread.id), "list_threads uses current labels");
      const found = await owner.ok("search_messages", { board_id: board, query: "review", labels: { ...run, state: "fixing" } });
      check(found.results.some((x) => x.message.id === r1.message.id), "search_messages filters by labels on the message or its root");
      const page = await owner.ok("get_changes", { board_id: board, cursor: c0, labels: { ...run } });
      check("changes" in page && page.changes.length > 0 && page.changes.every((c) => c.thread_id === t.thread.id), "get_changes with labels returns only changes on matching messages");
      await owner.fails("get_changes", { inbox: true, labels: run }, "invalid_argument");

      await maya.ok("delete_message", { message_id: r1.message.id });
      check(!(await listed({ state: "fixing" })).includes(t.thread.id), "a deleted message loses its labels");
      await maya.fails("label_message", { message_id: r1.message.id, set: { a: "b" } }, "message_deleted");
    },
  },
  {
    id: "core.mentions-in-text",
    profile: "core",
    title: "@handles and @[principal-id] in bodies mention members; code and unknown handles stay text",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const who = await ids(ctx);
      const members = (await owner.ok("list_members", { board_id: board })).members;
      const handle = members.find((m) => m.principal.id === who.maya)?.handle;
      check(handle, "list_members gives maya a handle");
      const body = `@${handle} can you look? cc @nobody-${ctx.runId} and \`@${handle}\` in code, and @[${who.owner}]`;
      const t = await startThread(owner, board, `Mentions in text ${ctx.runId}`, body);
      const res = t.mentions_resolved ?? [];
      const byWritten = new Map(res.map((m) => [m.written.toLowerCase(), m]));
      check(byWritten.get(`@${handle}`.toLowerCase())?.principal?.id === who.maya, `@${handle} resolves to maya: ${JSON.stringify(res)}`);
      check(byWritten.get(`@nobody-${ctx.runId}`)?.principal === null, "a handle that matches no one stays text (principal: null)");
      check(byWritten.get(`@[${who.owner}]`.toLowerCase())?.principal?.id === who.owner, "@[principal-id] resolves");
      check(res.length === 3, `mentions inside code are ignored; got ${res.map((m) => m.written).join(", ")}`);
      check(t.message.mentions.some((m) => m.id === who.maya), "the resolved mention is stored on the message");
      const inbox = await maya.ok("get_inbox", { unread_only: true });
      check(inbox.items.some((i) => i.kind === "mention" && i.message?.id === t.message.id), "a mention written in the body creates a mention inbox item");
      const plain = await reply(owner, t.thread.id, "no mentions here");
      check(plain.mentions_resolved === undefined || plain.mentions_resolved.length === 0, "a body without mentions has no mentions_resolved entries");
    },
  },
  {
    id: "core.reply-after",
    profile: "core",
    title: "reply with after succeeds only while that message is the thread's newest",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const t = await startThread(owner, board, `Reply after ${ctx.runId}`, "who answers first?");
      const first = await maya.ok("reply", { thread_id: t.thread.id, body: "me", after: t.message.id, idempotency_key: newKey() });
      const late = await owner.fails("reply", { thread_id: t.thread.id, body: "late", after: t.message.id, idempotency_key: newKey() }, "newer_message");
      check((late.details as { newest_message_id?: unknown } | undefined)?.newest_message_id === first.message.id, "newer_message names the newest message in details.newest_message_id");
      await owner.ok("reply", { thread_id: t.thread.id, body: "after you", after: first.message.id, idempotency_key: newKey() });
      const other = await startThread(owner, board, `Reply after elsewhere ${ctx.runId}`, "x");
      await owner.fails("reply", { thread_id: t.thread.id, body: "x", after: other.message.id, idempotency_key: newKey() }, "invalid_argument");
    },
  },
  {
    id: "core.structured-data",
    profile: "core",
    title: "Schemas: built-ins, owner registration, immutable versions; blocks are validated on write",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const listed = (await maya.ok("list_schemas", { board_id: board })).schemas.map((s) => s.id);
      check(listed.includes("git-commit@1") && listed.includes("deployment@1"), `built-in schemas git-commit@1 and deployment@1 are listed: ${listed.join(", ")}`);
      const name = `conf-${ctx.runId}`;
      const def = { type: "object", required: ["id", "action"], properties: { id: { type: "string" }, action: { enum: ["started", "stopped"] } }, additionalProperties: false };
      await maya.fails("register_schema", { board_id: board, name, version: 1, schema: def }, "forbidden");
      const created = await owner.ok("register_schema", { board_id: board, name, version: 1, schema: def, description: "Conformance schema" });
      check(created.created === true && created.schema.id === `${name}@1`, "register_schema creates name@version");
      check((await owner.ok("register_schema", { board_id: board, name, version: 1, schema: def })).created === false, "registering the same definition again is a no-op");
      await owner.fails("register_schema", { board_id: board, name, version: 1, schema: { ...def, required: ["id"] } }, "schema_immutable");
      const got = await maya.ok("get_schema", { board_id: board, schema: `${name}@1` });
      check(got.schema.description === "Conformance schema" && got.schema.builtin === false, "get_schema returns the registered schema");
      await maya.fails("get_schema", { board_id: board, schema: `${name}@2` }, "schema_not_found");

      const t = await maya.ok("start_thread", {
        board_id: board,
        title: `Structured ${ctx.runId}`,
        body: "sandbox started",
        blocks: [
          { schema: name, version: 1, data: { id: "sbx-1", action: "started" } },
          { schema: "git-commit", version: 1, data: { sha: "a1b2c3d" } },
        ],
        idempotency_key: newKey(),
      });
      check(t.message.blocks.length === 2 && t.message.blocks[0]!.schema === name && t.message.blocks[0]!.version === 1, "blocks come back as written");
      const bad = await maya.fails("reply", { thread_id: t.thread.id, body: "x", blocks: [{ schema: name, version: 1, data: { id: "sbx-1", action: "exploded" } }], idempotency_key: newKey() }, "invalid_block");
      check((bad.details as { schema?: unknown } | undefined)?.schema === `${name}@1`, "invalid_block names the schema in details.schema");
      await maya.fails("reply", { thread_id: t.thread.id, body: "x", blocks: [{ schema: `missing-${ctx.runId}`, version: 1, data: {} }], idempotency_key: newKey() }, "schema_not_found");
      const read = await messageIn(owner, t.thread.id, t.message.id);
      check(JSON.stringify(read.blocks) === JSON.stringify(t.message.blocks), "get_thread returns the blocks");
    },
  },
  {
    id: "core.attachments",
    profile: "core",
    title: "Attachments: upload, attach, who can read, downloads are files, delete frees them",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const outsider = await ctx.session("outsider");
      const content = `trace for run ${ctx.runId}\n`;
      const up = await maya.ok("upload_attachment", { board_id: board, name: "trace.txt", type: "text/plain", data_base64: Buffer.from(content).toString("base64") });
      check(up.attachment.name === "trace.txt" && up.attachment.size === Buffer.byteLength(content), "upload_attachment returns {id, name, type, size}");
      await owner.fails("get_attachment", { attachment_id: up.attachment.id }, "not_found");
      await owner.fails("start_thread", { board_id: board, title: "x", body: "y", attachments: [up.attachment.id], idempotency_key: newKey() }, "invalid_argument");
      const t = await maya.ok("start_thread", { board_id: board, title: `Files ${ctx.runId}`, body: "see the trace", attachments: [up.attachment.id], idempotency_key: newKey() });
      check(t.message.attachments.length === 1 && t.message.attachments[0]!.id === up.attachment.id, "the message lists its attachment");
      const got = await owner.ok("get_attachment", { attachment_id: up.attachment.id });
      check(got.data_base64 !== null && Buffer.from(got.data_base64, "base64").toString() === content, "get_attachment returns a small file's contents");
      await outsider.fails("get_attachment", { attachment_id: up.attachment.id }, "not_found");

      const dl = await httpRequest(got.url, { headers: { Authorization: `Bearer ${ctx.token("owner")}` } });
      check(dl.status === 200 && dl.text === content, `the download URL serves the file (HTTP ${dl.status})`);
      check(/^attachment/i.test(dl.headers.get("content-disposition") ?? ""), "downloads carry Content-Disposition: attachment (10 §Web clients)");
      check((dl.headers.get("x-content-type-options") ?? "").toLowerCase() === "nosniff", "downloads carry X-Content-Type-Options: nosniff");
      const anon = await httpRequest(got.url);
      check(anon.status === 401 || anon.status === 404, `the download URL needs authentication (got HTTP ${anon.status})`);
      const asOutsider = await httpRequest(got.url, { headers: { Authorization: `Bearer ${ctx.token("outsider")}` } });
      check(asOutsider.status === 404, `a non-member can't download (got HTTP ${asOutsider.status})`);

      const big = await maya.callRaw("upload_attachment", { board_id: board, name: "big.bin", data_base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") });
      check(!big.ok && big.error.code === "attachment_too_large", `a file over 4 MiB fails with attachment_too_large (got ${big.ok ? "success" : big.error.code})`);

      await maya.ok("delete_message", { message_id: t.message.id });
      check((await messageIn(owner, t.thread.id, t.message.id)).attachments.length === 0, "a tombstone has no attachments");
      await owner.fails("get_attachment", { attachment_id: up.attachment.id }, "not_found");
      await maya.fails("get_attachment", { attachment_id: up.attachment.id }, "not_found");
    },
  },
];
