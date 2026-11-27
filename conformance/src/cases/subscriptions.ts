/** core profile: channel subscriptions (03 §Subscriptions). */
import type { InboxItem } from "@openmessageboard/protocol";
import { check } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { McpSession } from "../mcp.ts";
import { newKey } from "../util.ts";
import { inboxCursor, mayaOnOwnerBoard, readInbox, reply } from "./helpers.ts";

/** A channel path used by this run only, so reruns against one server do not collide. */
const chan = (ctx: Ctx, name: string) => `sub-${name}-${ctx.runId}`;

const post = (s: McpSession, board: string, channel: string, title: string) =>
  s.ok("start_thread", { board_id: board, channel, title, body: `${title}.`, idempotency_key: newKey() });

/** The caller's new inbox items for one thread, oldest first. */
async function itemsFor(s: McpSession, cursor: string, threadId: string): Promise<InboxItem[]> {
  return (await readInbox(s, cursor)).items.filter((i) => i.thread_id === threadId);
}

const kinds = (items: InboxItem[]) => items.map((i) => i.kind).join(",");

/** Sets a subscription and removes it again when the case ends, whatever happens. */
async function subscribed(s: McpSession, board: string, pattern: string, level: "all" | "threads" | "mentions" | "mute", run: () => Promise<void>): Promise<void> {
  const set = await s.ok("set_subscription", { board_id: board, pattern, level });
  check(set.subscription?.pattern === pattern && set.subscription.level === level, "set_subscription returns the subscription it stored");
  try {
    await run();
  } finally {
    await s.ok("set_subscription", { board_id: board, pattern, level: null }).catch(() => undefined);
  }
}

async function profileSession(ctx: Ctx, name: string): Promise<McpSession> {
  await ctx.discovery();
  const s = await McpSession.connect(`maya/${name}`, ctx.endpoint, ctx.token("maya"), 15_000, { "OMB-Profile": name });
  ctx.cleanups.push(() => s.close());
  return s;
}

export const subscriptionCases: CaseDef[] = [
  {
    id: "core.subscription-threads",
    profile: "core",
    title: "A threads subscription puts one thread item in the inbox for a new thread and nothing for a later reply",
    covers: ["R03-47", "R03-55"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const base = chan(ctx, "threads");
      await subscribed(maya, board, `${base}/`, "threads", async () => {
        const cursor = await inboxCursor(maya);
        const t = await post(owner, board, `${base}/billing`, `Subscribed thread ${ctx.runId}`);
        await reply(owner, t.thread.id, "A later reply.");
        const items = await itemsFor(maya, cursor, t.thread.id);
        check(kinds(items) === "thread", `a threads subscriber gets exactly one thread item, got [${kinds(items)}]`);
        check(items[0]!.message?.id === t.message.id, "a thread item carries the thread's root message");
        const elsewhere = await post(owner, board, chan(ctx, "elsewhere"), `Not subscribed ${ctx.runId}`);
        check((await itemsFor(maya, cursor, elsewhere.thread.id)).length === 0, "a channel the pattern does not cover creates no item");
      });
      const after = await maya.ok("list_subscriptions", { board_id: board });
      check(!after.subscriptions.some((s) => s.pattern === `${base}/`), "level: null removes the subscription");
    },
  },
  {
    id: "core.subscription-all",
    profile: "core",
    title: "An all subscription adds a message item per reply; a followed thread's reply is a reply item, never both",
    covers: ["R03-55"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const channel = chan(ctx, "all");
      await subscribed(maya, board, channel, "all", async () => {
        const cursor = await inboxCursor(maya);
        const t = await post(owner, board, channel, `All ${ctx.runId}`);
        await reply(owner, t.thread.id, "First reply.");
        check(kinds(await itemsFor(maya, cursor, t.thread.id)) === "thread,message", `expected a thread item then a message item, got [${kinds(await itemsFor(maya, cursor, t.thread.id))}]`);
        await maya.ok("set_follow", { thread_id: t.thread.id, following: true });
        await reply(owner, t.thread.id, "Second reply.");
        const items = await itemsFor(maya, cursor, t.thread.id);
        check(kinds(items) === "thread,message,reply", `a reply in a followed thread is one reply item, not a message item as well: got [${kinds(items)}]`);
      });
    },
  },
  {
    id: "core.subscription-mute",
    profile: "core",
    title: "Under mute a reply in a followed thread creates nothing, and a mention still arrives",
    covers: ["R03-54"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const channel = chan(ctx, "mute");
      const t = await post(maya, board, channel, `Muted ${ctx.runId}`); // maya follows her own thread
      await subscribed(maya, board, channel, "mute", async () => {
        const cursor = await inboxCursor(maya);
        await reply(owner, t.thread.id, "A reply she would normally hear about.");
        check((await itemsFor(maya, cursor, t.thread.id)).length === 0, "mute must drop reply items for followed threads in the channel");
        await reply(owner, t.thread.id, "A mention.", { mentions: [mayaId] });
        check(kinds(await itemsFor(maya, cursor, t.thread.id)) === "mention", "a mention must still reach a muted channel's subscriber");
      });
    },
  },
  {
    id: "core.subscription-specificity",
    profile: "core",
    title: "The most specific pattern decides: mute at one channel under an all subtree silences only that channel",
    covers: ["R03-46"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const base = chan(ctx, "www");
      await subscribed(maya, board, `${base}/`, "all", async () => {
        await subscribed(maya, board, `${base}/preview`, "mute", async () => {
          const cursor = await inboxCursor(maya);
          const prod = await post(owner, board, `${base}/production`, `Production ${ctx.runId}`);
          const preview = await post(owner, board, `${base}/preview`, `Preview ${ctx.runId}`);
          check(kinds(await itemsFor(maya, cursor, prod.thread.id)) === "thread", "the subtree subscription applies to a channel with no closer pattern");
          check((await itemsFor(maya, cursor, preview.thread.id)).length === 0, "the exact channel's mute must win over the subtree's all");
        });
      });
    },
  },
  {
    id: "core.subscription-unreadable",
    profile: "core",
    title: "A subscription is accepted for any pattern, and creates items only from channels the subscriber can read",
    covers: ["R03-48", "R03-53"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const path = chan(ctx, "private");
      const made = await owner.ok("create_channel", { board_id: board, path, private: true });
      check(made.channel.private, "the channel is private");
      try {
        await subscribed(maya, board, `${path}/`, "all", async () => {
          const cursor = await inboxCursor(maya);
          const hidden = await post(owner, board, path, `Hidden ${ctx.runId}`);
          check((await readInbox(maya, cursor)).items.every((i) => i.thread_id !== hidden.thread.id), "a subscription must not create items from a channel its principal cannot read");
          const grant = await owner.ok("create_grant", { board_id: board, principals: [{ kind: "member", principal_id: mayaId }], can: { [`${path}/`]: ["read"] } });
          try {
            await reply(owner, hidden.thread.id, "After access was granted.");
            check(kinds(await itemsFor(maya, cursor, hidden.thread.id)) === "message", "items begin with the first message after access is granted, and only that one");
          } finally {
            await owner.ok("revoke_grant", { grant_id: grant.grant.id }).catch(() => undefined);
          }
        });
      } finally {
        for (const g of made.grants) await owner.ok("revoke_grant", { grant_id: g.id }).catch(() => undefined);
      }
    },
  },
  {
    id: "core.subscription-own",
    profile: "core",
    title: "No item for one's own message, and a profile's subscription fills the profile's inbox, not its person's",
    covers: ["R03-49", "R03-50"],
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mine = chan(ctx, "own");
      await subscribed(maya, board, mine, "all", async () => {
        const cursor = await inboxCursor(maya);
        const t = await post(maya, board, mine, `My own ${ctx.runId}`);
        check((await itemsFor(maya, cursor, t.thread.id)).length === 0, "a principal never gets an item for its own message");
      });
      const bot = await profileSession(ctx, "subs");
      const theirs = chan(ctx, "profile");
      await subscribed(bot, board, theirs, "threads", async () => {
        const listedForMaya = await maya.ok("list_subscriptions", { board_id: board });
        check(!listedForMaya.subscriptions.some((s) => s.pattern === theirs), "list_subscriptions must not show a profile's subscription to its person");
        const listedForBot = await bot.ok("list_subscriptions", {});
        check(listedForBot.subscriptions.some((s) => s.pattern === theirs && s.board_id === board), "list_subscriptions without a board lists the caller's subscriptions on every board");
        const botCursor = await inboxCursor(bot);
        const mayaCursor = await inboxCursor(maya);
        const t = await post(owner, board, theirs, `For the profile ${ctx.runId}`);
        check(kinds(await itemsFor(bot, botCursor, t.thread.id)) === "thread", "the profile's subscription must fill the profile's inbox");
        check((await itemsFor(maya, mayaCursor, t.thread.id)).length === 0, "a profile's subscription must not fill its person's inbox");
      });
    },
  },
  {
    id: "core.subscription-limit",
    profile: "core",
    title: "One subscription over subscriptions_per_board_principal is quota_exceeded; replacing one at the limit still works",
    covers: ["R03-51"],
    timeoutMs: 180_000,
    async run(ctx) {
      const info = await ctx.discovery();
      const published = info.limits.subscriptions_per_board_principal;
      if (typeof published !== "number" || published < 1 || published > 100) return ctx.skip(`subscriptions_per_board_principal is ${published}; the case runs for limits from 1 to 100`);
      const limit: number = published;
      const board = await mayaOnOwnerBoard(ctx);
      const bot = await profileSession(ctx, "subs-limit"); // its own principal, so maya's subscriptions are left alone
      const before = (await bot.ok("list_subscriptions", { board_id: board })).subscriptions;
      for (const s of before) await bot.ok("set_subscription", { board_id: board, pattern: s.pattern, level: null });
      const patterns: string[] = Array.from({ length: limit }, (_, i) => chan(ctx, `lim${i}`));
      try {
        for (const p of patterns) await bot.ok("set_subscription", { board_id: board, pattern: p, level: "threads" });
        const err = await bot.fails("set_subscription", { board_id: board, pattern: chan(ctx, "one-too-many"), level: "threads" }, "quota_exceeded");
        check((err.details as { allowance?: unknown } | undefined)?.allowance === "subscriptions", "quota_exceeded names the subscriptions allowance");
        const replaced = await bot.ok("set_subscription", { board_id: board, pattern: patterns[0]!, level: "mute" });
        check(replaced.subscription?.level === "mute", "replacing a subscription at the limit must still work");
      } finally {
        for (const p of patterns) await bot.ok("set_subscription", { board_id: board, pattern: p, level: null }).catch(() => undefined);
      }
    },
  },
];
