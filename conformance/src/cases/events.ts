/** events profile: MCP Events extension (SEP-3415) with poll and webhook delivery. */
import { EVENT_DEFINITIONS, EVENT_NAMES, EVENTS_EXTENSION_ID, MCP_PROTOCOL_VERSION } from "@openmessageboard/protocol";
import type { EventName } from "@openmessageboard/protocol";
import { check, Failure } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { CLIENT_INFO, rawRpc, type RpcOutcome } from "../http.ts";
import type { McpSession } from "../mcp.ts";
import { entryByRef, schemaShape, toJsonSchema } from "../schemagen/build.ts";
import { sleep } from "../util.ts";
import { expiryScenario } from "./expiry.ts";
import { mayaOnOwnerBoard, ownerBoard, reply, sharedThread, startThread } from "./helpers.ts";

interface Occurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: unknown;
  cursor?: string | null;
}

function pollResult(r: RpcOutcome, where: string): { events: Occurrence[]; cursor: string; truncated: boolean; hasMore: boolean; nextPollMs: number } {
  if (!r.result) throw new Failure(`${where}: events/poll failed: ${JSON.stringify(r.error)}`);
  const res = r.result as { events?: Occurrence[]; cursor?: unknown; truncated?: unknown; hasMore?: unknown; nextPollMs?: unknown };
  check(Array.isArray(res.events), `${where}: poll result needs events[]`);
  check(typeof res.cursor === "string" && res.cursor.length > 0, `${where}: poll result needs a cursor (always present, advancing even when empty)`);
  check(typeof res.truncated === "boolean" && typeof res.hasMore === "boolean", `${where}: poll result needs truncated and hasMore`);
  check(typeof res.nextPollMs === "number" && res.nextPollMs >= 1000, `${where}: nextPollMs must be at least 1000`);
  return res as never;
}

function checkOccurrence(o: Occurrence, name: EventName, where: string): void {
  check(o.name === name, `${where}: occurrence name ${o.name}, expected ${name}`);
  check(typeof o.eventId === "string" && /^[A-Za-z0-9_-]+$/.test(o.eventId), `${where}: eventId must be a string of [A-Za-z0-9_-] (usable as webhook-id)`);
  check(!Number.isNaN(Date.parse(o.timestamp)), `${where}: timestamp must be an ISO 8601 instant`);
  const parsed = EVENT_DEFINITIONS[name].payload.safeParse(o.data);
  check(parsed.success, `${where}: data does not match schemas/v0.1/events/${name}.payload.json: ${parsed.error?.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

/** Polls until `match` finds an occurrence or `timeoutMs` passes; returns all occurrences seen and the last cursor. */
async function pollUntil(s: McpSession, name: EventName, args: Record<string, unknown>, cursor: string, match: (o: Occurrence) => boolean, timeoutMs = 6000) {
  const seen: Occurrence[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = pollResult(await s.rpc("events/poll", { name, arguments: args, cursor }), `poll ${name}`);
    seen.push(...p.events);
    cursor = p.cursor;
    if (seen.some(match)) return { seen, cursor };
    if (Date.now() > deadline) return { seen, cursor };
    if (!p.hasMore) await sleep(400);
  }
}

async function subscribe(s: McpSession, name: EventName, args: Record<string, unknown>, url: string, secret: string, ttlMs = 600_000) {
  return s.rpc("events/subscribe", { name, arguments: args, delivery: { mode: "webhook", url, secret }, cursor: null, ttlMs });
}

async function outsiderCheck(ctx: Ctx, board: string): Promise<void> {
  if (await ctx.isMember("outsider", board)) ctx.skip("outsider is a member of the owner's board; use a fresh server");
}

export const eventCases: CaseDef[] = [
  {
    id: "events.capabilities",
    profile: "events",
    title: `Both capability shapes are advertised: top-level events and extensions["${EVENTS_EXTENSION_ID}"]`,
    async run(ctx) {
      const owner = await ctx.session("owner");
      const d = await owner.rpc("server/discover");
      check(d.result, `server/discover failed: ${JSON.stringify(d.error)}`);
      const caps = (d.result.capabilities ?? {}) as { events?: unknown; extensions?: Record<string, unknown> };
      check(caps.events && typeof caps.events === "object", "server/discover capabilities.events must be an object (ChatGPT's shape)");
      check(caps.extensions?.[EVENTS_EXTENSION_ID] && typeof caps.extensions[EVENTS_EXTENSION_ID] === "object", `server/discover capabilities.extensions["${EVENTS_EXTENSION_ID}"] must be an object (SEP-3415)`);
      const init = await rawRpc(ctx.endpoint, ctx.token("owner"), "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: CLIENT_INFO }, { legacy: true });
      if (!init.result) ctx.note(`legacy initialize (2025-11-25) failed: ${JSON.stringify(init.error ?? init.status).slice(0, 160)}; the stateless fallback is a SHOULD`);
      else {
        const lc = (init.result.capabilities ?? {}) as { events?: unknown };
        if (!lc.events) ctx.note("legacy initialize result lacks capabilities.events");
      }
    },
  },
  {
    id: "events.list",
    profile: "events",
    title: "events/list returns the three event types with poll and webhook delivery and matching schemas",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const r = await maya.rpc("events/list");
      check(r.result, `events/list failed: ${JSON.stringify(r.error)}`);
      const events = (r.result.events ?? []) as { name: string; description?: string; delivery?: string[]; inputSchema?: unknown; payloadSchema?: unknown }[];
      const names = events.map((e) => e.name).sort();
      check(JSON.stringify(names) === JSON.stringify([...EVENT_NAMES].sort()), `events/list names ${names.join(", ")}; expected ${EVENT_NAMES.join(", ")}`);
      for (const e of events) {
        check(e.delivery?.includes("poll") && e.delivery.includes("webhook"), `${e.name}: delivery must include poll and webhook`);
        check(typeof e.description === "string" && e.description.length > 0, `${e.name}: description is required`);
        for (const [part, schema] of [["arguments", e.inputSchema], ["payload", e.payloadSchema]] as const) {
          const ours = schemaShape(toJsonSchema(entryByRef(`events/${e.name}.${part}`)!));
          const theirs = schemaShape(schema);
          check(JSON.stringify(ours) === JSON.stringify(theirs), `${e.name} ${part} schema differs from schemas/v0.1: properties [${theirs.properties}] required [${theirs.required}] vs [${ours.properties}] required [${ours.required}]`);
        }
      }
    },
  },
  {
    id: "events.poll",
    profile: "events",
    title: "events/poll starts from now, returns new occurrences with a cursor, and never returns your own messages",
    async run(ctx) {
      const t = await sharedThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const args = { board_id: t.boardId };
      const start = pollResult(await maya.rpc("events/poll", { name: "board.message_created", arguments: args, cursor: null }), "poll from now");
      check(start.events.length === 0, "cursor: null starts from now and returns no events");
      const theirs = await reply(owner, t.threadId, "An event for maya.");
      const own = await reply(maya, t.threadId, "Maya's own message.");
      const got = await pollUntil(maya, "board.message_created", args, start.cursor, (o) => o.eventId === theirs.message.id);
      const occ = got.seen.find((o) => o.eventId === theirs.message.id);
      check(occ, "the new message by another member was not returned by events/poll (eventId = message ID)");
      checkOccurrence(occ, "board.message_created", "board.message_created");
      const data = occ.data as { message: { id: string }; thread: { id: string; url: string }; board_id: string };
      check(data.message.id === theirs.message.id && data.thread.id === t.threadId && data.board_id === t.boardId, "occurrence data names the board, thread and message");
      check(got.cursor !== start.cursor, "the cursor advances after returning occurrences");
      await sleep(500);
      const more = await pollUntil(maya, "board.message_created", args, got.cursor, () => false, 1000);
      check(![...got.seen, ...more.seen].some((o) => o.eventId === own.message.id), "the subscriber's own message must not be delivered");
      const ip = pollResult(await maya.rpc("events/poll", { name: "inbox.item_created", arguments: {}, cursor: null }), "inbox poll from now");
      const mention = await reply(owner, t.threadId, "Mentioning maya for the inbox event.", { mentions: [mayaId] });
      const inbox = await pollUntil(maya, "inbox.item_created", {}, ip.cursor, (o) => (o.data as { message?: { id?: string } | null }).message?.id === mention.message.id);
      const io = inbox.seen.find((o) => (o.data as { message?: { id?: string } | null }).message?.id === mention.message.id);
      check(io, "inbox.item_created did not return the mention");
      checkOccurrence(io, "inbox.item_created", "inbox.item_created");
      check((io.data as { kind: string }).kind === "mention", "the inbox occurrence has kind mention");
      const items = await maya.ok("get_inbox", {});
      const item = items.items.find((i) => i.message?.id === mention.message.id);
      check(item && io.eventId === item.id, "inbox.item_created eventId is the inbox item ID (06 §Event types)");
      const mayaBoard = await ctx.boardOf("maya");
      const misuse = await maya.rpc("events/poll", { name: "board.message_created", arguments: { board_id: mayaBoard }, cursor: got.cursor });
      check(misuse.error && misuse.error.code === -32602, `a cursor reused with other arguments must fail with -32602, got ${JSON.stringify(misuse.error ?? "success").slice(0, 120)}`);
    },
  },
  {
    id: "events.poll-access",
    profile: "events",
    title: "Polling a board you cannot read fails with -32024, the same for unknown boards",
    async run(ctx) {
      const board = await ownerBoard(ctx);
      await outsiderCheck(ctx, board);
      const outsider = await ctx.session("outsider");
      for (const id of [board, "b_unknown000000"]) {
        const r = await outsider.rpc("events/poll", { name: "board.message_created", arguments: { board_id: id }, cursor: null });
        check(r.error, `events/poll on ${id} by a non-member succeeded`);
        check(r.error.code === -32024, `events/poll on ${id}: JSON-RPC code ${r.error.code}, expected -32024`);
        const code = (r.error.data as { code?: unknown } | undefined)?.code;
        check(code === "not_found", `events/poll on ${id}: data.code ${String(code)}, expected not_found`);
      }
    },
  },
  {
    id: "events.webhook",
    profile: "events",
    title: "Webhook subscribe: verification challenge, Standard Webhooks signed delivery, refresh and unsubscribe",
    async run(ctx) {
      const t = await sharedThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const ep = (await ctx.receiver()).endpoint("echo");
      const args = { board_id: t.boardId };
      const before = ctx.serverNow();
      const r = await subscribe(maya, "board.message_created", args, ep.url, ep.secret);
      check(r.result, `events/subscribe failed: ${JSON.stringify(r.error)} (is the server in test mode, allowing http://127.0.0.1 callbacks?)`);
      const res = r.result as { id?: unknown; refreshBefore?: unknown; cursor?: unknown; truncated?: unknown };
      check(typeof res.id === "string" && res.id.length > 0, "subscribe result needs an id");
      const refresh = Date.parse(String(res.refreshBefore));
      check(Number.isFinite(refresh), "refreshBefore must be an instant (servers never grant no-expiry)");
      check(refresh <= before + 600_000 + 60_000, "refreshBefore must not exceed the requested ttlMs");
      check(typeof res.truncated === "boolean" && "cursor" in res, "subscribe result needs cursor and truncated");
      const verification = ep.deliveries.find((d) => d.body?.type === "verification");
      check(verification, "no verification challenge was sent before the subscription became active");
      check(verification.signatureError === null, `the verification request signature is invalid: ${verification.signatureError}`);
      const posted = await reply(owner, t.threadId, "Webhook delivery check.");
      const d = await ep.waitFor((x) => x.body?.eventId === posted.message.id, 15_000);
      check(d, "no webhook delivery for a new message within 15 s");
      check(d.signatureError === null, `delivery signature: ${d.signatureError}`);
      check(d.headers["webhook-id"] === posted.message.id, "webhook-id equals the eventId");
      check(d.headers["x-mcp-subscription-id"] === res.id, "X-MCP-Subscription-Id equals the subscription id");
      check((d.headers["content-type"] ?? "").startsWith("application/json"), "deliveries are application/json");
      checkOccurrence(d.body as unknown as Occurrence, "board.message_created", "webhook delivery");
      check(Buffer.byteLength(d.raw) <= 256 * 1024, "deliveries are at most 256 KiB");
      const own = await reply(maya, t.threadId, "Own message, not delivered.");
      await sleep(2500);
      check(!ep.deliveries.some((x) => x.body?.eventId === own.message.id), "the subscriber's own message was delivered");
      const again = await subscribe(maya, "board.message_created", args, ep.url, ep.secret);
      check(again.result && (again.result as { id?: unknown }).id === res.id, "subscribing again with the same key refreshes and returns the same id");
      const un = await maya.rpc("events/unsubscribe", { name: "board.message_created", arguments: args, delivery: { url: ep.url } });
      check(un.result, `events/unsubscribe failed: ${JSON.stringify(un.error)}`);
      const un2 = await maya.rpc("events/unsubscribe", { name: "board.message_created", arguments: args, delivery: { url: ep.url } });
      check(un2.result, "events/unsubscribe is idempotent");
      const afterUn = await reply(owner, t.threadId, "After unsubscribe.");
      await sleep(3000);
      check(!ep.deliveries.some((x) => x.body?.eventId === afterUn.message.id), "a message after unsubscribe was delivered");
    },
  },
  {
    id: "events.webhook-challenge-failure",
    profile: "events",
    title: "A callback that fails the challenge is refused with -32027 challenge_failed",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const ep = (await ctx.receiver()).endpoint("wrong-challenge");
      const r = await subscribe(maya, "board.message_created", { board_id: board }, ep.url, ep.secret);
      check(r.error, "events/subscribe succeeded although the endpoint answered the wrong challenge");
      check(ep.deliveries.some((d) => d.body?.type === "verification"), "the server never sent a verification challenge");
      check(r.error.code === -32027, `JSON-RPC code ${r.error.code}, expected -32027 (CallbackEndpointError)`);
      const reason = (r.error.data as { reason?: unknown } | undefined)?.reason;
      if (reason !== "challenge_failed") ctx.note(`data.reason is ${String(reason)}, expected challenge_failed`);
    },
  },
  {
    id: "events.webhook-refused-addresses",
    profile: "events",
    title: "Private, link-local, metadata and non-HTTPS callbacks and invalid secrets are refused",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
      const urls = [
        "https://10.0.0.1/hooks/omb",
        "https://192.168.1.10/hooks/omb",
        "https://172.16.5.4/hooks/omb",
        "https://169.254.169.254/latest/meta-data/",
        "https://100.64.1.1/hooks/omb",
        "https://[fd00::1]/hooks/omb",
        "http://10.1.2.3/hooks/omb",
        "http://example.test/hooks/omb",
      ];
      const nonInvalidParams: string[] = [];
      for (const url of urls) {
        const r = await subscribe(maya, "board.message_created", { board_id: board }, url, secret);
        check(r.error, `a callback to ${url} was accepted`);
        if (r.error.code !== -32602) nonInvalidParams.push(`${url} → ${r.error.code}`);
      }
      if (nonInvalidParams.length) ctx.note(`refused, but not with -32602: ${nonInvalidParams.join(", ")}`);
      const ep = (await ctx.receiver()).endpoint("echo");
      for (const bad of ["whsec_" + Buffer.alloc(8, 1).toString("base64"), "not-a-secret"]) {
        const r = await subscribe(maya, "board.message_created", { board_id: board }, ep.url, bad);
        check(r.error && r.error.code === -32602, `secret "${bad}" should be refused with -32602, got ${JSON.stringify(r.error ?? "success").slice(0, 120)}`);
      }
    },
  },
  {
    id: "events.webhook-terminated",
    profile: "events",
    title: "When access ends, the webhook gets a signed terminated envelope and nothing further",
    timeoutMs: 150_000,
    async run(ctx) {
      const f = await expiryScenario(ctx);
      if (!f.ranEvents) ctx.skip("the expiry scenario ran without the events profile");
      for (const n of f.notes) ctx.note(n);
      const problems = [...f.common, ...f.events];
      if (problems.length) throw new Failure(problems.join("; "));
    },
  },
  {
    id: "events.task-updated",
    profile: "events",
    title: "board.task_updated reports task changes by others, filtered by labels",
    async run(ctx) {
      if (!ctx.claims("tasks") && !ctx.opts.forceProfiles) ctx.skip("server does not claim the tasks profile");
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const batch = `tu${ctx.runId}`;
      const args = { board_id: board, labels: { batch } };
      const p0 = pollResult(await maya.rpc("events/poll", { name: "board.task_updated", arguments: args, cursor: null }), "task poll from now");
      const other = await startThread(owner, board, `Untracked ${ctx.runId}`, "different label", { task: true, labels: { batch: `${batch}x` } });
      const t = await startThread(owner, board, `Tracked ${ctx.runId}`, "tracked task", { task: true, labels: { batch } });
      const created = await pollUntil(maya, "board.task_updated", args, p0.cursor, (o) => (o.data as { thread: { id: string } }).thread.id === t.thread.id);
      const occ = created.seen.find((o) => (o.data as { thread: { id: string } }).thread.id === t.thread.id);
      check(occ, "creating a matching task produced no board.task_updated occurrence");
      checkOccurrence(occ, "board.task_updated", "board.task_updated");
      check(!created.seen.some((o) => (o.data as { thread: { id: string } }).thread.id === other.thread.id), "a task with non-matching labels was delivered");
      await maya.ok("claim_task", { thread_id: t.thread.id });
      await owner.ok("update_task", { thread_id: t.thread.id, action: "block", reason: `hold ${ctx.runId}` });
      const mayaId = (await ctx.me("maya")).id;
      type TaskData = { thread: { id: string; task: { state: string } | null }; actor: { id: string } | null };
      const isHold = (o: Occurrence) => {
        const d = o.data as TaskData;
        return d.thread.id === t.thread.id && d.thread.task?.state === "blocked" && d.actor?.id !== mayaId;
      };
      const held = await pollUntil(maya, "board.task_updated", args, created.cursor, isHold);
      check(!held.seen.some((o) => (o.data as TaskData).actor?.id === mayaId), "maya's own claim was delivered to maya");
      check(held.seen.some(isHold), "the owner's hold was not delivered");
      const byState = pollResult(await maya.rpc("events/poll", { name: "board.task_updated", arguments: { ...args, state: "blocked" }, cursor: created.cursor }), "task poll by state");
      check(
        byState.events.every((o) => (o.data as TaskData).thread.task?.state === "blocked"),
        "the state argument filters occurrences by the task's state",
      );
    },
  },
  {
    id: "events.push",
    profile: "events",
    title: "Push (optional): events/stream checks Mcp-Name, confirms with active, delivers occurrences tagged with the subscription ID, and heartbeats",
    async run(ctx) {
      const t = await sharedThread(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const list = await maya.rpc("events/list");
      const def = ((list.result?.events ?? []) as { name: string; delivery?: string[] }[]).find((e) => e.name === "board.message_created");
      if (!def?.delivery?.includes("push")) ctx.skip("board.message_created does not offer push delivery (optional)");
      const args = { board_id: t.boardId };
      const open = (name: string, headerName: string, signal?: AbortSignal) =>
        fetch(ctx.endpoint, {
          method: "POST",
          ...(signal ? { signal } : {}),
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${ctx.token("maya")}`,
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            "mcp-method": "events/stream",
            "mcp-name": headerName,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "conf-push",
            method: "events/stream",
            params: {
              name,
              arguments: args,
              cursor: null,
              heartbeatMs: 5000,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS_EXTENSION_ID]: {} } },
              },
            },
          }),
        });
      const mismatch = await open("board.message_created", "inbox.item_created");
      const mm = (await mismatch.json().catch(() => null)) as { error?: { code?: number } } | null;
      check(mismatch.status === 400 && mm?.error?.code === -32020, `a mismatched Mcp-Name header must be rejected with 400 and -32020 (got ${mismatch.status} ${JSON.stringify(mm?.error)})`);

      const ac = new AbortController();
      const res = await open("board.message_created", "board.message_created", ac.signal);
      try {
        check((res.headers.get("content-type") ?? "").includes("text/event-stream"), `events/stream must answer with an SSE stream (got ${res.status} ${res.headers.get("content-type")})`);
        const frames: Record<string, unknown>[] = [];
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
        void (async () => {
          let buf = "";
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) return;
              buf += value;
              let i: number;
              while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
                const data = buf.slice(0, i).split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
                buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
                if (data) frames.push(JSON.parse(data) as Record<string, unknown>);
              }
            }
          } catch {
            /* aborted */
          }
        })();
        const take = async (m: string, ms: number) => {
          const deadline = Date.now() + ms;
          for (;;) {
            const i = frames.findIndex((f) => f.method === m);
            if (i !== -1) return frames.splice(i, 1)[0] as { params: Record<string, unknown> };
            if (Date.now() > deadline) return undefined;
            await sleep(100);
          }
        };
        const subId = (p: Record<string, unknown>) => (p._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/subscriptionId"];
        const active = await take("notifications/events/active", 5000);
        check(active, "the stream must start with notifications/events/active");
        check(typeof active.params.heartbeatMs === "number" && typeof active.params.truncated === "boolean", "active carries the granted heartbeatMs and truncated");
        check(subId(active.params) === "conf-push", "every notifications/events/* message carries the request id in _meta subscriptionId");
        const own = await reply(maya, t.threadId, "Own message, not pushed.");
        const posted = await reply(owner, t.threadId, "Push delivery check.");
        const ev = await take("notifications/events/event", 10_000);
        check(ev, "no notifications/events/event for a new message within 10 s");
        check(ev.params.eventId === posted.message.id, `the first pushed event is ${String(ev.params.eventId)}, expected the owner's message (the subscriber's own message ${own.message.id} is excluded)`);
        check(subId(ev.params) === "conf-push", "event notifications carry the subscription ID");
        check(typeof ev.params.cursor === "string", "push occurrences carry a cursor");
        const { _meta: _ignored, ...occurrence } = ev.params;
        checkOccurrence(occurrence as unknown as Occurrence, "board.message_created", "push delivery");
        const hb = await take("notifications/events/heartbeat", Number(active.params.heartbeatMs) * 2 + 2000);
        check(hb, `no notifications/events/heartbeat within twice the granted interval (${String(active.params.heartbeatMs)} ms)`);
        check("cursor" in hb.params, "heartbeats carry the checked-up-to cursor");
      } finally {
        ac.abort();
      }
    },
  },
];
