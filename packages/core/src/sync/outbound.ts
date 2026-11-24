import type { SyncPlatform } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { nowIso } from "../domain/access.js";
import type { MessageRow, ThreadRow } from "../domain/model.js";
import type { HubEvent } from "../live/hub.js";
import { errorText, SyncHttpError } from "./http.js";
import { ADAPTERS } from "./platforms.js";
import { syncOptions } from "./settings.js";
import { PLATFORM_LABEL, loadIntegration, recordIntegrationActivity, recordIntegrationError, type IntegrationRow, type LinkRow } from "./store.js";
import { outboundMessage } from "./text.js";

/**
 * Queues one delivery per linked external thread for a new board message, except back to the
 * integration it arrived through. Returns the number queued.
 */
export function enqueueMessage(ctx: AppContext, messageId: string): number {
  const m = ctx.db.prepare("SELECT id, thread_id, author_id, source_platform, deleted_at FROM messages WHERE id = ?").get(messageId) as
    | Pick<MessageRow, "id" | "thread_id" | "author_id" | "source_platform" | "deleted_at">
    | undefined;
  if (!m || m.deleted_at) return 0;
  const links = ctx.db
    .prepare(
      `SELECT l.id, i.platform, i.principal_id FROM thread_links l JOIN integrations i ON i.id = l.integration_id
       WHERE l.thread_id = ? AND i.disabled_at IS NULL`,
    )
    .all(m.thread_id) as { id: string; platform: SyncPlatform; principal_id: string }[];
  const now = nowIso(ctx);
  let queued = 0;
  for (const link of links) {
    if (m.source_platform === link.platform && m.author_id === link.principal_id) continue;
    queued += ctx.db
      .prepare(
        `INSERT INTO sync_outbound (message_id, link_id, external_id, status, attempts, last_error, created_at, next_attempt_at)
         VALUES (?, ?, NULL, 'pending', 0, NULL, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(m.id, link.id, now, now).changes;
  }
  return queued;
}

interface DueRow {
  message_id: string;
  link_id: string;
  attempts: number;
}

/** The oldest pending delivery of each link, if due. Later messages wait so each external thread stays in order. */
function dueHeads(ctx: AppContext, limit: number): DueRow[] {
  return ctx.db
    .prepare(
      `SELECT o.message_id, o.link_id, o.attempts FROM sync_outbound o JOIN messages m ON m.id = o.message_id
       WHERE o.status = 'pending' AND COALESCE(o.next_attempt_at, o.created_at) <= ?
         AND NOT EXISTS (
           SELECT 1 FROM sync_outbound o2 JOIN messages m2 ON m2.id = o2.message_id
           WHERE o2.link_id = o.link_id AND o2.status = 'pending'
             AND (m2.created_at < m.created_at OR (m2.created_at = m.created_at AND m2.id < m.id)))
       ORDER BY m.created_at, m.id LIMIT ?`,
    )
    .all(nowIso(ctx), limit) as DueRow[];
}

type Outcome = "sent" | "retry" | "failed";

function markFailed(ctx: AppContext, row: DueRow, attempts: number, error: string): void {
  ctx.db
    .prepare("UPDATE sync_outbound SET status = 'failed', attempts = ?, last_error = ? WHERE message_id = ? AND link_id = ?")
    .run(attempts, error, row.message_id, row.link_id);
}

async function deliver(ctx: AppContext, row: DueRow): Promise<Outcome> {
  const link = ctx.db.prepare("SELECT * FROM thread_links WHERE id = ?").get(row.link_id) as LinkRow | undefined;
  const integration = link ? (ctx.db.prepare("SELECT * FROM integrations WHERE id = ?").get(link.integration_id) as IntegrationRow | undefined) : undefined;
  const message = ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(row.message_id) as MessageRow | undefined;
  const thread = message ? (ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(message.thread_id) as ThreadRow | undefined) : undefined;
  if (!link || !integration || integration.disabled_at || !message || !thread) {
    markFailed(ctx, row, row.attempts, "The link or integration was removed");
    return "failed";
  }
  if (message.deleted_at || message.body === null) {
    markFailed(ctx, row, row.attempts, "The message was deleted before it was sent");
    return "failed";
  }
  const label = PLATFORM_LABEL[integration.platform];
  const attempts = row.attempts + 1;
  try {
    const ig = loadIntegration(ctx, integration);
    const { externalId } = await ADAPTERS[integration.platform].send(ctx, ig, link, outboundMessage(ctx, message, thread));
    ctx.db
      .prepare("UPDATE sync_outbound SET status = 'sent', attempts = ?, external_id = ?, last_error = NULL WHERE message_id = ? AND link_id = ?")
      .run(attempts, externalId, row.message_id, row.link_id);
    recordIntegrationActivity(ctx, integration.id, { clearError: true });
    return "sent";
  } catch (e) {
    const err = e instanceof SyncHttpError ? e : null;
    const text = errorText(e);
    recordIntegrationError(ctx, integration.id, `A message couldn't be sent to ${label}: ${text}`);
    const opts = syncOptions();
    if (!err?.retryable || attempts >= opts.maxAttempts) {
      markFailed(ctx, row, attempts, text);
      return "failed";
    }
    const delay = Math.max(err.retryAfterMs ?? 0, opts.retryBaseMs * 2 ** (attempts - 1));
    ctx.db
      .prepare("UPDATE sync_outbound SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE message_id = ? AND link_id = ?")
      .run(attempts, text, new Date(ctx.now().getTime() + delay).toISOString(), row.message_id, row.link_id);
    return "retry";
  }
}

async function runPass(ctx: AppContext): Promise<number> {
  let sent = 0;
  for (let round = 0; round < 50; round++) {
    const due = dueHeads(ctx, 25);
    if (due.length === 0) break;
    // Each row is the head of a different link, so they can go out in parallel without reordering.
    const outcomes = await Promise.all(due.map((row) => deliver(ctx, row)));
    sent += outcomes.filter((o) => o === "sent").length;
    if (outcomes.every((o) => o === "retry")) break;
  }
  return sent;
}

const chains = new WeakMap<AppContext, Promise<unknown>>();

/** Sends every due delivery once. Passes for the same context run one at a time. Returns the number sent. */
export function processOutbound(ctx: AppContext): Promise<number> {
  const prev = chains.get(ctx) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => runPass(ctx));
  chains.set(ctx, next);
  return next;
}

/**
 * Starts outbound sync: listens for new board messages, queues them for linked Slack threads,
 * GitHub issues and Linear issues, and runs the delivery worker. Returns a stop function.
 */
export function startSync(ctx: AppContext): () => void {
  let stopped = false;
  let kicked = false;
  let inFlight = 0;

  const run = () => {
    inFlight++;
    processOutbound(ctx)
      .catch((e) => console.error("sync: outbound pass failed:", e instanceof Error ? e.name : "error"))
      .finally(() => inFlight--);
  };
  const kick = () => {
    if (stopped || kicked) return;
    kicked = true;
    setImmediate(() => {
      kicked = false;
      if (!stopped) run();
    });
  };

  const unsubscribe = ctx.hub.subscribe((e: HubEvent) => {
    if (e.kind !== "board" || !e.messageId || (e.type !== "message.created" && e.type !== "thread.created")) return;
    try {
      if (enqueueMessage(ctx, e.messageId) > 0) kick();
    } catch (err) {
      console.error("sync: couldn't queue a message:", err instanceof Error ? err.name : "error");
    }
  });
  const timer = setInterval(() => {
    if (!stopped && inFlight === 0) run();
  }, syncOptions().intervalMs);
  timer.unref?.();
  kick();

  return () => {
    stopped = true;
    unsubscribe();
    clearInterval(timer);
  };
}
