import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME,
  MAX_INLINE_ATTACHMENT_BYTES,
  type Attachment,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { nowIso, requireMember, requireReader } from "./access.js";
import { checkWriteRate } from "./conversation.js";
import type { Actor } from "./model.js";
import { boardLimits } from "./plans.js";
import { ChannelAccess } from "./grants.js";

/** Where attachment bytes live: files on Node, R2 on Cloudflare. Keys match `[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*`. */
export interface AttachmentStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const stores = new WeakMap<AppContext, AttachmentStore>();

export function attachmentStore(ctx: AppContext): AttachmentStore {
  return stores.get(ctx) ?? ctx.platform.attachments;
}

/** Replaces the store (tests, other backends). */
export function setAttachmentStore(ctx: AppContext, store: AttachmentStore): void {
  stores.set(ctx, store);
}

interface AttachmentRow {
  id: string;
  board_id: string;
  uploader_id: string;
  name: string;
  type: string;
  size: number;
  storage_key: string;
  attached_at: string | null;
  created_at: string;
}

const present = (r: AttachmentRow): Attachment => ({ id: r.id, name: r.name, type: r.type, size: r.size });

/** A file name safe to show and to put in a download header: no paths, no control characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, MAX_ATTACHMENT_NAME);
  return cleaned || "file";
}

export function cleanType(type: string | undefined | null): string {
  const t = (type ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : "application/octet-stream";
}

function attachmentBytes(ctx: AppContext, boardId: string): number {
  return (ctx.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE board_id = ?").get(boardId) as { n: number }).n;
}

export function boardAttachmentBytes(ctx: AppContext, boardId: string): number {
  return attachmentBytes(ctx, boardId);
}

/** Stores a file on a board for the uploader to attach to a message. Contributors and up. */
export async function uploadAttachment(ctx: AppContext, actor: Actor, boardId: string, input: { name: string; type?: string | undefined; data: Uint8Array }): Promise<{ attachment: Attachment }> {
  const size = input.data.byteLength;
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new OmbError("attachment_too_large", `Files can be up to ${MAX_ATTACHMENT_BYTES} bytes; this one is ${size}`, { limit: MAX_ATTACHMENT_BYTES, size });
  }
  requireMember(ctx, actor, boardId, "contributor");
  checkWriteRate(ctx, actor, boardId);
  const id = newId("a");
  const key = `${boardId}/${id}`;
  const store = attachmentStore(ctx);
  await store.put(key, input.data);
  try {
    const row = tx(ctx, () => {
      const { board } = requireMember(ctx, actor, boardId, "contributor");
      const limits = boardLimits(ctx, board.id);
      const used = attachmentBytes(ctx, board.id);
      if (used + size > limits.attachment_bytes) {
        throw new OmbError("quota_exceeded", "This board has no room left for attachments. Deleting messages with files frees space.", {
          allowance: "attachments",
          used,
          limit: limits.attachment_bytes,
          needed: size,
          resets_at: null,
        });
      }
      if (board.storage_bytes + size > limits.storage_bytes) {
        throw new OmbError("quota_exceeded", "This board has no storage left for this file. Deleting old messages frees space.", {
          allowance: "storage",
          used: board.storage_bytes,
          limit: limits.storage_bytes,
          needed: size,
          resets_at: null,
        });
      }
      const r: AttachmentRow = { id, board_id: board.id, uploader_id: actor.id, name: cleanName(input.name), type: cleanType(input.type), size, storage_key: key, attached_at: null, created_at: nowIso(ctx) };
      ctx.db
        .prepare("INSERT INTO attachments (id, board_id, uploader_id, name, type, size, storage_key, attached_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(r.id, r.board_id, r.uploader_id, r.name, r.type, r.size, r.storage_key, r.attached_at, r.created_at);
      ctx.db.prepare("UPDATE boards SET storage_bytes = storage_bytes + ? WHERE id = ?").run(size, board.id);
      return r;
    });
    return { attachment: present(row) };
  } catch (e) {
    await store.delete(key).catch(() => undefined);
    throw e;
  }
}

/** Whether a live (not deleted) message references the attachment. */
function isAttached(ctx: AppContext, attachmentId: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.attachment_id = ? AND m.deleted_at IS NULL LIMIT 1")
    .get(attachmentId);
}

/** Whether the caller can read a live message the attachment is attached to (its thread's channel included). */
function readableViaMessage(ctx: AppContext, actor: Actor, attachmentId: string, boardId: string): boolean {
  const channels = (
    ctx.db
      .prepare(
        `SELECT DISTINCT t.channel FROM message_attachments ma JOIN messages m ON m.id = ma.message_id JOIN threads t ON t.id = m.thread_id
         WHERE ma.attachment_id = ? AND m.deleted_at IS NULL`,
      )
      .all(attachmentId) as { channel: string }[]
  ).map((r) => r.channel);
  if (channels.length === 0) return false;
  // Reader access: a member, or the public where a public grant covers the message's channel (11 §Public access).
  const access = ChannelAccess.loadReader(ctx, boardId, actor);
  return channels.some((c) => access.can(c, "read"));
}

/**
 * Who may read an attachment: whoever can read a message it is attached to (a member, or the public where a
 * public grant covers that message's channel), and its uploader while they are a member. Everyone else gets
 * not_found.
 */
function readable(ctx: AppContext, actor: Actor, attachmentId: string): AttachmentRow {
  const row = ctx.db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId) as AttachmentRow | undefined;
  if (!row) throw notFound("Attachment");
  const reader = requireReader(ctx, actor, row.board_id, "Attachment");
  // A former member reading through a public grant gets their uploads the way anyone does: through a message.
  const own = reader.membership !== null && row.uploader_id === actor.id;
  if (!own && !readableViaMessage(ctx, actor, row.id, row.board_id)) throw notFound("Attachment");
  return row;
}

export async function readAttachment(ctx: AppContext, actor: Actor, attachmentId: string): Promise<{ attachment: Attachment; data: Uint8Array }> {
  const row = readable(ctx, actor, attachmentId);
  const data = await attachmentStore(ctx).get(row.storage_key);
  if (!data) throw notFound("Attachment");
  return { attachment: present(row), data };
}

export function attachmentUrl(ctx: AppContext, id: string): string {
  return `${ctx.config.publicUrl}/api/attachments/${id}`;
}

/** MCP get_attachment: metadata, the download URL, and the contents when small. */
export async function getAttachment(ctx: AppContext, actor: Actor, attachmentId: string): Promise<{ attachment: Attachment; url: string; data_base64: string | null }> {
  const row = readable(ctx, actor, attachmentId);
  let data: string | null = null;
  if (row.size <= MAX_INLINE_ATTACHMENT_BYTES) {
    const bytes = await attachmentStore(ctx).get(row.storage_key);
    if (!bytes) throw notFound("Attachment");
    data = Buffer.from(bytes).toString("base64");
  }
  return { attachment: present(row), url: attachmentUrl(ctx, row.id), data_base64: data };
}

/**
 * Links attachments to a new message. Each must be on the board and either uploaded by the author or attached to
 * a live message the author can read, so a file can't move into a channel through someone else. Caller holds a
 * transaction.
 */
export function attachToMessage(ctx: AppContext, actor: Actor, boardId: string, messageId: string, ids: string[] | undefined): void {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return;
  if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) throw invalid(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  const now = nowIso(ctx);
  unique.forEach((id, position) => {
    const row = ctx.db.prepare("SELECT * FROM attachments WHERE id = ? AND board_id = ?").get(id, boardId) as AttachmentRow | undefined;
    if (!row || (row.uploader_id !== actor.id && !readableViaMessage(ctx, actor, row.id, boardId))) throw invalid(`Attachment ${id} was not found on this board`, { attachment_id: id });
    ctx.db.prepare("INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, ?)").run(messageId, id, position);
    if (!row.attached_at) ctx.db.prepare("UPDATE attachments SET attached_at = ? WHERE id = ?").run(now, id);
  });
}

/** Checks attachment IDs before any write (so a bad ID charges nothing). Caller holds a transaction. */
export function checkAttachable(ctx: AppContext, actor: Actor, boardId: string, ids: string[] | undefined): void {
  const unique = [...new Set(ids ?? [])];
  if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) throw invalid(`Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  for (const id of unique) {
    const row = ctx.db.prepare("SELECT * FROM attachments WHERE id = ? AND board_id = ?").get(id, boardId) as AttachmentRow | undefined;
    if (!row || (row.uploader_id !== actor.id && !readableViaMessage(ctx, actor, row.id, boardId))) throw invalid(`Attachment ${id} was not found on this board`, { attachment_id: id });
  }
}

/**
 * Detaches a deleted message's files; files no live message references any more are removed and their bytes
 * freed. Caller holds a transaction; returns storage keys to delete after commit.
 */
export function releaseMessageAttachments(ctx: AppContext, messageId: string, boardId: string): string[] {
  const ids = (ctx.db.prepare("SELECT attachment_id FROM message_attachments WHERE message_id = ?").all(messageId) as { attachment_id: string }[]).map((r) => r.attachment_id);
  if (ids.length === 0) return [];
  ctx.db.prepare("DELETE FROM message_attachments WHERE message_id = ?").run(messageId);
  const keys: string[] = [];
  for (const id of ids) {
    if (isAttached(ctx, id)) continue;
    const row = ctx.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;
    if (!row) continue;
    ctx.db.prepare("DELETE FROM message_attachments WHERE attachment_id = ?").run(id);
    ctx.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    ctx.db.prepare("UPDATE boards SET storage_bytes = MAX(0, storage_bytes - ?) WHERE id = ?").run(row.size, boardId);
    keys.push(row.storage_key);
  }
  return keys;
}

/** Deletes stored files after the transaction that removed their rows has committed. */
export function removeFiles(ctx: AppContext, keys: string[]): void {
  const store = attachmentStore(ctx);
  for (const key of keys) void store.delete(key).catch((e: unknown) => console.error("attachment cleanup failed", (e as Error).message));
}

/** Storage keys of every attachment on a board (before the board is deleted). */
export function boardAttachmentKeys(ctx: AppContext, boardId: string): string[] {
  return (ctx.db.prepare("SELECT storage_key FROM attachments WHERE board_id = ?").all(boardId) as { storage_key: string }[]).map((r) => r.storage_key);
}

/** Maintenance: uploads never attached to a message within a day are removed and their bytes freed. */
export function cleanupUnattached(ctx: AppContext): number {
  const cutoff = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const keys = tx(ctx, () => {
    const rows = ctx.db.prepare("SELECT * FROM attachments WHERE attached_at IS NULL AND created_at < ?").all(cutoff) as AttachmentRow[];
    for (const r of rows) {
      ctx.db.prepare("DELETE FROM attachments WHERE id = ?").run(r.id);
      ctx.db.prepare("UPDATE boards SET storage_bytes = MAX(0, storage_bytes - ?) WHERE id = ?").run(r.size, r.board_id);
    }
    return rows.map((r) => r.storage_key);
  });
  removeFiles(ctx, keys);
  return keys.length;
}
