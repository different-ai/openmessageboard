import type { Attachment, Block, Labels, Reaction } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import type { MessageRow } from "./model.js";

export interface MessageExtras {
  revision: number;
  edited_at: string | null;
  labels: Labels;
  reactions: Reaction[];
  blocks: Block[];
  attachments: Attachment[];
}

export function parseJsonObject(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function parseBlocks(raw: string | null | undefined): Block[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as Block[]) : [];
  } catch {
    return [];
  }
}

/**
 * Revision, labels, reactions (with `me` for the viewer), structured data and attachments for a page of messages.
 * A tombstone keeps its revision and loses everything else.
 */
export function messageExtras(ctx: AppContext, rows: MessageRow[], viewerId: string | null): Map<string, MessageExtras> {
  const out = new Map<string, MessageExtras>();
  if (rows.length === 0) return out;
  const live = rows.filter((m) => !m.deleted_at).map((m) => m.id);
  const reactions = new Map<string, Reaction[]>();
  const attachments = new Map<string, Attachment[]>();
  for (let i = 0; i < live.length; i += 500) {
    const chunk = live.slice(i, i + 500);
    const ph = chunk.map(() => "?").join(",");
    const rx = ctx.db
      .prepare(
        `SELECT message_id, emoji, COUNT(*) AS n, MAX(principal_id = ?) AS mine, MIN(rowid) AS first
         FROM reactions WHERE message_id IN (${ph}) GROUP BY message_id, emoji ORDER BY first, emoji`,
      )
      .all(viewerId ?? "", ...chunk) as { message_id: string; emoji: string; n: number; mine: number }[];
    for (const r of rx) {
      const list = reactions.get(r.message_id) ?? [];
      list.push({ emoji: r.emoji, count: r.n, me: r.mine === 1 });
      reactions.set(r.message_id, list);
    }
    const ax = ctx.db
      .prepare(
        `SELECT ma.message_id, a.id, a.name, a.type, a.size FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
         WHERE ma.message_id IN (${ph}) ORDER BY ma.message_id, ma.position`,
      )
      .all(...chunk) as { message_id: string; id: string; name: string; type: string; size: number }[];
    for (const a of ax) {
      const list = attachments.get(a.message_id) ?? [];
      list.push({ id: a.id, name: a.name, type: a.type, size: a.size });
      attachments.set(a.message_id, list);
    }
  }
  for (const m of rows) {
    const deleted = m.deleted_at !== null;
    out.set(m.id, {
      revision: m.revision ?? 1,
      edited_at: m.edited_at ?? null,
      labels: deleted ? {} : parseJsonObject(m.labels),
      reactions: deleted ? [] : (reactions.get(m.id) ?? []),
      blocks: deleted ? [] : parseBlocks(m.blocks),
      attachments: deleted ? [] : (attachments.get(m.id) ?? []),
    });
  }
  return out;
}
