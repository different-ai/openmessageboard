import { CreateIntegrationBody, LinkThreadBody, SYNC_PLATFORMS } from "@openmessageboard/protocol";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { tx } from "../context.js";
import { getPrincipal, nowIso, requireMember, requireThread } from "../domain/access.js";
import { addManagedMember, recordEvent, removeMembershipCascade } from "../domain/boards.js";
import type { MessageRow } from "../domain/model.js";
import { OmbError, notFound } from "../errors.js";
import { encrypt, newId, randomToken } from "../ids.js";
import { parseBody, requireActor, type RouteModule } from "../http/util.js";
import { platformError } from "./http.js";
import { ADAPTERS } from "./platforms.js";
import {
  PLATFORM_LABEL,
  forgetIntegrationCaches,
  getIntegrationRow,
  integrationByToken,
  linkByRef,
  linkForThread,
  loadIntegration,
  presentIntegration,
  presentLink,
  recordIntegrationError,
  type IntegrationRow,
  type LinkRow,
} from "./store.js";
import { outboundMessage } from "./text.js";
import type { CreatedCounterpart, ResolvedRef } from "./types.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const NOUN = { slack: "thread", github: "issue", linear: "issue" } as const;

/** Integration management, thread links, and the inbound webhooks for Slack, GitHub and Linear. */
export const registerSyncRoutes: RouteModule = (app, ctx) => {
  app.get("/api/boards/:boardId/integrations", (c) => {
    const actor = requireActor(c);
    const { board } = requireMember(ctx, actor, c.req.param("boardId"), "owner");
    const rows = ctx.db.prepare("SELECT * FROM integrations WHERE board_id = ? AND disabled_at IS NULL ORDER BY created_at DESC, id DESC").all(board.id) as IntegrationRow[];
    return c.json({ integrations: rows.map((r) => presentIntegration(ctx, r)) });
  });

  app.post("/api/boards/:boardId/integrations", async (c) => {
    const actor = requireActor(c);
    const boardId = c.req.param("boardId");
    const input = await parseBody(c, CreateIntegrationBody);
    requireMember(ctx, actor, boardId, "owner");
    const setup = ADAPTERS[input.platform].parseSetup(input.config, input.secrets);
    const label = PLATFORM_LABEL[input.platform];
    const row = tx(ctx, (emit) => {
      const { board } = requireMember(ctx, actor, boardId, "owner");
      const now = nowIso(ctx);
      const principalId = newId("p");
      ctx.db
        .prepare("INSERT INTO principals (id, kind, display_name, email, owner_id, created_at) VALUES (?, 'integration', ?, NULL, ?, ?)")
        .run(principalId, `${label} sync`, actor.id, now);
      addManagedMember(ctx, emit, board.id, getPrincipal(ctx, principalId)!, "contributor", actor.id);
      const id = newId("int");
      ctx.db
        .prepare(
          `INSERT INTO integrations (id, board_id, platform, name, config, secrets_enc, principal_id, webhook_token, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          board.id,
          input.platform,
          input.name.trim() || label,
          JSON.stringify(setup.config),
          encrypt(ctx.config.secret, JSON.stringify(setup.secrets)),
          principalId,
          randomToken(24),
          actor.id,
          now,
        );
      return getIntegrationRow(ctx, id)!;
    });
    return c.json({ integration: presentIntegration(ctx, row) });
  });

  app.delete("/api/integrations/:integrationId", (c) => {
    const actor = requireActor(c);
    const id = c.req.param("integrationId");
    tx(ctx, (emit) => {
      const row = getIntegrationRow(ctx, id);
      if (!row) throw notFound("Integration");
      requireMember(ctx, actor, row.board_id, "owner", "Integration");
      const threads = (ctx.db.prepare("SELECT DISTINCT thread_id FROM thread_links WHERE integration_id = ?").all(row.id) as { thread_id: string }[]).map(
        (r) => r.thread_id,
      );
      removeMembershipCascade(ctx, emit, row.board_id, row.principal_id, actor.id, "removed");
      ctx.db.prepare("DELETE FROM integrations WHERE id = ?").run(row.id);
      // The principal stays (disabled) because it authored the messages that already synced.
      ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(nowIso(ctx), row.principal_id);
      for (const threadId of threads) recordEvent(ctx, emit, { boardId: row.board_id, type: "thread.updated", threadId, actorId: actor.id });
    });
    forgetIntegrationCaches(id);
    return c.json({ deleted: true });
  });

  app.post("/api/threads/:threadId/links", async (c) => {
    const actor = requireActor(c);
    const threadId = c.req.param("threadId");
    const input = await parseBody(c, LinkThreadBody);
    const { thread } = requireThread(ctx, actor, threadId, "owner");
    const row = getIntegrationRow(ctx, input.integration_id);
    if (!row || row.board_id !== thread.board_id || row.disabled_at) throw notFound("Integration");
    const label = PLATFORM_LABEL[row.platform];
    const ref = input.external_ref?.trim() || undefined;

    const existing = linkForThread(ctx, thread.id, row.id);
    if (existing) {
      if (ref && ref.toLowerCase() === existing.external_ref.toLowerCase()) return c.json({ link: presentLink(row.platform, existing) });
      throw new OmbError("conflict", `This thread is already linked to ${existing.external_ref} through ${row.name}; unlink it first`);
    }

    const ig = loadIntegration(ctx, row);
    const adapter = ADAPTERS[row.platform];
    let resolved: ResolvedRef | CreatedCounterpart;
    let rootId: string | null = null;
    try {
      if (ref) {
        resolved = await adapter.resolveRef(ctx, ig, ref);
      } else {
        const root = ctx.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1").get(thread.id) as MessageRow | undefined;
        if (!root) throw notFound("Thread");
        rootId = root.id;
        resolved = await adapter.createCounterpart(ctx, ig, outboundMessage(ctx, root, thread));
      }
    } catch (e) {
      const err = platformError(label, e);
      if (err.code === "internal" || err.code === "rate_limited") recordIntegrationError(ctx, row.id, `Linking a thread failed: ${err.message}`);
      throw err;
    }

    const link = tx(ctx, (emit) => {
      const { thread: t } = requireThread(ctx, actor, threadId, "owner");
      const sameRef = linkByRef(ctx, row.id, resolved.externalRef);
      if (sameRef) {
        if (sameRef.thread_id === t.id) return sameRef;
        throw new OmbError("conflict", `That ${label} ${NOUN[row.platform]} is already linked to another thread`);
      }
      if (linkForThread(ctx, t.id, row.id)) throw new OmbError("conflict", `This thread is already linked through ${row.name}`);
      const now = nowIso(ctx);
      const linkRow: LinkRow = {
        id: newId("lnk"),
        thread_id: t.id,
        integration_id: row.id,
        external_ref: resolved.externalRef,
        url: resolved.url,
        external_id: resolved.externalId,
        created_at: now,
      };
      ctx.db
        .prepare(
          `INSERT INTO thread_links (id, thread_id, integration_id, external_ref, url, external_id, created_at)
           VALUES (@id, @thread_id, @integration_id, @external_ref, @url, @external_id, @created_at)`,
        )
        .run(linkRow);
      const rootExternalId = "rootExternalId" in resolved ? resolved.rootExternalId : null;
      if (rootId && rootExternalId) {
        // The first message already went out as the new thread or issue; never send it again.
        ctx.db
          .prepare(
            `INSERT INTO sync_outbound (message_id, link_id, external_id, status, attempts, last_error, created_at, next_attempt_at)
             VALUES (?, ?, ?, 'sent', 1, NULL, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .run(rootId, linkRow.id, rootExternalId, now, now);
      }
      recordEvent(ctx, emit, { boardId: t.board_id, type: "thread.updated", threadId: t.id, actorId: actor.id });
      return linkRow;
    });
    return c.json({ link: presentLink(row.platform, link) });
  });

  app.delete("/api/links/:linkId", (c) => {
    const actor = requireActor(c);
    const linkId = c.req.param("linkId");
    tx(ctx, (emit) => {
      const link = ctx.db.prepare("SELECT l.id, l.thread_id, t.board_id FROM thread_links l JOIN threads t ON t.id = l.thread_id WHERE l.id = ?").get(linkId) as
        | { id: string; thread_id: string; board_id: string }
        | undefined;
      if (!link) throw notFound("Link");
      requireMember(ctx, actor, link.board_id, "owner", "Link");
      ctx.db.prepare("DELETE FROM thread_links WHERE id = ?").run(link.id);
      recordEvent(ctx, emit, { boardId: link.board_id, type: "thread.updated", threadId: link.thread_id, actorId: actor.id });
    });
    return c.json({ deleted: true });
  });

  // Inbound webhooks. No session: each request is authenticated by the platform's signature over the raw body.
  for (const platform of SYNC_PLATFORMS) {
    app.post(`/hooks/${platform}/:webhookToken`, async (c) => {
      const tooLarge = () => new OmbError("message_too_large", `Webhook bodies can be up to ${MAX_WEBHOOK_BYTES} bytes`);
      if (Number(c.req.header("content-length") ?? "0") > MAX_WEBHOOK_BYTES) throw tooLarge();
      const raw = Buffer.from(await c.req.arrayBuffer());
      if (raw.length > MAX_WEBHOOK_BYTES) throw tooLarge();
      const row = integrationByToken(ctx, platform, c.req.param("webhookToken"));
      if (!row) throw notFound("Webhook");
      const result = await ADAPTERS[platform].handleWebhook(ctx, loadIntegration(ctx, row), { headers: c.req.raw.headers, raw });
      return c.json(result.body as object, result.status as ContentfulStatusCode, result.headers);
    });
  }
};
