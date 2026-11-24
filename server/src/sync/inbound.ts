import type { MessageSource } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { actorFromPrincipal, getPrincipal, nowIso } from "../domain/access.js";
import { recordEvent } from "../domain/boards.js";
import { reply, startThread } from "../domain/conversation.js";
import type { Actor } from "../domain/model.js";
import { OmbError } from "../errors.js";
import { newId, sha256 } from "../ids.js";
import {
  PLATFORM_LABEL,
  isDuplicateSource,
  linkByExternalId,
  linkByRef,
  recordIntegrationActivity,
  recordIntegrationError,
  sourceMessageExists,
  type LinkRow,
  type LoadedIntegration,
} from "./store.js";
import { fitBody, titleFrom } from "./text.js";
import type { WebhookResult } from "./types.js";

export const ok = (extra: Record<string, unknown> = {}): WebhookResult => ({ status: 200, body: { ok: true, ...extra } });
export const ignored = (reason: string): WebhookResult => ok({ ignored: reason });

/** The principal that authors everything arriving through this integration. */
export function integrationActor(ctx: AppContext, ig: LoadedIntegration): Actor | null {
  const p = getPrincipal(ctx, ig.row.principal_id);
  if (!p || p.disabled_at) return null;
  return actorFromPrincipal(p, "system");
}

/**
 * Board write failures become a 200 with `last_error` recorded, so platforms don't retry forever.
 * `rate_limited` is temporary, so it returns 429 and the platform's own retry delivers it later.
 */
function writeFailed(ctx: AppContext, ig: LoadedIntegration, e: unknown): WebhookResult {
  if (isDuplicateSource(e)) return ok({ duplicate: true });
  if (e instanceof OmbError) {
    recordIntegrationError(ctx, ig.row.id, `A ${PLATFORM_LABEL[ig.row.platform]} message wasn't added to the board: ${e.message}`);
    if (e.code === "rate_limited") {
      const ms = Number(e.details?.retry_after_ms ?? 60_000);
      return { status: 429, body: { ok: false, error: e.code }, headers: { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) } };
    }
    return ok({ skipped: e.code });
  }
  throw e;
}

/** Adds an inbound comment or threaded reply to the linked board thread. Retries are no-ops. */
export function postInboundReply(ctx: AppContext, ig: LoadedIntegration, link: LinkRow, input: { body: string; source: MessageSource }): WebhookResult {
  if (sourceMessageExists(ctx, link.thread_id, input.source.platform, input.source.external_id)) return ok({ duplicate: true });
  const body = fitBody(ctx, input.body);
  if (!body.trim()) return ignored("empty");
  const actor = integrationActor(ctx, ig);
  if (!actor) {
    recordIntegrationError(ctx, ig.row.id, "The integration's board member was removed; delete and re-add the integration");
    return ignored("no_member");
  }
  try {
    const { message } = reply(ctx, actor, link.thread_id, { body }, { source: input.source });
    recordIntegrationActivity(ctx, ig.row.id, { clearError: true });
    return ok({ message_id: message.id });
  } catch (e) {
    return writeFailed(ctx, ig, e);
  }
}

export interface InboundThreadInput {
  title: string;
  body: string;
  source: MessageSource;
  /** Reference stored on the new link (Slack channel/ts, owner/repo#n, Linear identifier). */
  externalRef: string;
  externalId: string | null;
  url: string | null;
}

/** Starts a board thread for a new external thread or issue and links the two. Retries are no-ops. */
export function createInboundThread(ctx: AppContext, ig: LoadedIntegration, input: InboundThreadInput): WebhookResult {
  if (linkByRef(ctx, ig.row.id, input.externalRef) || (input.externalId && linkByExternalId(ctx, ig.row.id, input.externalId))) {
    return ok({ duplicate: true });
  }
  const body = fitBody(ctx, input.body);
  if (!body.trim()) return ignored("empty");
  const actor = integrationActor(ctx, ig);
  if (!actor) {
    recordIntegrationError(ctx, ig.row.id, "The integration's board member was removed; delete and re-add the integration");
    return ignored("no_member");
  }
  // Same key for a redelivered event, so a retry returns the thread created the first time.
  const idempotencyKey = "sync-" + sha256(`${ig.row.id}:${input.externalRef}`).slice(0, 40);
  try {
    const channel = typeof ig.config.channel === "string" ? ig.config.channel : undefined;
    const { thread } = startThread(ctx, actor, ig.row.board_id, { title: titleFrom(input.title), body, idempotency_key: idempotencyKey, ...(channel ? { channel } : {}) }, { source: input.source });
    tx(ctx, (emit) => {
      const info = ctx.db
        .prepare(
          `INSERT INTO thread_links (id, thread_id, integration_id, external_ref, url, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(newId("lnk"), thread.id, ig.row.id, input.externalRef, input.url, input.externalId, nowIso(ctx));
      if (info.changes > 0) recordEvent(ctx, emit, { boardId: ig.row.board_id, type: "thread.updated", threadId: thread.id, actorId: actor.id });
    });
    recordIntegrationActivity(ctx, ig.row.id, { clearError: true });
    return ok({ thread_id: thread.id });
  } catch (e) {
    return writeFailed(ctx, ig, e);
  }
}
