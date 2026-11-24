import type { MentionResolution, PrincipalRef } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { activeMembership } from "./access.js";
import type { Actor } from "./model.js";
import { principalRefs } from "./present.js";

/** A mention as written in a body: `@handle` or `@[principal-id]`. */
export interface WrittenMention {
  written: string;
  handle?: string;
  principalId?: string;
}

/** Blanks out fenced code blocks and inline code spans, keeping offsets, so mentions inside code are ignored. */
export function stripCode(body: string): string {
  const lines = body.split("\n");
  let fence: { char: string; len: number } | null = null;
  const kept = lines.map((line) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) fence = null;
      return " ".repeat(line.length);
    }
    if (m) {
      fence = { char: m[1]![0]!, len: m[1]!.length };
      return " ".repeat(line.length);
    }
    return line;
  });
  let text = kept.join("\n");
  // Inline code: a run of N backticks up to the next run of exactly N backticks.
  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (all) => " ".repeat(all.length));
  return text;
}

const MENTION = /(^|[^A-Za-z0-9_.@/+&=\\-])@(?:\[([A-Za-z0-9_-]{1,64})\]|([A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})?))/g;

/** Every distinct mention written in a body, in order, ignoring code. */
export function findMentions(body: string): WrittenMention[] {
  const out: WrittenMention[] = [];
  const seen = new Set<string>();
  for (const m of stripCode(body).matchAll(MENTION)) {
    const id = m[2];
    const handle = m[3]?.replace(/[-_]+$/, "").toLowerCase();
    const written = id ? `@[${id}]` : `@${handle}`;
    if (!handle && !id) continue;
    const key = written.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id ? { written, principalId: id } : { written, handle: handle! });
  }
  return out;
}

/**
 * Resolves the mentions written in a body against the board's active members. A handle that matches no one, or
 * several, stays text and mentions no one; a mention never fails a write.
 */
export function resolveTextMentions(ctx: AppContext, boardId: string, body: string): { ids: string[]; resolved: MentionResolution[] } {
  const written = findMentions(body);
  if (written.length === 0) return { ids: [], resolved: [] };
  const matches: { written: string; ids: string[] }[] = [];
  for (const w of written) {
    let candidates: { id: string; kind: Actor["kind"]; owner_id: string | null }[] = [];
    if (w.principalId) {
      candidates = ctx.db.prepare("SELECT id, kind, owner_id FROM principals WHERE id = ?").all(w.principalId) as typeof candidates;
    } else if (w.handle) {
      candidates = ctx.db
        .prepare("SELECT p.id, p.kind, p.owner_id FROM memberships m JOIN principals p ON p.id = m.principal_id WHERE m.board_id = ? AND lower(m.handle) = ?")
        .all(boardId, w.handle) as typeof candidates;
    }
    const active = candidates.filter((p) => activeMembership(ctx, boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id }));
    matches.push({ written: w.written, ids: active.map((p) => p.id) });
  }
  const refs: Map<string, PrincipalRef> = principalRefs(ctx, matches.flatMap((m) => m.ids));
  const ids: string[] = [];
  const resolved: MentionResolution[] = matches.map((m) => {
    if (m.ids.length === 1) {
      if (!ids.includes(m.ids[0]!)) ids.push(m.ids[0]!);
      return { written: m.written, principal: refs.get(m.ids[0]!)!, candidates: [] };
    }
    return { written: m.written, principal: null, candidates: m.ids.length > 1 ? m.ids.map((id) => refs.get(id)!) : [] };
  });
  return { ids, resolved };
}
