import type { ExternalLink, Integration, SyncPlatform } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { nowIso } from "../domain/access.js";
import { OmbError } from "../errors.js";
import { decrypt } from "../ids.js";

export const PLATFORM_LABEL: Record<SyncPlatform, string> = { slack: "Slack", github: "GitHub", linear: "Linear" };

export interface IntegrationRow {
  id: string;
  board_id: string;
  platform: SyncPlatform;
  name: string;
  config: string;
  secrets_enc: string;
  principal_id: string;
  webhook_token: string;
  created_by: string;
  created_at: string;
  last_event_at: string | null;
  last_error: string | null;
  disabled_at: string | null;
}

export interface LinkRow {
  id: string;
  thread_id: string;
  integration_id: string;
  external_ref: string;
  url: string | null;
  external_id: string | null;
  created_at: string;
}

/** An integration with its config parsed and secrets decrypted. Secrets never leave the server. */
export interface LoadedIntegration {
  row: IntegrationRow;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export function getIntegrationRow(ctx: AppContext, id: string): IntegrationRow | undefined {
  return ctx.db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as IntegrationRow | undefined;
}

export function integrationByToken(ctx: AppContext, platform: SyncPlatform, token: string): IntegrationRow | undefined {
  return ctx.db.prepare("SELECT * FROM integrations WHERE webhook_token = ? AND platform = ? AND disabled_at IS NULL").get(token, platform) as
    | IntegrationRow
    | undefined;
}

export function loadIntegration(ctx: AppContext, row: IntegrationRow): LoadedIntegration {
  let secrets: Record<string, string>;
  try {
    secrets = JSON.parse(decrypt(ctx.config.secret, row.secrets_enc)) as Record<string, string>;
  } catch {
    recordIntegrationError(ctx, row.id, "Stored secrets can't be decrypted (the server secret changed). Delete and re-add this integration.");
    throw new OmbError("internal", "Integration secrets can't be read");
  }
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    config = {};
  }
  return { row, config, secrets };
}

export function webhookUrl(ctx: AppContext, row: Pick<IntegrationRow, "platform" | "webhook_token">): string {
  return `${ctx.config.publicUrl}/hooks/${row.platform}/${row.webhook_token}`;
}

export function presentIntegration(ctx: AppContext, row: IntegrationRow): Integration {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    config = {};
  }
  return {
    id: row.id,
    board_id: row.board_id,
    platform: row.platform,
    name: row.name,
    config,
    webhook_url: webhookUrl(ctx, row),
    created_at: row.created_at,
    last_event_at: row.last_event_at,
    last_error: row.last_error,
  };
}

export function presentLink(platform: SyncPlatform, link: LinkRow): ExternalLink {
  return { id: link.id, platform, external_ref: link.external_ref, url: link.url };
}

/** Compared case-insensitively: GitHub owner/repo names ignore case, and Slack and Linear refs are upper-case already. */
export function linkByRef(ctx: AppContext, integrationId: string, ref: string): LinkRow | undefined {
  return ctx.db.prepare("SELECT * FROM thread_links WHERE integration_id = ? AND external_ref = ? COLLATE NOCASE").get(integrationId, ref) as LinkRow | undefined;
}

export function linkByExternalId(ctx: AppContext, integrationId: string, externalId: string): LinkRow | undefined {
  return ctx.db.prepare("SELECT * FROM thread_links WHERE integration_id = ? AND external_id = ?").get(integrationId, externalId) as LinkRow | undefined;
}

export function linkForThread(ctx: AppContext, threadId: string, integrationId: string): LinkRow | undefined {
  return ctx.db.prepare("SELECT * FROM thread_links WHERE thread_id = ? AND integration_id = ?").get(threadId, integrationId) as LinkRow | undefined;
}

/** True when this external message/comment ID is one the sync itself sent through this integration. */
export function isOwnOutbound(ctx: AppContext, integrationId: string, externalId: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM sync_outbound o JOIN thread_links l ON l.id = o.link_id WHERE l.integration_id = ? AND o.external_id = ? LIMIT 1")
    .get(integrationId, externalId);
}

export function sourceMessageExists(ctx: AppContext, threadId: string, platform: SyncPlatform, externalId: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM messages WHERE thread_id = ? AND source_platform = ? AND source_external_id = ?")
    .get(threadId, platform, externalId);
}

export function recordIntegrationActivity(ctx: AppContext, id: string, opts: { clearError?: boolean } = {}): void {
  ctx.db
    .prepare(`UPDATE integrations SET last_event_at = ?${opts.clearError ? ", last_error = NULL" : ""} WHERE id = ?`)
    .run(nowIso(ctx), id);
}

/** Stores a short, secret-free description of the latest problem; shown to the board owner. */
export function recordIntegrationError(ctx: AppContext, id: string, message: string): void {
  const text = message.length > 300 ? message.slice(0, 297) + "..." : message;
  ctx.db.prepare("UPDATE integrations SET last_error = ? WHERE id = ?").run(text, id);
}

/** True for the unique-index violation that marks an inbound message we already stored. */
export function isDuplicateSource(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    (e as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE" &&
    String((e as { message?: unknown }).message).includes("messages.source_external_id")
  );
}

// ---------- per-integration identity cache (bot user, token login, viewer) ----------

const IDENTITY_TTL_MS = 60 * 60 * 1000;
const identities = new Map<string, { value: unknown; at: number }>();

/** Caches a platform identity lookup per integration for an hour. Failed lookups are not cached. */
export async function cachedIdentity<T>(key: string, load: () => Promise<T>): Promise<T | null> {
  const hit = identities.get(key);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value as T;
  try {
    const value = await load();
    if (identities.size > 5000) identities.clear();
    identities.set(key, { value, at: Date.now() });
    return value;
  } catch {
    return null;
  }
}

export function forgetIntegrationCaches(integrationId: string): void {
  for (const k of identities.keys()) if (k.startsWith(`${integrationId}:`)) identities.delete(k);
}
