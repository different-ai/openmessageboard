import { MAX_MENTIONS, MAX_REACTIONS_PER_MESSAGE, RESERVED_LABEL_PREFIX, normalizeEmoji, type MentionResolution, type Message } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import type { HubEvent } from "../live/hub.js";
import { nowIso, requireMember } from "./access.js";
import { recordEvent } from "./boards.js";
import { canChangeMessage } from "./profiles.js";
import { addInboxItem, checkWriteRate, validateBody, validateLabels } from "./conversation.js";
import { resolveTextMentions } from "./mentions.js";
import { parseJsonObject } from "./message-extras.js";
import type { Actor, MessageRow } from "./model.js";
import { presentMessage } from "./present.js";
import { boardLimits } from "./plans.js";

type Emit = (e: HubEvent) => void;

// ---------- labels ----------

/** Keys under `board.` belong to the server. */
export function assertLabelKeysAllowed(keys: string[]): void {
  const reserved = keys.find((k) => k.startsWith(RESERVED_LABEL_PREFIX));
  if (reserved) throw new OmbError("reserved_label", `Label keys under "${RESERVED_LABEL_PREFIX}" belong to the board; "${reserved}" can't be set or removed`, { key: reserved });
}

/** Keys are validated against LABEL_KEY_PATTERN before they reach SQL, so they are safe to inline in a JSON path. */
const path = (k: string) => `'$."${k}"'`;

/**
 * SQL that matches a message (alias `m`, may be absent) whose labels or whose thread root's labels
 * (alias `t`, threads.labels mirrors the root) contain every pair.
 */
export function messageLabelFilter(labels: Record<string, string>, params: unknown[], m: string, t: string): string {
  let sql = "";
  for (const [k, v] of Object.entries(labels)) {
    sql += ` AND (json_extract(${m}.labels, ${path(k)}) = ? OR json_extract(${t}.labels, ${path(k)}) = ?)`;
    params.push(v, v);
  }
  return sql;
}

/** SQL that matches a thread (alias `t`) whose root, or one of whose live messages, matches every pair. */
export function threadLabelFilter(labels: Record<string, string>, params: unknown[], t: string): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const rootOnly = entries.map(([k]) => `json_extract(${t}.labels, ${path(k)}) = ?`).join(" AND ");
  params.push(...entries.map(([, v]) => v));
  const inner: unknown[] = [];
  const any = messageLabelFilter(labels, inner, "lm", t);
  params.push(...inner);
  return ` AND ((${rootOnly}) OR EXISTS (SELECT 1 FROM messages lm WHERE lm.thread_id = ${t}.id AND lm.deleted_at IS NULL${any}))`;
}

export interface LabelChange {
  set?: Record<string, string> | undefined;
  unset?: string[] | undefined;
  if?: Record<string, string | null> | undefined;
}

/**
 * Applies a label change to a live message in the caller's transaction. Records `labels.changed`, and
 * `thread.updated` too when the message is the thread's root (its labels are the thread's labels).
 * Returns false when nothing changed.
 */
export function applyLabelChange(ctx: AppContext, emit: Emit, actor: Actor, row: MessageRow, change: LabelChange): boolean {
  if (row.deleted_at) throw new OmbError("message_deleted", "This message was deleted; its labels can't change");
  const set = change.set ?? {};
  const unset = change.unset ?? [];
  const both = unset.filter((k) => k in set);
  if (both.length) throw invalid(`Label ${both.map((k) => `"${k}"`).join(", ")} is in both set and unset`);
  assertLabelKeysAllowed([...Object.keys(set), ...unset]);
  validateLabels(set);
  const current = parseJsonObject(row.labels);
  for (const [k, expected] of Object.entries(change.if ?? {})) {
    const actual = current[k];
    const holds = expected === null ? actual === undefined : actual === expected;
    if (!holds) throw new OmbError("label_conflict", `Label "${k}" doesn't match the condition; nothing changed`, { key: k });
  }
  const next = { ...current };
  for (const k of unset) delete next[k];
  Object.assign(next, set);
  const validated = validateLabels(next);
  const same = Object.keys(validated).length === Object.keys(current).length && Object.entries(validated).every(([k, v]) => current[k] === v);
  if (same) return false;
  const json = JSON.stringify(validated);
  ctx.db.prepare("UPDATE messages SET labels = ? WHERE id = ?").run(json, row.id);
  recordEvent(ctx, emit, { boardId: row.board_id, type: "labels.changed", threadId: row.thread_id, messageId: row.id, actorId: actor.id });
  if (row.is_root) {
    ctx.db.prepare("UPDATE threads SET labels = ?, last_activity_at = ? WHERE id = ?").run(json, nowIso(ctx), row.thread_id);
    recordEvent(ctx, emit, { boardId: row.board_id, type: "thread.updated", threadId: row.thread_id, actorId: actor.id });
  }
  return true;
}

function loadMessage(ctx: AppContext, id: string): MessageRow {
  const row = ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  if (!row) throw notFound("Message");
  return row;
}

function boardOfMessage(ctx: AppContext, id: string): string {
  return (ctx.db.prepare("SELECT board_id FROM messages WHERE id = ?").get(id) as { board_id: string } | undefined)?.board_id ?? "";
}

/** label_message: contributors set or remove labels on any message, optionally only while `if` holds. */
export function labelMessage(ctx: AppContext, actor: Actor, messageId: string, change: LabelChange): { message: Message } {
  checkWriteRate(ctx, actor, boardOfMessage(ctx, messageId));
  return tx(ctx, (emit) => {
    const row = loadMessage(ctx, messageId);
    requireMember(ctx, actor, row.board_id, "contributor", "Message");
    applyLabelChange(ctx, emit, actor, row, change);
    return { message: presentMessage(ctx, loadMessage(ctx, row.id), actor.id) };
  });
}

// ---------- reactions ----------

/** react: readers and up add or remove their own reaction. */
export function react(ctx: AppContext, actor: Actor, messageId: string, input: { emoji: string; remove?: boolean | undefined }): { message: Message } {
  const emoji = normalizeEmoji(input.emoji);
  if (!emoji) throw invalid("emoji must be a short name such as eyes or thumbs_up, :short_name:, or an emoji");
  checkWriteRate(ctx, actor, boardOfMessage(ctx, messageId));
  return tx(ctx, (emit) => {
    const row = loadMessage(ctx, messageId);
    requireMember(ctx, actor, row.board_id, "reader", "Message");
    if (row.deleted_at) throw new OmbError("message_deleted", "This message was deleted; it can't take reactions");
    let changed = 0;
    if (input.remove) {
      changed = ctx.db.prepare("DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND principal_id = ?").run(row.id, emoji, actor.id).changes;
    } else {
      const known = ctx.db.prepare("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1").get(row.id, emoji);
      if (!known) {
        const distinct = (ctx.db.prepare("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?").get(row.id) as { n: number }).n;
        if (distinct >= MAX_REACTIONS_PER_MESSAGE) throw invalid(`A message can carry up to ${MAX_REACTIONS_PER_MESSAGE} different emoji`);
      }
      changed = ctx.db
        .prepare("INSERT INTO reactions (message_id, emoji, principal_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(row.id, emoji, actor.id, nowIso(ctx)).changes;
    }
    if (changed) recordEvent(ctx, emit, { boardId: row.board_id, type: "reactions.changed", threadId: row.thread_id, messageId: row.id, actorId: actor.id });
    return { message: presentMessage(ctx, row, actor.id) };
  });
}

// ---------- edits ----------

/**
 * edit_message: the author (or the person an authoring agent acts for) replaces the body. Optional optimistic
 * concurrency with `revision`. Re-resolves mentions; newly mentioned members get a mention inbox item.
 */
export function editMessage(
  ctx: AppContext,
  actor: Actor,
  messageId: string,
  input: { body: string; revision?: number | undefined },
): { message: Message; mentions_resolved?: MentionResolution[] } {
  checkWriteRate(ctx, actor, boardOfMessage(ctx, messageId));
  return tx(ctx, (emit) => {
    const row = loadMessage(ctx, messageId);
    const { board } = requireMember(ctx, actor, row.board_id, "reader", "Message");
    const authorOwner = (ctx.db.prepare("SELECT owner_id FROM principals WHERE id = ?").get(row.author_id) as { owner_id: string | null } | undefined)?.owner_id ?? null;
    // Like delete, but board owners get no say over other people's words: only the author, or the author's person.
    if (!canChangeMessage(actor, { id: row.author_id, owner_id: authorOwner }, "contributor")) {
      throw forbidden(actor.profile ? "A profile can edit only what it wrote" : "You can edit messages you wrote, and messages your agents and profiles wrote");
    }
    requireMember(ctx, actor, row.board_id, "contributor", "Message");
    if (row.deleted_at) throw new OmbError("message_deleted", "This message was deleted and can't be edited");
    if (input.revision !== undefined && input.revision !== row.revision) {
      throw new OmbError("revision_conflict", `The message changed since revision ${input.revision}; read it again`, { revision: row.revision });
    }
    const bodyBytes = validateBody(ctx, input.body, board.id);
    const blockBytes = row.blocks ? Buffer.byteLength(row.blocks, "utf8") : 0;
    const total = bodyBytes + blockBytes;
    const limits = boardLimits(ctx, board.id);
    if (total > limits.message_bytes) {
      throw new OmbError("message_too_large", `Messages (text and structured data) can be up to ${limits.message_bytes} bytes; this one is ${total}`, {
        allowance: "message_bytes",
        bytes: total,
        limit: limits.message_bytes,
      });
    }
    const text = row.source_platform ? { ids: [] as string[], resolved: [] as MentionResolution[] } : resolveTextMentions(ctx, board.id, input.body);
    const result = (r: MessageRow) => ({ message: presentMessage(ctx, r, actor.id), ...(text.resolved.length ? { mentions_resolved: text.resolved } : {}) });
    if (input.body === row.body) return result(row);
    const delta = total - row.body_bytes;
    if (delta > 0 && board.storage_bytes + delta > limits.storage_bytes) {
      throw new OmbError("quota_exceeded", "This board has no storage left for this edit. Deleting old messages frees space.", {
        allowance: "storage",
        used: board.storage_bytes,
        limit: limits.storage_bytes,
        needed: delta,
        resets_at: null,
      });
    }
    const now = nowIso(ctx);
    ctx.db.prepare("UPDATE messages SET body = ?, body_bytes = ?, revision = revision + 1, edited_at = ? WHERE id = ?").run(input.body, total, now, row.id);
    ctx.db.prepare("UPDATE boards SET storage_bytes = MAX(0, storage_bytes + ?) WHERE id = ?").run(delta, board.id);

    // Mentions: explicit ones stay; those written in the body follow the new text.
    const before = new Set((ctx.db.prepare("SELECT principal_id FROM mentions WHERE message_id = ?").all(row.id) as { principal_id: string }[]).map((r) => r.principal_id));
    const explicit = (ctx.db.prepare("SELECT principal_id FROM mentions WHERE message_id = ? AND source = 'explicit'").all(row.id) as { principal_id: string }[]).map((r) => r.principal_id);
    const next = [...explicit];
    const fromText = new Set<string>();
    for (const id of text.ids) {
      if (next.length >= MAX_MENTIONS) break;
      if (!next.includes(id)) {
        next.push(id);
        fromText.add(id);
      }
    }
    ctx.db.prepare("DELETE FROM mentions WHERE message_id = ? AND source = 'text'").run(row.id);
    for (const id of fromText) ctx.db.prepare("INSERT INTO mentions (message_id, principal_id, source) VALUES (?, ?, 'text')").run(row.id, id);
    recordEvent(ctx, emit, { boardId: row.board_id, type: "message.edited", threadId: row.thread_id, messageId: row.id, actorId: actor.id });
    for (const id of fromText) {
      if (!before.has(id) && id !== row.author_id) addInboxItem(ctx, emit, { principalId: id, kind: "mention", boardId: row.board_id, threadId: row.thread_id, messageId: row.id });
    }
    return result(loadMessage(ctx, row.id));
  });
}
