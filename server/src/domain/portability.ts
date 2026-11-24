import { EXPORT_FORMAT, ExportFile, type Board } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { tx } from "../context.js";
import { OmbError, forbidden, invalid } from "../errors.js";
import { newId } from "../ids.js";
import { getBoardRow, getMembership, nowIso, requireHuman, requireMember } from "./access.js";
import { ownedBoards } from "./boards.js";
import type { Actor, MessageRow, PrincipalRow, ThreadRow } from "./model.js";
import { presentBoard } from "./present.js";
import { limitsFor } from "./plans.js";

/** Board export: threads, messages, authorship and reply links. No emails, tokens, invites, follows or read state. */
export function exportBoard(ctx: AppContext, actor: Actor, boardId: string): ExportFile {
  const { board } = requireMember(ctx, actor, boardId, "owner");
  const threads = ctx.db.prepare("SELECT * FROM threads WHERE board_id = ? ORDER BY created_at, id").all(board.id) as ThreadRow[];
  const messages = ctx.db.prepare("SELECT * FROM messages WHERE board_id = ? ORDER BY created_at, id").all(board.id) as MessageRow[];
  const mentionRows = ctx.db
    .prepare("SELECT mn.message_id, mn.principal_id FROM mentions mn JOIN messages m ON m.id = mn.message_id WHERE m.board_id = ?")
    .all(board.id) as { message_id: string; principal_id: string }[];
  const authorIds = new Set<string>([
    ...threads.flatMap((t) => [t.created_by, t.task_assignee_id].filter((x): x is string => !!x)),
    ...messages.map((m) => m.author_id),
    ...mentionRows.map((r) => r.principal_id),
  ]);
  const principals = authorIds.size
    ? (ctx.db.prepare(`SELECT * FROM principals WHERE id IN (${[...authorIds].map(() => "?").join(",")})`).all(...authorIds) as PrincipalRow[])
    : [];
  const byId = new Map(principals.map((p) => [p.id, p]));
  for (const p of principals) if (p.owner_id && !byId.has(p.owner_id)) {
    const o = ctx.db.prepare("SELECT * FROM principals WHERE id = ?").get(p.owner_id) as PrincipalRow | undefined;
    if (o) byId.set(o.id, o);
  }
  const mentionMap = new Map<string, string[]>();
  for (const r of mentionRows) mentionMap.set(r.message_id, [...(mentionMap.get(r.message_id) ?? []), r.principal_id]);
  return {
    format: EXPORT_FORMAT,
    exported_at: nowIso(ctx),
    source_host: new URL(ctx.config.publicUrl).host,
    board: { name: board.name, created_at: board.created_at },
    authors: [...byId.values()].map((p) => ({ ref: p.id, kind: p.kind, display_name: p.display_name, via_ref: p.owner_id && byId.has(p.owner_id) ? p.owner_id : null })),
    threads: threads.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      labels: JSON.parse(t.labels) as Record<string, string>,
      task_state: t.task_state,
      task_assignee_ref: t.task_assignee_id,
      created_by_ref: t.created_by,
      created_at: t.created_at,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      thread_id: m.thread_id,
      author_ref: m.author_id,
      body: m.deleted_at ? null : m.body,
      deleted: m.deleted_at !== null,
      reply_to: m.reply_to,
      mention_refs: mentionMap.get(m.id) ?? [],
      source:
        m.source_platform && m.source_external_id
          ? { platform: m.source_platform, author_name: m.source_author_name ?? "unknown", url: m.source_url, external_id: m.source_external_id }
          : null,
      created_at: m.created_at,
    })),
  };
}

/**
 * Imports an export as a new board owned by the importer. Authors become display-only principals that can't sign in,
 * so old invites and credentials can't reach the imported board. IDs are reassigned; timestamps and reply links are kept.
 */
export function importBoard(ctx: AppContext, actor: Actor, raw: unknown, opts: { name?: string; bypassLimits?: boolean } = {}): Board {
  requireHuman(actor);
  if (!ctx.config.allowImport && !opts.bypassLimits) throw forbidden("Import is turned off on this server");
  const parsed = ExportFile.safeParse(raw);
  if (!parsed.success) throw invalid(`Not an ${EXPORT_FORMAT} file: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const file = parsed.data;
  const limits = limitsFor(ctx, actor.id);
  const owned = ownedBoards(ctx, actor.id).length;
  if (!opts.bypassLimits && owned >= limits.boards_owned) {
    throw new OmbError("quota_exceeded", `You already own ${owned} board(s), the most this server allows. Delete one first, or ask the operator to raise OMB_LIMIT_BOARDS_OWNED.`, {
      allowance: "boards_owned",
      used: owned,
      limit: limits.boards_owned,
    });
  }
  const bytes = file.messages.reduce((n, m) => n + (m.body ? Buffer.byteLength(m.body, "utf8") : 0), 0) + file.threads.reduce((n, t) => n + Buffer.byteLength(t.title, "utf8"), 0);
  if (!opts.bypassLimits && bytes > limits.storage_bytes) {
    throw new OmbError("quota_exceeded", "This export is larger than a board's storage allowance", { allowance: "storage", used: bytes, limit: limits.storage_bytes });
  }
  return tx(ctx, (emit) => {
    const now = nowIso(ctx);
    const boardId = newId("b");
    ctx.db
      .prepare("INSERT INTO boards (id, name, owner_id, is_personal, storage_bytes, imported_from, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)")
      .run(boardId, (opts.name?.trim() || file.board.name).slice(0, 80), actor.id, bytes, file.source_host, now);
    const ownerHandle = actor.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "owner";
    ctx.db
      .prepare("INSERT INTO memberships (board_id, principal_id, role, handle, joined_at) VALUES (?, ?, 'owner', ?, ?)")
      .run(boardId, actor.id, ownerHandle, now);
    const authorMap = new Map<string, string>();
    for (const a of file.authors.filter((x) => !x.via_ref)) {
      const id = newId("p");
      ctx.db.prepare("INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)").run(id, a.kind, a.display_name, now);
      authorMap.set(a.ref, id);
    }
    for (const a of file.authors.filter((x) => x.via_ref)) {
      const id = newId("p");
      ctx.db
        .prepare("INSERT INTO principals (id, kind, display_name, owner_id, disabled_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, a.kind, a.display_name, authorMap.get(a.via_ref!) ?? null, now, now);
      authorMap.set(a.ref, id);
    }
    const author = (ref: string | null) => (ref ? (authorMap.get(ref) ?? actor.id) : null);
    const threadMap = new Map<string, string>();
    for (const t of file.threads) {
      const id = newId("t");
      threadMap.set(t.id, id);
      const msgs = file.messages.filter((m) => m.thread_id === t.id);
      const last = msgs[msgs.length - 1]?.created_at ?? t.created_at;
      ctx.db
        .prepare(
          `INSERT INTO threads (id, board_id, title, kind, labels, task_state, task_assignee_id, created_by, created_at, last_activity_at, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, boardId, t.title, t.kind, JSON.stringify(t.labels), t.kind === "task" ? (t.task_state ?? "open") : null, author(t.task_assignee_ref), author(t.created_by_ref), t.created_at, last, msgs.length);
    }
    const messageMap = new Map<string, string>();
    for (const m of file.messages) messageMap.set(m.id, newId("m"));
    const ordered = [...file.messages].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const firstInThread = new Set<string>();
    for (const m of ordered) {
      const threadId = threadMap.get(m.thread_id);
      if (!threadId) continue;
      const id = messageMap.get(m.id)!;
      ctx.db
        .prepare(
          `INSERT INTO messages (id, board_id, thread_id, author_id, body, body_bytes, deleted_at, reply_to, source_platform, source_author_name, source_url, source_external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, boardId, threadId, author(m.author_ref), m.deleted ? null : m.body, m.body ? Buffer.byteLength(m.body, "utf8") : 0, m.deleted ? m.created_at : null,
          m.reply_to ? (messageMap.get(m.reply_to) ?? null) : null, m.source?.platform ?? null, m.source?.author_name ?? null, m.source?.url ?? null,
          m.source ? `import:${m.source.external_id}` : null, m.created_at,
        );
      for (const ref of m.mention_refs) {
        const pid = authorMap.get(ref);
        if (pid) ctx.db.prepare("INSERT OR IGNORE INTO mentions (message_id, principal_id) VALUES (?, ?)").run(id, pid);
      }
      const type = firstInThread.has(threadId) ? "message.created" : "thread.created";
      firstInThread.add(threadId);
      const info = ctx.db
        .prepare("INSERT INTO events (board_id, type, thread_id, message_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(boardId, type, threadId, id, author(m.author_ref), m.created_at);
      emit({ kind: "board", boardId, seq: Number(info.lastInsertRowid), type, threadId, messageId: id, actorId: author(m.author_ref), subjectId: null });
    }
    return presentBoard(ctx, getBoardRow(ctx, boardId)!, getMembership(ctx, boardId, actor.id)!);
  });
}
