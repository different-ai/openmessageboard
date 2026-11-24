/** live profile: subscriptions/listen. */
import type { Change } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef } from "../harness.ts";
import { sleep } from "../util.ts";
import { expiryScenario } from "./expiry.ts";
import { boardCursor, mayaOnOwnerBoard, readAll, reply, sharedThread, startThread } from "./helpers.ts";

export const liveCases: CaseDef[] = [
  {
    id: "live.listen-ack",
    profile: "live",
    title: "The listen acknowledgement includes only URIs the caller can read",
    async run(ctx) {
      const t = await sharedThread(ctx);
      const base = await ctx.resourceBase();
      const outsiderBoard = await ctx.boardOf("outsider");
      if (await ctx.isMember("maya", outsiderBoard)) ctx.skip("maya is a member of the outsider's board; use a fresh server");
      const readable = [`${base}/b/${t.boardId}`, `${base}/b/${t.boardId}/t/${t.threadId}`, `${base}/me/inbox`];
      const unreadable = [`${base}/b/${outsiderBoard}`, `${base}/b/b_unknown000000`, `https://elsewhere.invalid/b/${t.boardId}`];
      const l = await (await ctx.session("maya")).listen([...readable, ...unreadable]);
      try {
        const ack = new Set(l.acknowledged);
        for (const u of readable) check(ack.has(u), `the acknowledgement omits a readable URI: ${u}`);
        for (const u of unreadable) check(!ack.has(u), `the acknowledgement includes a URI the caller cannot read: ${u}`);
      } finally {
        await l.close();
      }
    },
  },
  {
    id: "live.listen-updates",
    profile: "live",
    title: "A post produces notifications/resources/updated for the board, thread and inbox URIs",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const base = await ctx.resourceBase();
      const t = await startThread(owner, board, `Listen ${ctx.runId}`, "Watching this thread.");
      const boardUri = `${base}/b/${board}`;
      const threadUri = `${base}/b/${board}/t/${t.thread.id}`;
      const inboxUri = `${base}/me/inbox`;
      const l = await maya.listen([boardUri, threadUri, inboxUri]);
      try {
        const since = Date.now();
        await reply(owner, t.thread.id, "A reply to notice.");
        check(await l.waitForUpdate((u) => u === threadUri, 5000, since), "no update for the thread URI within 5 s of a reply");
        check(await l.waitForUpdate((u) => u === boardUri, 5000, since), "no update for the board URI within 5 s of a reply");
        const since2 = Date.now();
        await reply(owner, t.thread.id, "Mentioning you.", { mentions: [mayaId] });
        check(await l.waitForUpdate((u) => u === inboxUri, 5000, since2), "no update for the inbox URI within 5 s of a mention");
        check(l.updates.every((u) => [boardUri, threadUri, inboxUri].includes(u.uri)), `updates arrived for URIs that were not acknowledged: ${l.updates.map((u) => u.uri).join(", ")}`);
        check(!l.closedCause, `the listen stream closed unexpectedly (${l.closedCause})`);
      } finally {
        await l.close();
      }
    },
  },
  {
    id: "live.reconnect-catch-up",
    profile: "live",
    title: "Reconnect with catch-up: two missed replies and one posted during reconnect arrive once each, in order",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const base = await ctx.resourceBase();
      const boardUri = `${base}/b/${board}`;
      const t = await startThread(owner, board, `Reconnect ${ctx.runId}`, "Catch-up test.");
      let cursor = await boardCursor(maya, board);
      const missed1 = (await reply(owner, t.thread.id, "missed reply 1")).message.id;
      const missed2 = (await reply(owner, t.thread.id, "missed reply 2")).message.id;
      const seen = new Map<number, Change>();
      const order: string[] = [];
      let duplicates = 0;
      const apply = (changes: Change[]) => {
        for (const c of changes) {
          if (seen.has(c.seq)) {
            duplicates++;
            continue;
          }
          seen.set(c.seq, c);
          if (c.thread_id === t.thread.id && c.type === "message.created" && c.message) order.push(c.message.id);
        }
      };
      // Step 1: open the live channel first.
      const l = await maya.listen([boardUri]);
      try {
        const since = Date.now();
        const duringPost = reply(owner, t.thread.id, "posted during reconnect");
        // Step 2: catch up.
        let r = await readAll(maya, board, cursor);
        apply(r.changes);
        cursor = r.cursor;
        const during = (await duringPost).message.id;
        // Step 3: on a hint, read again.
        let viaHint = false;
        if (!order.includes(during)) {
          const hint = await l.waitForUpdate((u) => u === boardUri, 8000, since);
          if (!hint) throw new Failure("the reply posted during reconnect was not in the catch-up and no update notification arrived for it");
          viaHint = true;
          for (let i = 0; i < 5 && !order.includes(during); i++) {
            r = await readAll(maya, board, cursor);
            apply(r.changes);
            cursor = r.cursor;
            if (!order.includes(during)) await sleep(300);
          }
        }
        check(duplicates === 0, `get_changes returned ${duplicates} change(s) twice across reads`);
        check(JSON.stringify(order) === JSON.stringify([missed1, missed2, during]), `expected replies [missed 1, missed 2, during] once each, got ${JSON.stringify(order)}`);
        ctx.note(viaHint ? "the reply posted during reconnect arrived through an update hint" : "the reply posted during reconnect was already in the catch-up read");
      } finally {
        await l.close();
      }
    },
  },
  {
    id: "live.access-ends",
    profile: "live",
    title: "When access ends, listen delivery stops, the stream closes gracefully, and reads return access_ended",
    timeoutMs: 150_000,
    async run(ctx) {
      const f = await expiryScenario(ctx);
      for (const n of f.notes) ctx.note(n);
      const problems = [...f.common, ...f.live];
      if (problems.length) throw new Failure(problems.join("; "));
    },
  },
  {
    id: "live.removal",
    profile: "live",
    title: "Removing a member ends their listen stream within 5 s and removes their agents",
    async run(ctx) {
      ctx.skip("removing a member is a web-only owner action in v0.1; there is no MCP path to trigger it");
    },
  },
];
