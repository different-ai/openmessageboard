/** core: channels, named boards and per-channel access (grants). */
import { DEFAULT_CHANNEL } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { boardCursor, inboxCursor, mayaOnOwnerBoard, readAll, readInbox, reasonOf, startThread } from "./helpers.ts";

/** A channel path unique to this run, so reruns against one server don't collide. */
const runChannel = (ctx: Ctx, name: string) => `conf-${ctx.runId}-${name}`;

export const channelCases: CaseDef[] = [
  {
    id: "core.channels-first-post",
    profile: "core",
    title: "A thread lands in general by default; the first post in a new channel creates it",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const plain = await startThread(maya, board, `Channels ${ctx.runId}: default`, "No channel given.");
      check(plain.thread.channel === DEFAULT_CHANNEL, `a thread without a channel is in "${plain.thread.channel}", expected "${DEFAULT_CHANNEL}"`);
      const path = `${runChannel(ctx, "dev")}/alerts`;
      const before = (await maya.ok("list_channels", { board_id: board })).channels;
      check(!before.some((c) => c.path === path), "the channel exists before its first post");
      const r = await maya.ok("start_thread", { board_id: board, channel: path, title: `Channels ${ctx.runId}: first post`, body: "This creates the channel.", idempotency_key: `ch-${ctx.runId}-1` });
      check(r.thread.channel === path, `start_thread returned channel "${r.thread.channel}", expected "${path}"`);
      const after = (await maya.ok("list_channels", { board_id: board })).channels;
      const ch = after.find((c) => c.path === path);
      check(ch, "list_channels does not show the channel the first post created");
      check(ch.thread_count === 1, `thread_count is ${ch.thread_count}, expected 1`);
      check(ch.last_activity_at !== null && !ch.private, "a new public channel has activity and is not private");
      check(ch.my_permissions.includes("read") && ch.my_permissions.includes("post"), `a contributor's my_permissions are ${ch.my_permissions.join(",")}`);
      const got = await maya.ok("get_thread", { thread_id: r.thread.id });
      check(got.thread.channel === path, "get_thread reports the thread's channel");
      for (const bad of ["Dev", "dev//x", "/dev", "a b", "x".repeat(41)]) {
        await maya.fails("start_thread", { board_id: board, channel: bad, title: "bad", body: "bad", idempotency_key: `ch-bad-${ctx.runId}-${bad.length}` }, "invalid_argument");
      }
      const empty = await maya.ok("create_channel", { board_id: board, path: runChannel(ctx, "empty") });
      check(empty.created && empty.channel.thread_count === 0 && empty.channel.last_activity_at === null, "create_channel makes an empty channel");
      const again = await maya.ok("create_channel", { board_id: board, path: runChannel(ctx, "empty") });
      check(!again.created, "create_channel on an existing channel returns created: false");
    },
  },
  {
    id: "core.channels-subtree",
    profile: "core",
    title: "A channel filter with a trailing slash covers the channel and every channel under it",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const root = runChannel(ctx, "www");
      const cursor = await boardCursor(maya, board);
      const prod = await maya.ok("start_thread", { board_id: board, channel: `${root}/production`, title: "prod", body: "deploy failed", idempotency_key: `sub-${ctx.runId}-1` });
      const prev = await maya.ok("start_thread", { board_id: board, channel: `${root}/preview`, title: "preview", body: "preview slow", idempotency_key: `sub-${ctx.runId}-2` });
      const top = await maya.ok("start_thread", { board_id: board, channel: root, title: "top", body: "the channel itself", idempotency_key: `sub-${ctx.runId}-3` });
      const near = await maya.ok("start_thread", { board_id: board, channel: `${root}x`, title: "near", body: "same prefix, other channel", idempotency_key: `sub-${ctx.runId}-4` });
      const listed = new Set((await maya.ok("list_threads", { board_id: board, channel: `${root}/`, limit: 100 })).threads.map((t) => t.id));
      for (const t of [prod, prev, top]) check(listed.has(t.thread.id), `list_threads channel "${root}/" omits ${t.thread.channel}`);
      check(!listed.has(near.thread.id), `list_threads channel "${root}/" includes ${root}x, which is not under it`);
      const exact = (await maya.ok("list_threads", { board_id: board, channel: `${root}/production` })).threads;
      check(exact.length === 1 && exact[0]!.id === prod.thread.id, "an exact channel filter returns only that channel's threads");
      const { changes } = await readAll(maya, board, cursor);
      check(changes.length >= 4, "get_changes without a channel returns every new thread");
      const page = await maya.ok("get_changes", { board_id: board, cursor, channel: `${root}/` });
      if (!("changes" in page)) throw new Failure("get_changes with board_id returned an inbox page");
      const ids = new Set(page.changes.map((c) => c.thread_id));
      check(ids.has(prod.thread.id) && ids.has(prev.thread.id) && ids.has(top.thread.id), "get_changes with a subtree filter omits a change in the subtree");
      check(!ids.has(near.thread.id), "get_changes with a subtree filter includes a change outside it");
      check(page.changes.every((c) => c.thread_id !== null), "get_changes with a channel filter returns only thread changes");
      const channels = (await maya.ok("list_channels", { board_id: board })).channels.map((c) => c.path);
      for (const p of [root, `${root}/production`, `${root}/preview`, `${root}x`]) check(channels.includes(p), `list_channels omits ${p}`);
    },
  },
  {
    id: "core.private-channel",
    profile: "core",
    title: "A private channel hides its threads from members who weren't granted it: reads, changes, search, inbox and listen",
    timeoutMs: 180_000,
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const path = runChannel(ctx, "sec");
      const made = await owner.ok("create_channel", { board_id: board, path, private: true });
      check(made.created && made.channel.private, "create_channel with private: true returns a private channel");
      check(made.grants.length === 2, `a private channel is made with 2 grants, got ${made.grants.length}`);
      const opening = made.grants.find((g) => g.principals.some((p) => p.kind === "member"));
      const closing = made.grants.find((g) => g.principals.some((p) => p.kind === "everyone"));
      check(opening && closing, "the grants open the channel to its creator and close it to everyone");
      try {
        const dup = await owner.fails("create_channel", { board_id: board, path, private: true }, "conflict");
        check(reasonOf(dup) === "channel_exists", `making an existing channel private fails with reason ${reasonOf(dup)}, expected channel_exists`);
        await maya.fails("create_channel", { board_id: board, path: runChannel(ctx, "maya-private"), private: true }, "forbidden");

        const boardC = await boardCursor(maya, board);
        const inboxC = await inboxCursor(maya);
        const base = await ctx.resourceBase();
        const boardUri = `${base}/b/${board}`;
        const live = ctx.claims("live") ? await maya.listen([boardUri]) : null;
        try {
          const since = Date.now();
          const secret = await owner.ok("start_thread", {
            board_id: board,
            channel: `${path}/incidents`,
            title: `Secret ${ctx.runId}`,
            body: `Rotate the key ${ctx.runId}zz`,
            mentions: [mayaId],
            idempotency_key: `priv-${ctx.runId}-1`,
          });
          if (live) {
            const leaked = await live.waitForUpdate((u) => u === boardUri, 1500, since);
            check(!leaked, "listen announced a change in a channel the listener can't read");
          }
          await maya.fails("get_thread", { thread_id: secret.thread.id }, "not_found");
          await maya.fails("reply", { thread_id: secret.thread.id, body: "hi", idempotency_key: `priv-${ctx.runId}-2` }, "not_found");
          const listed = (await maya.ok("list_threads", { board_id: board, limit: 100 })).threads;
          check(!listed.some((t) => t.id === secret.thread.id), "list_threads shows a thread in a channel the caller can't read");
          check(!(await maya.ok("list_channels", { board_id: board })).channels.some((c) => c.path === path), "list_channels shows a channel the caller can't read");
          const { changes } = await readAll(maya, board, boardC);
          check(!changes.some((c) => c.thread_id === secret.thread.id), "get_changes returns a change from a channel the caller can't read");
          const hits = (await maya.ok("search_messages", { board_id: board, query: `${ctx.runId}zz` })).results;
          check(hits.length === 0, "search_messages finds a message in a channel the caller can't read");
          const { items } = await readInbox(maya, inboxC);
          check(!items.some((i) => i.thread_id === secret.thread.id), "the inbox (get_changes inbox) has an item from a channel the caller can't read");
          const inbox = await maya.ok("get_inbox", { limit: 100 });
          check(!inbox.items.some((i) => i.thread_id === secret.thread.id), "get_inbox shows an item from a channel the caller can't read");
          await maya.fails("start_thread", { board_id: board, channel: path, title: "sneak", body: "sneak", idempotency_key: `priv-${ctx.runId}-3` }, "forbidden");
          const ownerView = await owner.ok("get_thread", { thread_id: secret.thread.id });
          check(ownerView.thread.channel === `${path}/incidents`, "the channel's creator reads the thread");

          if (live) {
            const since2 = Date.now();
            await startThread(owner, board, `Public ${ctx.runId}`, "Everyone sees this.");
            check(await live.waitForUpdate((u) => u === boardUri, 5000, since2), "listen stopped announcing changes the listener can read");
          }
          // Let Maya in through the creator's grant: the thread becomes readable.
          await owner.ok("update_grant", { grant_id: opening.id, add: [{ kind: "member", principal_id: mayaId }] });
          const nowReadable = await maya.ok("get_thread", { thread_id: secret.thread.id });
          check(nowReadable.thread.id === secret.thread.id, "adding a member to the private channel's grant lets them read it");
        } finally {
          await live?.close();
        }
      } finally {
        // Leave the board as it was for later cases.
        await owner.call("revoke_grant", { grant_id: closing!.id });
        await owner.call("revoke_grant", { grant_id: opening!.id });
      }
    },
  },
  {
    id: "core.grants-explain",
    profile: "core",
    title: "Grants decide per channel (most specific pattern, closest principal), the role caps them, and explain_access says why",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const ownerId = (await ctx.me("owner")).id;
      const path = runChannel(ctx, "docs");
      const fresh = await maya.ok("explain_access", { board_id: board, channel: `${path}/a` });
      check(fresh.principal.id === mayaId && fresh.role === "contributor", "explain_access without principal_id explains the caller's own access");
      check(fresh.pattern === null && fresh.grant_ids.length === 0, "with no grant reaching a channel, explain_access reports pattern: null");
      check(fresh.can.includes("read") && fresh.can.includes("post") && !fresh.can.includes("manage"), `a contributor's default permissions are ${fresh.can.join(",")}`);
      await maya.fails("explain_access", { board_id: board, channel: path, principal_id: ownerId }, "forbidden");
      const readOnly = await owner.ok("create_grant", { board_id: board, principals: [{ kind: "member", principal_id: mayaId }], can: { [`${path}/`]: ["read"] } });
      const closed = await owner.ok("create_grant", { board_id: board, principals: [{ kind: "everyone" }], can: { [`${path}/`]: "none", [`${path}/open`]: ["read", "post"] } });
      try {
        check(readOnly.grant.can[`${path}/`]?.join(",") === "read", "create_grant normalizes can to a list of permissions");
        check(closed.grant.can[`${path}/`]?.length === 0, "'none' normalizes to an empty list");
        await maya.fails("start_thread", { board_id: board, channel: `${path}/a`, title: "x", body: "x", idempotency_key: `gx-${ctx.runId}-1` }, "forbidden");
        const e = await owner.ok("explain_access", { board_id: board, channel: `${path}/a`, principal_id: mayaId });
        check(e.pattern === `${path}/` && e.level === "member", `the member grant decides over everyone at the same pattern (got ${e.pattern}, ${e.level})`);
        check(e.can.join(",") === "read" && e.grant_ids.includes(readOnly.grant.id), `explain_access reports can ${e.can.join(",")}, expected read`);
        // A more specific pattern decides first, even for a farther principal.
        const open = await maya.ok("start_thread", { board_id: board, channel: `${path}/open`, title: "open", body: "the exact channel is open", idempotency_key: `gx-${ctx.runId}-2` });
        check(open.thread.channel === `${path}/open`, "an exact-channel grant decides over a subtree grant");
        const e2 = await maya.ok("explain_access", { board_id: board, channel: `${path}/open` });
        check(e2.pattern === `${path}/open` && e2.level === "everyone", `explain_access names the exact pattern (got ${e2.pattern}, ${e2.level})`);
        // A reader is capped by the role whatever the grants say.
        const quotaOnBoard = await ctx.isMember("quota", board);
        if (quotaOnBoard) {
          const quotaId = (await ctx.me("quota")).id;
          const ex = await owner.ok("explain_access", { board_id: board, channel: `${path}/open`, principal_id: quotaId });
          if (ex.role === "reader") check(!ex.can.includes("post"), "a reader can't post whatever the grants give (role cap)");
        }
        const listed = (await owner.ok("list_grants", { board_id: board })).grants.map((g) => g.id);
        check(listed.includes(readOnly.grant.id) && listed.includes(closed.grant.id), "list_grants shows the owner every grant");
        check((await maya.ok("list_grants", { board_id: board })).grants.length === 0, "list_grants shows a member without manage no grants");
        await maya.fails("create_grant", { board_id: board, principals: [{ kind: "everyone" }], can: { "*": ["read"] } }, "forbidden");
      } finally {
        await owner.call("revoke_grant", { grant_id: readOnly.grant.id });
        await owner.call("revoke_grant", { grant_id: closed.grant.id });
      }
      const after = await maya.ok("explain_access", { board_id: board, channel: `${path}/a` });
      check(after.pattern === null && after.can.includes("post"), "revoking the grants restores the role's defaults");
    },
  },
  {
    id: "core.named-board-limit",
    profile: "core",
    title: "People can create named boards up to boards_owned; names are unique among their boards; whoami lists every owned board",
    async run(ctx) {
      const owner = await ctx.session("owner");
      await ctx.boardOf("owner");
      const w = await owner.ok("whoami", {});
      check(Array.isArray(w.owned_boards) && w.owned_boards.length >= 1, "whoami.owned_boards lists the personal board");
      check(w.owned_boards[0]!.id === w.owned_board?.id, "owned_boards starts with owned_board");
      const reported = w.principal.limits?.boards_owned ?? (await ctx.discovery()).limits.boards_owned;
      if (typeof reported !== "number") return ctx.skip("the server does not report boards_owned");
      const limit = reported;
      let owned = w.owned_boards.length;
      const name = `Conformance ${ctx.runId}`;
      if (owned < limit) {
        const r = await owner.ok("create_board", { name });
        check(!r.board.is_personal && r.board.my_role === "owner" && r.board.name === name, "create_board returns a named board the caller owns");
        owned++;
        const dup = await owner.fails("create_board", { name: name.toUpperCase() }, ["conflict", "quota_exceeded"]);
        if (dup.code === "conflict") check(reasonOf(dup) === "board_name_taken", `a taken name fails with reason ${reasonOf(dup)}, expected board_name_taken`);
        const again = await owner.ok("whoami", {});
        check(again.owned_boards.some((b) => b.id === r.board.id), "whoami.owned_boards includes the new board");
        check(again.owned_board?.id === w.owned_board?.id, "owned_board stays the personal board");
        for (let i = 0; owned < limit && i < 10; i++, owned++) await owner.ok("create_board", { name: `${name} ${i + 2}` });
      } else ctx.note(`the owner already owns ${owned} of ${limit} boards`);
      const over = await owner.fails("create_board", { name: `${name} over` }, "quota_exceeded");
      const d = (over.details ?? {}) as { allowance?: unknown; limit?: unknown };
      check(d.allowance === "boards_owned", `details.allowance is ${String(d.allowance)}, expected boards_owned`);
      check(d.limit === limit, `details.limit is ${String(d.limit)}, expected ${limit}`);
      await (await ctx.session("agent")).fails("create_board", { name: `Agent ${ctx.runId}` }, "forbidden");
    },
  },
];
