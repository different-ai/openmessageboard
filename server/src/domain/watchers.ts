/**
 * Watchers: board automation owned by the board owner. Each change on the board that matches the watcher's
 * filter is POSTed to its URL as `{"type": "change", "watcher_id", "change"}`, signed with Standard Webhooks,
 * through the same outbound code as MCP Events webhooks (HTTPS only outside test mode, private addresses
 * refused at every connection, no redirects).
 *
 * Changes are read with the owner's own view of the board (`boardChanges` as the owner), so a watcher never
 * delivers a change its owner could not read. Deliveries are queued in the database, retried with backoff and
 * survive restarts. A watcher stops when its owner no longer owns the board or is disabled.
 */
import { isIP } from "node:net";
import type { Change, Watcher, WatcherFilter } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { read, tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import { decrypt, encrypt, newId } from "../ids.js";
import { CallbackError, isLoopbackAddress, isPrivateAddress, isWebhookSecret, postSigned, validateCallbackUrl, verifyChallenge, type CallbackPolicy } from "../mcp/webhook-http.js";
import { actorFromPrincipal, getPrincipal, nowIso, requireMember } from "./access.js";
import { boardChanges } from "./changes.js";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isEmptyFilter, resolveFilter, resolveMember, resolveThreadRef, type FilterInput } from "./filters.js";
import type { Actor } from "./model.js";
import { boardLimits } from "./plans.js";
import { refOf } from "./present.js";

interface WatcherRow {
  id: string;
  board_id: string;
  owner_id: string;
  url: string;
  secret_enc: string;
  filter: string;
  cursor_seq: number;
  status: "active" | "stopped";
  stopped_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  watcher_id: string;
  change_seq: number;
  change_type: string;
  webhook_id: string;
  payload: string;
  attempts: number;
  status: "pending" | "delivered" | "failed";
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export const WATCHER_MAX_ATTEMPTS = 10;
const RECENT_DELIVERIES = 5;
const KEEP_DELIVERIES_MS = 7 * 86_400_000;

function policyOf(ctx: AppContext): CallbackPolicy {
  return { allowLoopbackHttp: ctx.config.testMode };
}

function filterInputOf(f: WatcherFilter): FilterInput {
  return { by: f.by, mentions: f.mentions, labels: f.labels, text: f.text, source: f.source, re: f.thread, types: f.types };
}

/** Validates a filter and stores handles as principal IDs and the thread as a thread ID. */
function normalizeFilter(ctx: AppContext, actor: Actor, boardId: string, f: WatcherFilter): WatcherFilter {
  const out: WatcherFilter = {};
  if (f.thread !== undefined) out.thread = resolveThreadRef(ctx, boardId, f.thread);
  if (f.types !== undefined) out.types = [...new Set(f.types)];
  if (f.by !== undefined) out.by = resolveMember(ctx, actor, boardId, f.by, "filter.by");
  if (f.mentions !== undefined) out.mentions = resolveMember(ctx, actor, boardId, f.mentions, "filter.mentions");
  if (f.labels !== undefined && Object.keys(f.labels).length) out.labels = f.labels;
  if (f.text !== undefined) out.text = f.text.trim();
  if (f.source !== undefined) out.source = f.source;
  resolveFilter(ctx, actor, boardId, filterInputOf(out));
  return out;
}

function requireBoardOwner(ctx: AppContext, actor: Actor, boardId: string, what = "Board"): void {
  const { board } = requireMember(ctx, actor, boardId, "owner", what);
  if (board.owner_id !== actor.id) throw forbidden("Only the board owner can manage watchers");
}

function presentWatchers(ctx: AppContext, rows: WatcherRow[]): Watcher[] {
  return rows.map((w) => {
    const recent = ctx.db
      .prepare("SELECT * FROM watcher_deliveries WHERE watcher_id = ? ORDER BY created_at DESC, change_seq DESC LIMIT ?")
      .all(w.id, RECENT_DELIVERIES) as DeliveryRow[];
    return {
      id: w.id,
      board_id: w.board_id,
      url: w.url,
      filter: JSON.parse(w.filter) as WatcherFilter,
      created_by: refOf(ctx, w.owner_id),
      created_at: w.created_at,
      status: w.status,
      stopped_reason: w.stopped_reason,
      recent_deliveries: recent.map((d) => ({
        id: d.id,
        change_seq: d.change_seq,
        change_type: d.change_type as Change["type"],
        status: d.status,
        attempts: d.attempts,
        last_error: d.last_error,
        created_at: d.created_at,
        delivered_at: d.delivered_at,
      })),
    };
  });
}

function assertCapacity(ctx: AppContext, boardId: string): void {
  const used = (ctx.db.prepare("SELECT COUNT(*) AS n FROM watchers WHERE board_id = ? AND status = 'active'").get(boardId) as { n: number }).n;
  const limit = boardLimits(ctx, boardId).watchers_per_board;
  if (used >= limit) {
    throw new OmbError("quota_exceeded", `This board has ${limit} active watchers, its limit. Delete one to add another.`, {
      allowance: "watchers",
      used,
      limit,
      resets_at: null,
    });
  }
}

export async function createWatcher(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  input: { url: string; secret: string; filter?: WatcherFilter | undefined },
): Promise<{ watcher: Watcher }> {
  requireBoardOwner(ctx, actor, boardId);
  if (!isWebhookSecret(input.secret)) throw invalid("secret must be whsec_ followed by base64 of 24 to 64 random bytes", { reason: "invalid_secret" });
  const policy = policyOf(ctx);
  let url: URL;
  try {
    url = validateCallbackUrl(input.url, policy);
  } catch (e) {
    throw invalid((e as Error).message.replace("delivery.url", "url"), { reason: "invalid_url" });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host) && !(policy.allowLoopbackHttp && isLoopbackAddress(host))) {
    throw invalid("url points at a private or reserved address", { reason: "blocked_address" });
  }
  const filter = normalizeFilter(ctx, actor, boardId, input.filter ?? {});
  ctx.rate.hit(`w:p:${actor.id}`, ctx.config.rateLimits.writes_per_minute_principal, 60_000);
  assertCapacity(ctx, boardId);
  const id = newId("wch");
  try {
    await verifyChallenge(url, input.secret, { watcherId: id }, policy);
  } catch (e) {
    const reason = e instanceof CallbackError ? (e.reason === "private_address" ? "blocked_address" : e.reason) : "unreachable";
    throw invalid(reason === "blocked_address" ? "url resolves to a private or reserved address" : "The URL did not answer the verification challenge", { reason });
  }
  return tx(ctx, () => {
    requireBoardOwner(ctx, actor, boardId);
    assertCapacity(ctx, boardId);
    const now = nowIso(ctx);
    const seq = (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
    ctx.db
      .prepare(
        `INSERT INTO watchers (id, board_id, owner_id, url, secret_enc, filter, cursor_seq, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, boardId, actor.id, url.href, encrypt(ctx.config.secret, input.secret), JSON.stringify(filter), seq, now, now);
    return { watcher: presentWatchers(ctx, [ctx.db.prepare("SELECT * FROM watchers WHERE id = ?").get(id) as WatcherRow])[0]! };
  });
}

export function listWatchers(ctx: AppContext, actor: Actor, boardId: string): { watchers: Watcher[] } {
  return read(ctx, () => {
    requireBoardOwner(ctx, actor, boardId);
    const rows = ctx.db.prepare("SELECT * FROM watchers WHERE board_id = ? ORDER BY created_at, id").all(boardId) as WatcherRow[];
    return { watchers: presentWatchers(ctx, rows) };
  });
}

export function deleteWatcher(ctx: AppContext, actor: Actor, watcherId: string): { watcher_id: string; deleted: boolean } {
  return tx(ctx, () => {
    const row = ctx.db.prepare("SELECT * FROM watchers WHERE id = ?").get(watcherId) as WatcherRow | undefined;
    if (!row) throw notFound("Watcher");
    requireBoardOwner(ctx, actor, row.board_id, "Watcher");
    ctx.db.prepare("DELETE FROM watchers WHERE id = ?").run(row.id);
    return { watcher_id: row.id, deleted: true };
  });
}

/** Delivers matching changes to every active watcher. Returns a stop function from `start()`. */
export class WatcherWorker {
  private timer: NodeJS.Timeout | null = null;
  private unsub: (() => void) | null = null;
  private running = false;
  private kick = false;

  constructor(private readonly ctx: AppContext) {}

  start(): () => void {
    this.unsub = this.ctx.hub.subscribe((e) => {
      if (e.kind === "board" || e.kind === "access") this.trigger();
    });
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    this.trigger();
    return () => {
      this.unsub?.();
      if (this.timer) clearInterval(this.timer);
    };
  }

  trigger(): void {
    this.kick = true;
    setImmediate(() => void this.tick());
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
      console.error("watcher delivery failed", e);
    } finally {
      this.running = false;
    }
  }

  private stopWatcher(id: string, reason: string): void {
    this.ctx.db.prepare("UPDATE watchers SET status = 'stopped', stopped_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(reason, nowIso(this.ctx), id);
  }

  /** Queues every new matching change for each active watcher and advances its cursor, in one transaction each. */
  enqueue(): void {
    const ctx = this.ctx;
    for (const w of ctx.db.prepare("SELECT * FROM watchers WHERE status = 'active'").all() as WatcherRow[]) {
      const board = ctx.db.prepare("SELECT owner_id, disabled_at FROM boards WHERE id = ?").get(w.board_id) as { owner_id: string; disabled_at: string | null } | undefined;
      if (!board) continue;
      if (board.disabled_at) {
        this.stopWatcher(w.id, "board_disabled");
        continue;
      }
      if (board.owner_id !== w.owner_id) {
        this.stopWatcher(w.id, "ownership_ended");
        continue;
      }
      const owner = getPrincipal(ctx, w.owner_id);
      if (!owner || owner.disabled_at) {
        this.stopWatcher(w.id, "principal_disabled");
        continue;
      }
      const actor = actorFromPrincipal(owner, "system");
      let changes: Change[];
      let next: number;
      let more: boolean;
      try {
        const filter = resolveFilter(ctx, actor, w.board_id, filterInputOf(JSON.parse(w.filter) as WatcherFilter));
        const page = boardChanges(ctx, actor, w.board_id, encodeCursor("b", w.board_id, w.cursor_seq), 100, undefined, isEmptyFilter(filter) ? undefined : filter);
        changes = page.changes;
        next = decodeCursor(page.cursor, "b", w.board_id).s;
        more = page.has_more;
      } catch (e) {
        if (e instanceof OmbError && e.code === "cursor_expired") {
          const purged = Number((ctx.db.prepare("SELECT value FROM meta WHERE key = 'events_purged_upto'").get() as { value: string }).value);
          ctx.db.prepare("UPDATE watchers SET cursor_seq = ? WHERE id = ?").run(purged, w.id);
          continue;
        }
        if (e instanceof OmbError && (e.code === "not_found" || e.code === "access_ended" || e.code === "forbidden")) {
          this.stopWatcher(w.id, "access_ended");
          continue;
        }
        if (e instanceof OmbError && e.code === "invalid_argument") {
          this.stopWatcher(w.id, "invalid_filter");
          continue;
        }
        throw e;
      }
      const now = nowIso(ctx);
      ctx.db.transaction(() => {
        for (const change of changes) {
          ctx.db
            .prepare(
              `INSERT OR IGNORE INTO watcher_deliveries (id, watcher_id, change_seq, change_type, webhook_id, payload, next_attempt_at, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
            )
            .run(newId("wdl"), w.id, change.seq, change.type, `${w.id}_${change.seq}`, JSON.stringify({ type: "change", watcher_id: w.id, change }), now, now);
        }
        if (next !== w.cursor_seq) ctx.db.prepare("UPDATE watchers SET cursor_seq = ? WHERE id = ? AND status = 'active'").run(next, w.id);
      })();
      if (more) this.kick = true;
    }
  }

  async deliverDue(): Promise<void> {
    const ctx = this.ctx;
    const policy = policyOf(ctx);
    const due = ctx.db
      .prepare(
        `SELECT d.*, w.url, w.secret_enc, w.status AS watcher_status FROM watcher_deliveries d JOIN watchers w ON w.id = d.watcher_id
         WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.created_at, d.change_seq LIMIT 50`,
      )
      .all(nowIso(ctx)) as (DeliveryRow & { url: string; secret_enc: string; watcher_status: string })[];
    await Promise.all(
      due.map(async (d) => {
        if (d.watcher_status !== "active") {
          ctx.db.prepare("UPDATE watcher_deliveries SET status = 'failed', last_error = 'watcher_stopped' WHERE id = ?").run(d.id);
          return;
        }
        let status: "delivered" | "failed" | "pending" = "pending";
        let error: string | null = null;
        try {
          const res = await postSigned(new URL(d.url), d.payload, { webhookId: d.webhook_id, secret: decrypt(ctx.config.secret, d.secret_enc), watcherId: d.watcher_id }, policy);
          if (res.status >= 200 && res.status < 300) status = "delivered";
          else if (res.status === 410 || res.status === 413) {
            status = "failed";
            error = `HTTP ${res.status}`;
            if (res.status === 410) this.stopWatcher(d.watcher_id, "gone");
          } else error = `HTTP ${res.status}`;
        } catch (e) {
          error = e instanceof CallbackError ? e.reason : "unreachable";
        }
        const attempts = d.attempts + 1;
        if (status === "pending" && attempts >= WATCHER_MAX_ATTEMPTS) status = "failed";
        // Exponential backoff with jitter, capped at an hour.
        const backoff = Math.min(2 ** attempts * 1000, 3_600_000) * (0.5 + Math.random() / 2);
        const now = ctx.now();
        ctx.db
          .prepare("UPDATE watcher_deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, delivered_at = ? WHERE id = ?")
          .run(status, attempts, error, new Date(now.getTime() + backoff).toISOString(), status === "delivered" ? now.toISOString() : null, d.id);
      }),
    );
    ctx.db.prepare("DELETE FROM watcher_deliveries WHERE status != 'pending' AND created_at < ?").run(new Date(ctx.now().getTime() - KEEP_DELIVERIES_MS).toISOString());
  }
}
