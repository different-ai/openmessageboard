import { timingSafeEqual, randomBytes } from "node:crypto";
import { EVENT_DEFINITIONS, EVENT_NAMES, threadUrl, type EventName } from "@openmessageboard/protocol";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { OmbError } from "../errors.js";
import { decrypt, encrypt, newId, sha256 } from "../ids.js";
import { activeMembership, actorFromPrincipal, getBoardRow, getPrincipal, nowIso, requireMember } from "../domain/access.js";
import { boardInScope } from "../auth/scopes.js";
import { decodeCursor, encodeCursor } from "../domain/cursors.js";
import { presentChanges } from "../domain/changes.js";
import type { Actor, EventRow, InboxRow, MessageRow, ThreadRow } from "../domain/model.js";
import { presentInbox, presentMessages, presentThreads } from "../domain/present.js";
import { labelsMatch } from "../domain/tasks.js";
import { boardLimits, limitsFor } from "../domain/plans.js";
import { AccessCache, ChannelAccess, channelMatches } from "../domain/grants.js";
import { CallbackError, newWebhookId, postSigned, validateCallbackUrl, type CallbackPolicy } from "./webhook-http.js";

export const EVENT_ERRORS = { NotFound: -32023, Forbidden: -32024, ResourceExhausted: -32025, Unsupported: -32026, CallbackEndpointError: -32027 } as const;

export class EventsError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: Record<string, unknown>) {
    super(message);
  }
}

export interface Occurrence {
  eventId: string;
  name: EventName;
  timestamp: string;
  data: unknown;
  cursor: string;
}

const DEFAULT_TTL_MS = 3_600_000;
const MAX_TTL_MS = 86_400_000;
const VERIFY_CACHE_MS = 86_400_000;

export function listEventDefinitions() {
  return {
    events: EVENT_NAMES.map((name) => ({
      name,
      description: EVENT_DEFINITIONS[name].description,
      delivery: ["poll", "webhook"],
      inputSchema: z.toJSONSchema(EVENT_DEFINITIONS[name].arguments),
      payloadSchema: z.toJSONSchema(EVENT_DEFINITIONS[name].payload),
    })),
  };
}

function parseArgs(name: string, args: unknown) {
  if (!(EVENT_NAMES as string[]).includes(name)) throw new EventsError(EVENT_ERRORS.NotFound, `Unknown event ${name}`);
  const parsed = EVENT_DEFINITIONS[name as EventName].arguments.safeParse(args ?? {});
  if (!parsed.success) throw new EventsError(-32602, `Invalid arguments: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data as { board_id?: string; thread_id?: string; channel?: string; labels?: Record<string, string>; state?: string };
}

function cursorScope(name: EventName, actor: Actor, args: { board_id?: string }): { kind: "b" | "i"; id: string } {
  return name === "inbox.item_created" ? { kind: "i", id: actor.id } : { kind: "b", id: args.board_id! };
}

function currentSeq(ctx: AppContext, scope: { kind: "b" | "i"; id: string }): number {
  return scope.kind === "i"
    ? (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM inbox_items WHERE principal_id = ?").get(scope.id) as { s: number }).s
    : (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
}

function authorize(ctx: AppContext, actor: Actor, name: EventName, args: { board_id?: string; thread_id?: string }) {
  try {
    if (args.board_id) requireMember(ctx, actor, args.board_id);
    if (args.thread_id) {
      const t = ctx.db.prepare("SELECT board_id, channel FROM threads WHERE id = ?").get(args.thread_id) as { board_id: string; channel: string } | undefined;
      if (!t || t.board_id !== args.board_id || !ChannelAccess.load(ctx, t.board_id, actor).can(t.channel, "read")) throw new OmbError("not_found", "Thread not found");
    }
  } catch (e) {
    if (e instanceof OmbError) throw new EventsError(EVENT_ERRORS.Forbidden, "Forbidden", { code: e.code === "access_ended" ? "access_ended" : "not_found", reason: e.message });
    throw e;
  }
  if (name !== "inbox.item_created" && !args.board_id) throw new EventsError(-32602, "board_id is required");
}

/** Occurrences after `afterSeq` for one subscription, oldest first. */
export function occurrencesAfter(
  ctx: AppContext,
  actor: Actor,
  name: EventName,
  args: { board_id?: string; thread_id?: string; channel?: string; labels?: Record<string, string>; state?: string },
  afterSeq: number,
  max = 50,
  minTime?: string,
): { events: Occurrence[]; lastSeq: number; hasMore: boolean } {
  const scope = cursorScope(name, actor, args);
  if (name === "inbox.item_created") {
    const params: unknown[] = [actor.id, afterSeq];
    let sql = "SELECT i.*, t.channel FROM inbox_items i JOIN threads t ON t.id = i.thread_id WHERE i.principal_id = ? AND i.seq > ?";
    if (args.board_id) {
      sql += " AND i.board_id = ?";
      params.push(args.board_id);
    }
    if (minTime) {
      sql += " AND i.created_at >= ?";
      params.push(minTime);
    }
    const rows = ctx.db.prepare(sql + " ORDER BY i.seq LIMIT ?").all(...params, max + 1) as (InboxRow & { channel: string })[];
    const scanned = rows.slice(0, max);
    // Items from channels the principal can no longer read are skipped; the cursor still moves past them.
    const access = new AccessCache(ctx, actor);
    const page = scanned.filter((r) => access.canRead(r.board_id, r.channel));
    const items = presentInbox(ctx, page);
    return {
      events: items.map((it, i) => {
        const b = getBoardRow(ctx, it.board_id);
        return {
          eventId: it.id,
          name,
          timestamp: it.created_at,
          data: { kind: it.kind, board_id: it.board_id, board_name: b?.name ?? "", thread: { id: it.thread_id, title: it.thread_title, url: threadUrl(ctx.config.publicUrl, it.board_id, it.thread_id) }, message: it.message },
          cursor: encodeCursor(scope.kind, scope.id, page[i]!.seq),
        };
      }),
      lastSeq: scanned.length ? scanned[scanned.length - 1]!.seq : afterSeq,
      hasMore: rows.length > max,
    };
  }
  const boardId = args.board_id!;
  const board = getBoardRow(ctx, boardId);
  const access = ChannelAccess.load(ctx, boardId, actor);
  const visible = (channel: string | undefined) => !!channel && access.can(channel, "read") && (!args.channel || channelMatches(args.channel, channel));
  const types = name === "board.message_created" ? ["message.created", "thread.created"] : ["thread.created", "thread.updated"];
  const params: unknown[] = [boardId, afterSeq, ...types];
  let sql = `SELECT * FROM events WHERE board_id = ? AND seq > ? AND type IN (${types.map(() => "?").join(",")})`;
  if (args.thread_id) {
    sql += " AND thread_id = ?";
    params.push(args.thread_id);
  }
  if (minTime) {
    sql += " AND created_at >= ?";
    params.push(minTime);
  }
  const rows = ctx.db.prepare(sql + " ORDER BY seq LIMIT ?").all(...params, max * 4 + 1) as EventRow[];
  const scanned = rows.slice(0, max * 4);
  const out: Occurrence[] = [];
  let lastSeq = afterSeq;
  for (const r of scanned) {
    lastSeq = r.seq;
    if (name === "board.message_created") {
      if (r.actor_id === actor.id || !r.message_id) continue;
      const m = ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(r.message_id) as MessageRow | undefined;
      const t = r.thread_id ? (ctx.db.prepare("SELECT id, title, channel FROM threads WHERE id = ?").get(r.thread_id) as { id: string; title: string; channel: string } | undefined) : undefined;
      if (!m || !t || m.deleted_at || !visible(t.channel)) continue;
      out.push({
        eventId: m.id,
        name,
        timestamp: r.created_at,
        data: { board_id: boardId, board_name: board?.name ?? "", thread: { id: t.id, title: t.title, url: threadUrl(ctx.config.publicUrl, boardId, t.id) }, message: presentMessages(ctx, [m])[0] },
        cursor: encodeCursor(scope.kind, scope.id, r.seq),
      });
    } else {
      if (r.actor_id === actor.id) continue;
      const row = r.thread_id ? (ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(r.thread_id) as ThreadRow | undefined) : undefined;
      if (!row || row.kind !== "task" || !visible(row.channel)) continue;
      const thread = presentThreads(ctx, [row], actor.id)[0]!;
      if (args.state && thread.task?.state !== args.state) continue;
      if (args.labels && !labelsMatch(thread, args.labels)) continue;
      const change = presentChanges(ctx, [r], actor.id)[0]!;
      out.push({
        eventId: `${row.id}-${r.seq}`,
        name,
        timestamp: r.created_at,
        data: { board_id: boardId, board_name: board?.name ?? "", thread, actor: change.actor },
        cursor: encodeCursor(scope.kind, scope.id, r.seq),
      });
    }
    if (out.length >= max) break;
  }
  return { events: out, lastSeq, hasMore: rows.length > scanned.length || out.length >= max };
}

function decodeEventCursor(ctx: AppContext, cursor: string | null | undefined, scope: { kind: "b" | "i"; id: string }): { seq: number; truncated: boolean } {
  if (cursor === null || cursor === undefined) return { seq: currentSeq(ctx, scope), truncated: false };
  let s: number;
  try {
    s = decodeCursor(cursor, scope.kind, scope.id).s;
  } catch {
    throw new EventsError(-32602, "Invalid cursor");
  }
  if (scope.kind === "b") {
    const purged = Number((ctx.db.prepare("SELECT value FROM meta WHERE key = 'events_purged_upto'").get() as { value: string }).value);
    if (s < purged) return { seq: purged, truncated: true };
  }
  return { seq: s, truncated: false };
}

const PollParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  maxEvents: z.number().int().positive().max(100).optional(),
});

export function pollEvents(ctx: AppContext, actor: Actor, raw: unknown) {
  const p = PollParams.safeParse(raw);
  if (!p.success) throw new EventsError(-32602, "Invalid params");
  const args = parseArgs(p.data.name, p.data.arguments);
  const name = p.data.name as EventName;
  authorize(ctx, actor, name, args);
  const scope = cursorScope(name, actor, args);
  const { seq, truncated } = decodeEventCursor(ctx, p.data.cursor, scope);
  const minTime = p.data.maxAgeMs ? new Date(ctx.now().getTime() - p.data.maxAgeMs).toISOString() : undefined;
  const r = occurrencesAfter(ctx, actor, name, args, seq, p.data.maxEvents ?? 50, minTime);
  // Quiet periods still advance the cursor so the next poll doesn't rescan skipped rows.
  const last = r.hasMore ? r.lastSeq : Math.max(r.lastSeq, scope.kind === "b" ? currentSeq(ctx, scope) : r.lastSeq);
  return { events: r.events, cursor: encodeCursor(scope.kind, scope.id, last), truncated, hasMore: r.hasMore, nextPollMs: r.hasMore ? 0 : 10_000 };
}

const SubscribeParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.object({ mode: z.literal("webhook"), url: z.string(), secret: z.string() }),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});

function validSecret(secret: string): boolean {
  if (!secret.startsWith("whsec_")) return false;
  try {
    const n = Buffer.from(secret.slice(6), "base64").length;
    return n >= 24 && n <= 64;
  } catch {
    return false;
  }
}

function argsKey(args: unknown): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
  return sha256(JSON.stringify(sort(args ?? {})));
}

export class EventSubscriptions {
  private timer: NodeJS.Timeout | null = null;
  private kick = false;
  private unsub: (() => void) | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  get policy(): CallbackPolicy {
    return { allowLoopbackHttp: this.ctx.config.testMode };
  }

  async subscribe(actor: Actor, raw: unknown) {
    const ctx = this.ctx;
    const p = SubscribeParams.safeParse(raw);
    if (!p.success) throw new EventsError(-32602, `Invalid params: ${p.error.issues[0]?.path.join(".") ?? ""} ${p.error.issues[0]?.message ?? ""}`.trim());
    const args = parseArgs(p.data.name, p.data.arguments);
    const name = p.data.name as EventName;
    authorize(ctx, actor, name, args);
    if (!validSecret(p.data.delivery.secret)) throw new EventsError(-32602, "delivery.secret must be whsec_ followed by base64 of 24 to 64 random bytes");
    let url: URL;
    try {
      url = validateCallbackUrl(p.data.delivery.url, this.policy);
    } catch (e) {
      throw new EventsError(-32602, (e as Error).message);
    }
    const key = argsKey(args);
    const existing = ctx.db.prepare("SELECT * FROM event_subscriptions WHERE principal_id = ? AND url = ? AND name = ? AND args_key = ?").get(actor.id, url.href, name, key) as
      | { id: string; status: string }
      | undefined;
    if (!existing || existing.status !== "active") {
      const mine = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE principal_id = ? AND status = 'active'").get(actor.id) as { n: number }).n;
      const perPrincipal = limitsFor(ctx, actor.id).webhook_subscriptions_per_principal;
      if (mine >= perPrincipal) {
        throw new EventsError(EVENT_ERRORS.ResourceExhausted, "Too many webhook subscriptions", { limit: "webhook_subscriptions_per_principal", max: perPrincipal });
      }
      if (args.board_id) {
        const onBoard = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_subscriptions WHERE board_id = ? AND status = 'active'").get(args.board_id) as { n: number }).n;
        const perBoard = boardLimits(ctx, args.board_id).webhook_subscriptions_per_board;
        if (onBoard >= perBoard) {
          throw new EventsError(EVENT_ERRORS.ResourceExhausted, "This board has too many webhook subscriptions", { limit: "webhook_subscriptions_per_board", max: perBoard });
        }
      }
    }
    const id = existing?.id ?? newId("sub");
    await this.verifyEndpoint(actor, url, p.data.delivery.secret, id);
    const scope = cursorScope(name, actor, args);
    const { seq, truncated } = decodeEventCursor(ctx, p.data.cursor, scope);
    const ttl = p.data.ttlMs === null ? MAX_TTL_MS : Math.min(p.data.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const refreshBefore = new Date(ctx.now().getTime() + ttl).toISOString();
    const now = nowIso(ctx);
    ctx.db
      .prepare(
        `INSERT INTO event_subscriptions (id, principal_id, board_id, name, arguments, args_key, url, secret_enc, cursor_seq, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(principal_id, url, name, args_key) DO UPDATE SET secret_enc = excluded.secret_enc, cursor_seq = excluded.cursor_seq,
           expires_at = excluded.expires_at, status = 'active', terminated_reason = NULL, updated_at = excluded.updated_at`,
      )
      .run(id, actor.id, args.board_id ?? null, name, JSON.stringify(args), key, url.href, encrypt(ctx.config.secret, p.data.delivery.secret), seq, refreshBefore, now, now);
    this.trigger();
    return { id, refreshBefore, cursor: encodeCursor(scope.kind, scope.id, seq), truncated };
  }

  unsubscribe(actor: Actor, raw: unknown) {
    const p = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), delivery: z.object({ url: z.string() }) }).safeParse(raw);
    if (!p.success) throw new EventsError(-32602, "Invalid params");
    const args = parseArgs(p.data.name, p.data.arguments);
    let href: string;
    try {
      href = new URL(p.data.delivery.url).href;
    } catch {
      throw new EventsError(-32602, "Invalid delivery.url");
    }
    // Idempotent: unsubscribing twice, or after the subscription expired or was terminated, succeeds.
    this.ctx.db.prepare("DELETE FROM event_subscriptions WHERE principal_id = ? AND url = ? AND name = ? AND args_key = ?").run(actor.id, href, p.data.name, argsKey(args));
    return {};
  }

  private async verifyEndpoint(actor: Actor, url: URL, secret: string, subscriptionId: string): Promise<void> {
    const cached = this.ctx.db.prepare("SELECT verified_at FROM webhook_verifications WHERE principal_id = ? AND url = ?").get(actor.id, url.href) as { verified_at: string } | undefined;
    if (cached && this.ctx.now().getTime() - Date.parse(cached.verified_at) < VERIFY_CACHE_MS) return;
    const challenge = randomBytes(24).toString("base64url");
    let res;
    try {
      res = await postSigned(url, JSON.stringify({ type: "verification", challenge }), { webhookId: newWebhookId(), secret, subscriptionId }, this.policy);
    } catch (e) {
      const reason = e instanceof CallbackError ? e.reason : "unreachable";
      throw new EventsError(EVENT_ERRORS.CallbackEndpointError, "The callback endpoint could not be verified", { reason });
    }
    let echoed = "";
    try {
      echoed = String((JSON.parse(res.body) as { challenge?: unknown }).challenge ?? "");
    } catch {
      echoed = res.body.trim();
    }
    const a = Buffer.from(echoed);
    const b = Buffer.from(challenge);
    if (res.status < 200 || res.status >= 300 || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new EventsError(EVENT_ERRORS.CallbackEndpointError, "The callback endpoint did not echo the verification challenge", { reason: "challenge_failed" });
    }
    this.ctx.db
      .prepare("INSERT INTO webhook_verifications (principal_id, url, verified_at) VALUES (?, ?, ?) ON CONFLICT(principal_id, url) DO UPDATE SET verified_at = excluded.verified_at")
      .run(actor.id, url.href, nowIso(this.ctx));
  }

  /** Starts the delivery worker; returns a stop function. */
  start(): () => void {
    this.unsub = this.ctx.hub.subscribe((e) => {
      if (e.kind === "board" || e.kind === "inbox" || e.kind === "grants") this.trigger();
      if (e.kind === "access" && e.reason !== "role_changed") this.terminateFor(e.boardId, e.principalId, e.reason === "disabled" ? "principal_disabled" : "access_ended");
      if (e.kind === "board_deleted") for (const s of this.ctx.db.prepare("SELECT * FROM event_subscriptions WHERE board_id = ? AND status = 'active'").all(e.boardId) as SubRow[]) this.queueTerminated(s, "board_deleted");
    });
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    return () => {
      this.unsub?.();
      if (this.timer) clearInterval(this.timer);
    };
  }

  trigger(): void {
    this.kick = true;
    setImmediate(() => void this.tick());
  }

  private terminateFor(boardId: string, principalId: string, reason: string): void {
    const subs = this.ctx.db.prepare("SELECT * FROM event_subscriptions WHERE board_id = ? AND principal_id = ? AND status = 'active'").all(boardId, principalId) as SubRow[];
    for (const s of subs) this.queueTerminated(s, reason);
  }

  private queueTerminated(s: SubRow, reason: string): void {
    const now = nowIso(this.ctx);
    this.ctx.db.prepare("UPDATE event_subscriptions SET status = 'terminated', terminated_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, s.id);
    const payload = JSON.stringify({ type: "terminated", error: { code: EVENT_ERRORS.Forbidden, message: "Forbidden", data: { reason } } });
    this.ctx.db
      .prepare("INSERT OR IGNORE INTO webhook_deliveries (id, subscription_id, webhook_id, event_id, payload, next_attempt_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(newId("dl"), s.id, `msg_terminated_${randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9_]/g, "_")}`, `terminated:${s.id}:${now}`, payload, now, now);
    this.trigger();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      do {
        this.kick = false;
        this.enqueue();
        await this.deliverDue();
      } while (this.kick);
    } catch (e) {
      console.error("event delivery failed", e);
    } finally {
      this.running = false;
    }
  }

  private enqueue(): void {
    const ctx = this.ctx;
    const now = nowIso(ctx);
    for (const s of ctx.db.prepare("SELECT * FROM event_subscriptions WHERE status = 'active'").all() as SubRow[]) {
      if (s.expires_at && s.expires_at <= now) {
        ctx.db.prepare("UPDATE event_subscriptions SET status = 'terminated', terminated_reason = 'expired', updated_at = ? WHERE id = ?").run(now, s.id);
        continue;
      }
      const principal = getPrincipal(ctx, s.principal_id);
      if (!principal || principal.disabled_at) {
        this.queueTerminated(s, "principal_disabled");
        continue;
      }
      const actor = actorFromPrincipal(principal, "system");
      if (s.board_id && !activeMembership(ctx, s.board_id, actor)) {
        this.queueTerminated(s, "access_ended");
        continue;
      }
      const args = JSON.parse(s.arguments) as Record<string, string>;
      const r = occurrencesAfter(ctx, actor, s.name as EventName, args, s.cursor_seq, 50);
      ctx.db.transaction(() => {
        for (const ev of r.events) {
          ctx.db
            .prepare("INSERT OR IGNORE INTO webhook_deliveries (id, subscription_id, webhook_id, event_id, payload, next_attempt_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
            .run(newId("dl"), s.id, ev.eventId.replace(/[^A-Za-z0-9_-]/g, "_"), ev.eventId, JSON.stringify(ev), now, now);
        }
        if (r.lastSeq !== s.cursor_seq) ctx.db.prepare("UPDATE event_subscriptions SET cursor_seq = ? WHERE id = ?").run(r.lastSeq, s.id);
      })();
      if (r.hasMore) this.kick = true;
    }
  }

  private async deliverDue(): Promise<void> {
    const ctx = this.ctx;
    const due = ctx.db
      .prepare(
        `SELECT d.*, s.url, s.secret_enc FROM webhook_deliveries d JOIN event_subscriptions s ON s.id = d.subscription_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.created_at LIMIT 50`,
      )
      .all(nowIso(ctx)) as (DeliveryRow & { url: string; secret_enc: string })[];
    await Promise.all(
      due.map(async (d) => {
        let status: "delivered" | "failed" | "pending" = "pending";
        let error: string | null = null;
        try {
          const res = await postSigned(new URL(d.url), d.payload, { webhookId: d.webhook_id, secret: decrypt(ctx.config.secret, d.secret_enc), subscriptionId: d.subscription_id }, this.policy);
          if (res.status >= 200 && res.status < 300) status = "delivered";
          else if (res.status === 410 || res.status === 413) {
            status = "failed";
            error = `HTTP ${res.status}`;
            if (res.status === 410) ctx.db.prepare("UPDATE event_subscriptions SET status = 'terminated', terminated_reason = 'gone', updated_at = ? WHERE id = ?").run(nowIso(ctx), d.subscription_id);
          } else error = `HTTP ${res.status}`;
        } catch (e) {
          error = e instanceof CallbackError ? e.reason : "unreachable";
        }
        const attempts = d.attempts + 1;
        if (status === "pending" && attempts >= 10) status = "failed";
        const backoff = Math.min(2 ** attempts * 1000, 3_600_000);
        ctx.db
          .prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
          .run(status, attempts, error, new Date(ctx.now().getTime() + backoff).toISOString(), d.id);
      }),
    );
    ctx.db.prepare("DELETE FROM webhook_deliveries WHERE status != 'pending' AND created_at < ?").run(new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString());
  }
}

interface SubRow {
  id: string;
  principal_id: string;
  board_id: string | null;
  name: string;
  arguments: string;
  url: string;
  secret_enc: string;
  cursor_seq: number;
  expires_at: string | null;
  status: string;
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  webhook_id: string;
  event_id: string;
  payload: string;
  attempts: number;
}
