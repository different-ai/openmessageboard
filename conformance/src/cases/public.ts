/** public profile: reading without membership where the owner made a public grant (11 §Public access). */
import type { Board, Change } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import type { McpSession } from "../mcp.ts";
import { newKey } from "../util.ts";
import { mayaOnOwnerBoard, reply } from "./helpers.ts";

interface PublicWorld {
  board: string;
  /** A subtree the cases open to the public, and one channel under it that they close again. */
  open: string;
  news: { threadId: string; messageId: string; channel: string };
  internal: { threadId: string; channel: string };
  /** A thread in a channel no public grant ever covers. */
  hidden: { threadId: string; messageId: string; channel: string };
}

/** One board, with three threads posted once and shared by every case (posts are a monthly allowance). */
function world(ctx: Ctx): Promise<PublicWorld> {
  return ctx.fixture("public-world", async () => {
    const board = await mayaOnOwnerBoard(ctx);
    if (await ctx.isMember("outsider", board)) ctx.skip("outsider is a member of the owner's board; use a fresh server");
    const owner = await ctx.session("owner");
    const open = `pub-${ctx.runId}`;
    const post = (channel: string, title: string) => owner.ok("start_thread", { board_id: board, channel, title, body: `${title}.`, idempotency_key: newKey() });
    const news = await post(`${open}/news`, `Public news ${ctx.runId}`);
    const internal = await post(`${open}/internal`, `Internal ${ctx.runId}`);
    const hidden = await post(`priv-${ctx.runId}`, `Members only ${ctx.runId}`);
    return {
      board,
      open,
      news: { threadId: news.thread.id, messageId: news.message.id, channel: `${open}/news` },
      internal: { threadId: internal.thread.id, channel: `${open}/internal` },
      hidden: { threadId: hidden.thread.id, messageId: hidden.message.id, channel: `priv-${ctx.runId}` },
    };
  });
}

/** Opens `<open>/` to the public, except `<open>/internal/`, for the length of `run`. */
async function opened(ctx: Ctx, w: PublicWorld, run: (grantId: string) => Promise<void>): Promise<void> {
  const owner = await ctx.session("owner");
  const made = await owner.call("create_grant", { board_id: w.board, principals: [{ kind: "public" }], can: { [`${w.open}/`]: ["read"], [`${w.open}/internal/`]: "none" } });
  if (!made.ok) throw new Failure(`create_grant for the public failed: ${made.error.code}: ${made.error.message}`, made.error);
  try {
    await run(made.data.grant.id);
  } finally {
    await owner.ok("revoke_grant", { grant_id: made.data.grant.id }).catch(() => undefined);
  }
}

async function boardResource(s: McpSession, base: string, board: string): Promise<Board> {
  const r = await s.rpc("resources/read", { uri: `${base}/b/${board}` });
  check(r.result, `resources/read of the board failed: ${JSON.stringify(r.error)}`);
  const text = (r.result as { contents?: { text?: string }[] }).contents?.[0]?.text;
  check(text, "the board resource has no text content");
  return (JSON.parse(text) as { board: Board }).board;
}

export const publicCases: CaseDef[] = [
  {
    id: "public.read-without-membership",
    profile: "public",
    title: "Someone who is not a member reads a public channel's threads, messages and changes, as a public reader with no role",
    covers: ["R11-21", "R11-27", "R11-28", "R11-30", "R11-38", "R11-39"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const out = await ctx.session("outsider");
      const members = async () => (await owner.ok("get_usage", { board_id: w.board })).allowances.find((a) => a.allowance === "members")!.used;
      const before = await members();
      await out.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
      await opened(ctx, w, async () => {
        const board = await boardResource(out, await ctx.resourceBase(), w.board);
        check(board.my_access === "public" && board.my_role === null && board.my_access_ends_at === null, `a public reader's board has my_access public and no role, got ${board.my_access}/${board.my_role}`);
        check(board.visibility === "public", "Board.visibility is public while a public grant gives read");
        const thread = await out.ok("get_thread", { thread_id: w.news.threadId });
        check(thread.messages.some((m) => m.id === w.news.messageId), "get_thread returns the public thread's messages");
        check((await out.ok("list_threads", { board_id: w.board })).threads.some((t) => t.id === w.news.threadId), "list_threads includes the public thread");
        check((await out.ok("read_messages", { board_id: w.board })).messages.some((m) => m.id === w.news.messageId), "read_messages includes the public message");
        check((await out.ok("search_messages", { board_id: w.board, query: `news ${ctx.runId}` })).results.some((r) => r.message.id === w.news.messageId), "search_messages finds the public message");
        const why = await out.ok("explain_access", { board_id: w.board, channel: w.news.channel });
        check(why.level === "public" && why.role === null && why.can.join() === "read", `explain_access reports level public, no role and read; got ${why.level}/${why.role}/${why.can}`);
        check((await members()) === before, "a public reader must not occupy a seat");
      });
      const after = await owner.ok("list_threads", { board_id: w.board, channel: w.news.channel });
      check(after.threads.length > 0, "the board is unchanged for its members");
    },
  },
  {
    id: "public.other-channels-hidden",
    profile: "public",
    title: "Channels the public grant does not cover stay hidden: threads, lists, search and changes; the closest public pattern decides",
    covers: ["R11-24", "R11-29", "R11-31", "R11-32"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const out = await ctx.session("outsider");
      await opened(ctx, w, async () => {
        for (const id of [w.hidden.threadId, w.internal.threadId]) await out.fails("get_thread", { thread_id: id }, "not_found");
        const listed = (await out.ok("list_threads", { board_id: w.board })).threads.map((t) => t.id);
        check(!listed.includes(w.hidden.threadId), "list_threads shows a thread in a channel the public cannot read");
        check(!listed.includes(w.internal.threadId), "a closer public pattern that gives nothing must win over the subtree's read");
        const channels = (await out.ok("list_channels", { board_id: w.board })).channels;
        check(channels.some((c) => c.path === w.news.channel && c.public === true), "list_channels marks the public channel public: true");
        check(!channels.some((c) => c.path === w.hidden.channel || c.path === w.internal.channel), "list_channels shows a channel the public cannot read");
        check((await owner.ok("list_channels", { board_id: w.board })).channels.some((c) => c.path === w.hidden.channel && c.public === false), "a member sees the other channel marked public: false");
        check((await out.ok("search_messages", { board_id: w.board, query: `only ${ctx.runId}` })).results.length === 0, "search_messages finds a message the public cannot read");
        check(!(await out.ok("read_messages", { board_id: w.board })).messages.some((m) => m.id === w.hidden.messageId), "read_messages returns a message the public cannot read");

        // Changes: thread and message changes in public channels only. A grant change (board.updated) and a post in
        // another channel happen after the cursor and must not show.
        const cursor = (await out.ok("get_changes", { board_id: w.board })).cursor;
        const extra = await owner.ok("create_grant", { board_id: w.board, principals: [{ kind: "contributors" }], can: { [`${w.open}/`]: ["read", "post"] } });
        try {
          await reply(owner, w.hidden.threadId, "Members only, after the cursor.");
          const shown = await reply(owner, w.news.threadId, "Public, after the cursor.");
          const page = await out.ok("get_changes", { board_id: w.board, cursor });
          const changes = "changes" in page ? (page.changes as Change[]) : [];
          check(changes.some((c) => c.message_id === shown.message.id), "get_changes returns the new message in the public channel");
          check(changes.every((c) => c.thread_id === w.news.threadId), `get_changes returned changes outside the public channel: ${changes.map((c) => c.type).join(", ")}`);
          check(!changes.some((c) => c.type === "board.updated" || c.type.startsWith("member.")), "get_changes must not return board.updated or member.* changes to a public reader");
        } finally {
          await owner.ok("revoke_grant", { grant_id: extra.grant.id }).catch(() => undefined);
        }
      });
    },
  },
  {
    id: "public.read-only",
    profile: "public",
    title: "A public reader changes nothing: forbidden where they can read, not_found where they cannot, and handles are not revealed",
    covers: ["R02-40", "R11-34", "R11-35", "R11-36", "R11-37"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const out = await ctx.session("outsider");
      const outId = (await ctx.me("outsider")).id;
      const handle = (await owner.ok("list_members", { board_id: w.board })).members[0]!.handle;
      await opened(ctx, w, async () => {
        const text = () => ({ body: "From someone who is not a member.", idempotency_key: newKey() });
        await out.fails("start_thread", { board_id: w.board, title: "Not a member", ...text() }, "forbidden");
        for (const tool of ["list_members", "list_actors", "list_grants", "get_usage"]) await out.fails(tool, { board_id: w.board }, "forbidden");
        await out.fails("set_subscription", { board_id: w.board, pattern: "*", level: "all" }, "forbidden");
        await out.fails("reply", { thread_id: w.news.threadId, ...text() }, "forbidden");
        await out.fails("set_follow", { thread_id: w.news.threadId, following: true }, "forbidden");
        await out.fails("delete_message", { message_id: w.news.messageId }, "forbidden");
        await out.fails("reply", { thread_id: w.hidden.threadId, ...text() }, "not_found");
        await out.fails("set_follow", { thread_id: w.hidden.threadId, following: true }, "not_found");
        await out.fails("delete_message", { message_id: w.hidden.messageId }, "not_found");
        // A member's handle and a made-up one get the same answer.
        for (const by of [handle, `nobody-${ctx.runId}`]) await out.fails("read_messages", { board_id: w.board, by }, "invalid_argument");
        // Not a member, so not mentionable, and nothing reaches their inbox.
        await owner.fails("reply", { thread_id: w.news.threadId, body: "Mentioning someone who is not a member.", mentions: [outId], idempotency_key: newKey() }, "invalid_argument");
        const inbox = await out.ok("get_inbox", { board_id: w.board });
        check(inbox.items.length === 0, "a public reader has inbox items from the board");
      });
    },
  },
  {
    id: "public.pull-only",
    profile: "public",
    title: "The public pulls: get_changes and events/poll work; wait_for_activity, listen, events/stream and webhook subscriptions are for members",
    covers: ["R06-45", "R06-46", "R06-47", "R11-33"],
    timeoutMs: 60_000,
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const out = await ctx.session("outsider");
      const base = await ctx.resourceBase();
      await opened(ctx, w, async () => {
        const cursor = (await out.ok("get_changes", { board_id: w.board })).cursor;
        await out.fails("wait_for_activity", { board_id: w.board, cursor, timeout_seconds: 1 }, "forbidden");
        await out.fails("wait_for_activity", { thread_id: w.news.threadId, cursor, timeout_seconds: 1 }, "forbidden");
        if (ctx.claims("live")) {
          const uris = [`${base}/b/${w.board}`, `${base}/b/${w.board}/t/${w.news.threadId}`];
          const l = await out.listen(uris);
          try {
            check(!l.acknowledged.some((u) => uris.includes(u)), "listen acknowledged a URI the caller reads only through a public grant");
          } finally {
            await l.close();
          }
        } else ctx.note("the server does not claim live; listen was not checked");
        if (!ctx.claims("events")) return ctx.note("the server does not claim events; the Events methods were not checked");
        const args = { board_id: w.board };
        const start = await out.rpc("events/poll", { name: "board.message_created", arguments: args, cursor: null });
        check(start.result, `events/poll by a public reader failed: ${JSON.stringify(start.error)}`);
        const posted = await reply(owner, w.news.threadId, "For someone polling.");
        let seen = false;
        let at = (start.result as { cursor: string }).cursor;
        for (let i = 0; i < 12 && !seen; i++) {
          const p = await out.rpc("events/poll", { name: "board.message_created", arguments: args, cursor: at });
          check(p.result, `events/poll failed: ${JSON.stringify(p.error)}`);
          const r = p.result as { events: { eventId?: string }[]; cursor: string };
          seen = r.events.some((e) => e.eventId === posted.message.id);
          at = r.cursor;
          if (!seen) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        check(seen, "events/poll did not return a new message in the public channel");
        const stream = await out.rpc("events/stream", { name: "board.message_created", arguments: args, cursor: null }, 5000);
        check(stream.error && stream.error.code === -32024, `events/stream by a public reader must be -32024, got ${JSON.stringify(stream.error ?? stream.result)}`);
        check((stream.error.data as { code?: string } | undefined)?.code === "forbidden", "events/stream must say forbidden in data.code");
        const ep = (await ctx.receiver()).endpoint("echo");
        const sub = await out.rpc("events/subscribe", { name: "board.message_created", arguments: args, delivery: { mode: "webhook", url: ep.url, secret: ep.secret }, cursor: null, ttlMs: 600_000 });
        check(sub.error && sub.error.code === -32024, `events/subscribe by a public reader must be -32024, got ${JSON.stringify(sub.error ?? sub.result)}`);
        check(ep.deliveries.length === 0, "the server called the endpoint of a subscription it refused");
      });
    },
  },
  {
    id: "public.agents-need-saved",
    profile: "public",
    title: "An agent reads a public board only after its person saved it; saving is for people, and for public boards",
    covers: ["R11-40", "R11-41", "R11-42", "R11-43", "R11-44", "R11-45"],
    async run(ctx) {
      const w = await world(ctx);
      const maya = await ctx.session("maya");
      const agent = await ctx.session("agent"); // maya's agent, on no board
      if ((await agent.ok("whoami", {})).memberships.some((m) => m.board_id === w.board)) ctx.skip("the agent was added to the owner's board; use a fresh server");
      await maya.ok("unsave_board", { board_id: w.board });
      await opened(ctx, w, async () => {
        await agent.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
        await agent.fails("list_threads", { board_id: w.board }, "not_found");
        await agent.fails("start_thread", { board_id: w.board, title: "x", body: "x", idempotency_key: newKey() }, "not_found");
        await agent.fails("save_board", { board_id: w.board }, "forbidden");
        const saved = await maya.ok("save_board", { board_id: w.board });
        check(saved.board.id === w.board, "save_board returns the board");
        try {
          const thread = await agent.ok("get_thread", { thread_id: w.news.threadId });
          check(thread.thread.id === w.news.threadId, "the agent reads the public thread once its person saved the board");
          await agent.fails("get_thread", { thread_id: w.hidden.threadId }, "not_found");
          await agent.fails("reply", { thread_id: w.news.threadId, body: "x", idempotency_key: newKey() }, "forbidden");
          for (const [who, s] of [["the person", maya], ["the agent", agent]] as const) {
            check((await s.ok("whoami", {})).saved_boards.some((b) => b.id === w.board), `whoami.saved_boards must list the board for ${who}`);
          }
        } finally {
          const gone = await maya.ok("unsave_board", { board_id: w.board });
          const unknown = await maya.ok("unsave_board", { board_id: `b_unknown_${ctx.runId}` });
          check(gone.saved === false && unknown.saved === false, "unsave_board answers the same way whether or not the board exists");
        }
        await agent.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
      });
      // Nothing to save on a board that is not public.
      await maya.fails("save_board", { board_id: await ctx.boardOf("maya") }, "invalid_argument");
    },
  },
  {
    id: "public.owner-only",
    profile: "public",
    title: "Only the board's owner makes, changes or revokes a public grant, which gives read or nothing and names the public alone",
    covers: ["R11-22", "R11-23", "R11-25"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const pattern = `${w.open}/`;
      // maya manages the subtree, which is not enough to open it to the public.
      const manage = await owner.ok("create_grant", { board_id: w.board, principals: [{ kind: "member", principal_id: mayaId }], can: { [pattern]: "all" } });
      try {
        await maya.fails("create_grant", { board_id: w.board, principals: [{ kind: "public" }], can: { [pattern]: ["read"] } }, "forbidden");
        await owner.fails("create_grant", { board_id: w.board, principals: [{ kind: "public" }], can: { [pattern]: ["read", "post"] } }, "invalid_argument");
        await owner.fails("create_grant", { board_id: w.board, principals: [{ kind: "public" }], can: { [pattern]: "all" } }, "invalid_argument");
        await owner.fails("create_grant", { board_id: w.board, principals: [{ kind: "public" }, { kind: "everyone" }], can: { [pattern]: ["read"] } }, "invalid_argument");
        await opened(ctx, w, async (grantId) => {
          await maya.fails("update_grant", { grant_id: grantId, can: { [pattern]: "none" } }, "forbidden");
          await maya.fails("revoke_grant", { grant_id: grantId }, "forbidden");
          await owner.fails("update_grant", { grant_id: grantId, can: { [pattern]: ["read", "react"] } }, "invalid_argument");
          await owner.fails("update_grant", { grant_id: manage.grant.id, add: [{ kind: "public" }] }, "invalid_argument");
        });
      } finally {
        await owner.ok("revoke_grant", { grant_id: manage.grant.id }).catch(() => undefined);
      }
    },
  },
  {
    id: "public.members-not-worse-off",
    profile: "public",
    title: "A member closed out of a channel by another grant can still read it while the public can",
    covers: ["R11-26"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const closed = await owner.ok("create_grant", { board_id: w.board, principals: [{ kind: "everyone" }], can: { [`${w.open}/news`]: "none" } });
      try {
        await maya.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
        await opened(ctx, w, async () => {
          const thread = await maya.ok("get_thread", { thread_id: w.news.threadId });
          check(thread.thread.id === w.news.threadId, "a member must be able to read what the public can read");
        });
        await maya.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
      } finally {
        await owner.ok("revoke_grant", { grant_id: closed.grant.id }).catch(() => undefined);
      }
    },
  },
  {
    id: "public.revoke",
    profile: "public",
    title: "Revoking the public grant ends reading on the next request, and the board is private again",
    covers: ["R11-46"],
    async run(ctx) {
      const w = await world(ctx);
      const owner = await ctx.session("owner");
      const out = await ctx.session("outsider");
      await opened(ctx, w, async (grantId) => {
        await out.ok("get_thread", { thread_id: w.news.threadId });
        const revoked = await owner.ok("revoke_grant", { grant_id: grantId });
        check(revoked.revoked === true, "revoke_grant revokes");
        await out.fails("get_thread", { thread_id: w.news.threadId }, "not_found");
        await out.fails("list_threads", { board_id: w.board }, "not_found");
      });
      const board = await boardResource(owner, await ctx.resourceBase(), w.board);
      check(board.visibility === "private", "Board.visibility is private once no public grant gives read");
    },
  },
];

/** core: a server that does not offer public access says so. Runs only where `public` is not claimed. */
export const publicUnclaimedCase: CaseDef = {
  id: "core.public-unclaimed",
  profile: "core",
  title: "A server that does not claim the public profile refuses a public principal in a grant",
  covers: ["R11-20"],
  async run(ctx) {
    if (ctx.claims("public")) ctx.skip('the server claims the "public" profile; the public cases check it');
    const board = await mayaOnOwnerBoard(ctx);
    const owner = await ctx.session("owner");
    await owner.fails("create_grant", { board_id: board, principals: [{ kind: "public" }], can: { "*": ["read"] } }, "invalid_argument");
  },
};
