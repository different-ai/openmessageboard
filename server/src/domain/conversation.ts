import { createHash } from "node:crypto";
import {
  LABEL_KEY_PATTERN,
  MAX_LABELS,
  MAX_LABEL_VALUE,
  MAX_MENTIONS,
  MAX_TITLE_CHARS,
  MAX_IDEMPOTENCY_KEY,
  type AllowanceUsage,
  type Message,
  type TaskAction,
  type TaskState,
  type Thread,
  type ThreadKind,
  type MessageSource,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { read, tx } from "../context.js";
import { OmbError, forbidden, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type { HubEvent } from "../live/hub.js";
import { activeMembership, currentMonth, getBoardRow, holderId, nextMonthStart, nowIso, requireMember, requireThread } from "./access.js";
import { canChangeMessage, coveredPrincipalIds } from "./profiles.js";
import { recordEvent } from "./boards.js";
import { encodeCursor, encodePage, decodePage } from "./cursors.js";
import type { Actor, BoardRow, MessageRow, ThreadRow } from "./model.js";
import { presentMessage, presentMessages, presentThread, presentThreads, refOf } from "./present.js";
import { boardLimits } from "./plans.js";

type Emit = (e: HubEvent) => void;

export interface WriteOptions {
  /** Set by sync when a message arrives from Slack, GitHub or Linear. */
  source?: MessageSource;
  /** Skip burst limits (server-internal writes). */
  internal?: boolean;
}

// ---------- validation ----------

export function validateBody(ctx: AppContext, body: string, boardId?: string): number {
  const bytes = Buffer.byteLength(body, "utf8");
  if (body.trim().length === 0) throw invalid("Message body can't be empty");
  const max = boardId ? boardLimits(ctx, boardId).message_bytes : ctx.config.limits.message_bytes;
  if (bytes > max) {
    throw new OmbError("message_too_large", `Messages can be up to ${max} bytes; this one is ${bytes}`, {
      allowance: "message_bytes",
      bytes,
      limit: max,
    });
  }
  return bytes;
}

function validateTitle(title: string): string {
  const t = title.trim();
  if (!t) throw invalid("Title can't be empty");
  if ([...t].length > MAX_TITLE_CHARS) throw invalid(`Titles can be up to ${MAX_TITLE_CHARS} characters`);
  return t;
}

export function validateLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL_KEY_PATTERN.test(k)) throw invalid(`Label key "${k}" must be lowercase letters, digits, '.', '_' or '-' (up to 32)`);
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_LABEL_VALUE) throw invalid(`Label "${k}" needs a value of 1-${MAX_LABEL_VALUE} characters`);
    out[k] = v;
  }
  if (Object.keys(out).length > MAX_LABELS) throw invalid(`A thread can have up to ${MAX_LABELS} labels`);
  return out;
}

type MentionRow = { id: string; kind: Actor["kind"]; owner_id: string | null; profile_name: string | null };

function resolveMentions(ctx: AppContext, boardId: string, ids: string[] | undefined): string[] {
  const unique = [...new Set(ids ?? [])];
  if (unique.length > MAX_MENTIONS) throw invalid(`Up to ${MAX_MENTIONS} mentions per message`);
  for (const id of unique) {
    const p = ctx.db.prepare("SELECT id, kind, owner_id, profile_name FROM principals WHERE id = ?").get(id) as MentionRow | undefined;
    if (!p || !activeMembership(ctx, boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id, profile: p.profile_name })) {
      throw invalid(`Mentioned principal ${id} is not a member of this board`, { principal_id: id });
    }
  }
  return unique;
}

function hashRequest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Runs `fn` once per (principal, key); retries with the same key and payload return the stored result. */
function idempotent<T>(ctx: AppContext, actor: Actor, key: string | undefined, input: unknown, fn: () => T): T {
  if (key === undefined) return fn();
  if (!key || key.length > MAX_IDEMPOTENCY_KEY) throw invalid(`idempotency_key must be 1-${MAX_IDEMPOTENCY_KEY} characters`);
  const hash = hashRequest(input);
  const prior = ctx.db.prepare("SELECT request_hash, result FROM idempotency WHERE principal_id = ? AND key = ?").get(actor.id, key) as
    | { request_hash: string; result: string }
    | undefined;
  if (prior) {
    if (prior.request_hash !== hash) throw new OmbError("idempotency_conflict", "This idempotency_key was already used for a different request");
    return JSON.parse(prior.result) as T;
  }
  const result = fn();
  ctx.db.prepare("INSERT INTO idempotency (principal_id, key, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?)").run(actor.id, key, hash, JSON.stringify(result), nowIso(ctx));
  return result;
}

// ---------- quotas ----------

function monthlyPosts(ctx: AppContext, boardId: string): number {
  return (ctx.db.prepare("SELECT posts FROM usage_monthly WHERE board_id = ? AND month = ?").get(boardId, currentMonth(ctx)) as { posts: number } | undefined)?.posts ?? 0;
}

/** Checks and charges one post plus its bytes. Caller holds a transaction. */
function chargePost(ctx: AppContext, actor: Actor, board: BoardRow, bytes: number): void {
  const limits = boardLimits(ctx, board.id);
  const used = monthlyPosts(ctx, board.id);
  if (used >= limits.posts_per_month) {
    throw new OmbError("quota_exceeded", `This board has used its ${limits.posts_per_month} posts for this month. Reading and export still work.`, {
      allowance: "posts",
      used,
      limit: limits.posts_per_month,
      resets_at: nextMonthStart(ctx),
    });
  }
  if (board.storage_bytes + bytes > limits.storage_bytes) {
    throw new OmbError("quota_exceeded", "This board has no storage left for this message. Deleting old messages frees space.", {
      allowance: "storage",
      used: board.storage_bytes,
      limit: limits.storage_bytes,
      needed: bytes,
      resets_at: null,
    });
  }
  if (actor.kind === "agent") {
    const day = nowIso(ctx).slice(0, 10);
    const cap = board.agent_posts_per_day ?? limits.agent_posts_per_day;
    const today = (ctx.db.prepare("SELECT posts FROM agent_daily WHERE principal_id = ? AND day = ?").get(actor.id, day) as { posts: number } | undefined)?.posts ?? 0;
    if (today >= cap) {
      const tomorrow = new Date(Date.parse(day + "T00:00:00Z") + 86_400_000).toISOString();
      throw new OmbError("quota_exceeded", `This agent has posted its ${cap} messages for today`, { allowance: "agent_posts", used: today, limit: cap, resets_at: tomorrow });
    }
    ctx.db.prepare("INSERT INTO agent_daily (principal_id, day, posts) VALUES (?, ?, 1) ON CONFLICT(principal_id, day) DO UPDATE SET posts = posts + 1").run(actor.id, day);
  }
  ctx.db.prepare("INSERT INTO usage_monthly (board_id, month, posts) VALUES (?, ?, 1) ON CONFLICT(board_id, month) DO UPDATE SET posts = posts + 1").run(board.id, currentMonth(ctx));
  ctx.db.prepare("UPDATE boards SET storage_bytes = storage_bytes + ? WHERE id = ?").run(bytes, board.id);
}

export function usageWarnings(ctx: AppContext, boardId: string): AllowanceUsage[] | undefined {
  const board = getBoardRow(ctx, boardId);
  if (!board) return undefined;
  const limits = boardLimits(ctx, boardId);
  const out: AllowanceUsage[] = [];
  const posts = monthlyPosts(ctx, boardId);
  if (posts >= 0.8 * limits.posts_per_month) out.push({ allowance: "posts", used: posts, limit: limits.posts_per_month, unit: "count", resets_at: nextMonthStart(ctx), warning: true });
  if (board.storage_bytes >= 0.8 * limits.storage_bytes) out.push({ allowance: "storage", used: board.storage_bytes, limit: limits.storage_bytes, unit: "bytes", resets_at: null, warning: true });
  return out.length ? out : undefined;
}

function checkWriteRate(ctx: AppContext, actor: Actor, boardId: string, opts?: WriteOptions): void {
  if (opts?.internal) return;
  const r = ctx.config.rateLimits;
  if (actor.kind !== "integration") ctx.rate.hit(`w:p:${holderId(actor)}`, r.writes_per_minute_principal, 60_000);
  ctx.rate.hit(`w:b:${boardId}`, r.writes_per_minute_board, 60_000);
}

// ---------- inbox ----------

export function addInboxItem(
  ctx: AppContext,
  emit: Emit,
  item: { principalId: string; kind: "mention" | "reply" | "task_assigned"; boardId: string; threadId: string; messageId: string | null },
): void {
  const p = ctx.db.prepare("SELECT id, kind, owner_id, profile_name FROM principals WHERE id = ?").get(item.principalId) as MentionRow | undefined;
  if (!p || !activeMembership(ctx, item.boardId, { id: p.id, kind: p.kind, ownerId: p.owner_id, profile: p.profile_name })) return;
  const id = newId("ix");
  const info = ctx.db
    .prepare("INSERT INTO inbox_items (id, principal_id, kind, board_id, thread_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, item.principalId, item.kind, item.boardId, item.threadId, item.messageId, nowIso(ctx));
  emit({ kind: "inbox", principalId: item.principalId, seq: Number(info.lastInsertRowid), itemId: id, itemKind: item.kind, boardId: item.boardId, threadId: item.threadId, messageId: item.messageId });
}

// ---------- messages ----------

function follow(ctx: AppContext, principalId: string, threadId: string): void {
  ctx.db.prepare("INSERT INTO follows (principal_id, thread_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(principalId, threadId, nowIso(ctx));
}

interface InsertMessageInput {
  board: BoardRow;
  thread: ThreadRow;
  author: Actor;
  body: string;
  bytes: number;
  replyTo: string | null;
  mentions: string[];
  source?: MessageSource;
  isRoot: boolean;
}

/** Inserts a message with its event, follows and inbox items. Caller holds a transaction and has charged quota. */
function insertMessage(ctx: AppContext, emit: Emit, m: InsertMessageInput): MessageRow {
  const now = nowIso(ctx);
  const row: MessageRow = {
    id: newId("m"),
    board_id: m.board.id,
    thread_id: m.thread.id,
    author_id: m.author.id,
    body: m.body,
    body_bytes: m.bytes,
    deleted_at: null,
    reply_to: m.replyTo,
    source_platform: m.source?.platform ?? null,
    source_author_name: m.source?.author_name ?? null,
    source_url: m.source?.url ?? null,
    source_external_id: m.source?.external_id ?? null,
    created_at: now,
  };
  ctx.db
    .prepare(
      `INSERT INTO messages (id, board_id, thread_id, author_id, body, body_bytes, deleted_at, reply_to, source_platform, source_author_name, source_url, source_external_id, created_at)
       VALUES (@id, @board_id, @thread_id, @author_id, @body, @body_bytes, @deleted_at, @reply_to, @source_platform, @source_author_name, @source_url, @source_external_id, @created_at)`,
    )
    .run(row);
  for (const pid of m.mentions) ctx.db.prepare("INSERT INTO mentions (message_id, principal_id) VALUES (?, ?)").run(row.id, pid);
  const consecutive = m.author.kind === "agent" ? m.thread.consecutive_agent_messages + 1 : 0;
  ctx.db
    .prepare("UPDATE threads SET message_count = message_count + 1, last_activity_at = ?, consecutive_agent_messages = ? WHERE id = ?")
    .run(now, consecutive, m.thread.id);
  if (!m.isRoot) recordEvent(ctx, emit, { boardId: m.board.id, type: "message.created", threadId: m.thread.id, messageId: row.id, actorId: m.author.id });
  const followers = (ctx.db.prepare("SELECT principal_id FROM follows WHERE thread_id = ?").all(m.thread.id) as { principal_id: string }[]).map((r) => r.principal_id);
  if (m.author.kind !== "integration") follow(ctx, m.author.id, m.thread.id);
  ctx.db
    .prepare("INSERT INTO read_markers (principal_id, thread_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(principal_id, thread_id) DO UPDATE SET last_read_at = excluded.last_read_at")
    .run(m.author.id, m.thread.id, now);
  const mentioned = new Set(m.mentions);
  for (const pid of mentioned) {
    if (pid !== m.author.id) addInboxItem(ctx, emit, { principalId: pid, kind: "mention", boardId: m.board.id, threadId: m.thread.id, messageId: row.id });
  }
  if (!m.isRoot) {
    for (const pid of followers) {
      if (pid !== m.author.id && !mentioned.has(pid)) addInboxItem(ctx, emit, { principalId: pid, kind: "reply", boardId: m.board.id, threadId: m.thread.id, messageId: row.id });
    }
  }
  return row;
}

function loadThread(ctx: AppContext, id: string): ThreadRow {
  return ctx.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow;
}

export interface StartThreadInput {
  title: string;
  body: string;
  mentions?: string[] | undefined;
  labels?: Record<string, string> | undefined;
  task?: boolean | undefined;
  assignee?: string | undefined;
  idempotency_key?: string | undefined;
}

export function startThread(
  ctx: AppContext,
  actor: Actor,
  boardId: string,
  input: StartThreadInput,
  opts: WriteOptions = {},
): { thread: Thread; message: Message; usage_warning?: AllowanceUsage[] } {
  checkWriteRate(ctx, actor, boardId, opts);
  const result = tx(ctx, (emit) => {
    const { board } = requireMember(ctx, actor, boardId, "contributor");
    const { idempotency_key: key, ...payload } = input;
    return idempotent(ctx, actor, key, { op: "start_thread", boardId, ...payload }, () => {
      const title = validateTitle(input.title);
      const bytes = validateBody(ctx, input.body, board.id);
      const labels = validateLabels(input.labels ?? {});
      const mentions = resolveMentions(ctx, board.id, input.mentions);
      const kind: ThreadKind = input.task ? "task" : "discussion";
      let assignee: string | null = null;
      if (input.assignee !== undefined) {
        if (kind !== "task") throw invalid("assignee only applies to tasks");
        const [a] = resolveMentions(ctx, board.id, [input.assignee]);
        assignee = a!;
      }
      chargePost(ctx, actor, board, bytes + Buffer.byteLength(title, "utf8"));
      const now = nowIso(ctx);
      const threadId = newId("t");
      const state: TaskState | null = kind === "task" ? (assignee ? "claimed" : "open") : null;
      ctx.db
        .prepare(
          `INSERT INTO threads (id, board_id, title, kind, labels, task_state, task_assignee_id, task_claimed_at, created_by, created_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(threadId, board.id, title, kind, JSON.stringify(labels), state, assignee, assignee ? now : null, actor.id, now, now);
      const thread = loadThread(ctx, threadId);
      const row = insertMessage(ctx, emit, { board, thread, author: actor, body: input.body, bytes, replyTo: null, mentions, isRoot: true, ...(opts.source ? { source: opts.source } : {}) });
      recordEvent(ctx, emit, { boardId: board.id, type: "thread.created", threadId, messageId: row.id, actorId: actor.id });
      if (assignee && assignee !== actor.id) addInboxItem(ctx, emit, { principalId: assignee, kind: "task_assigned", boardId: board.id, threadId, messageId: row.id });
      return { thread: presentThread(ctx, loadThread(ctx, threadId), actor.id), message: presentMessage(ctx, row) };
    });
  });
  const warn = usageWarnings(ctx, boardId);
  return { ...result, ...(warn ? { usage_warning: warn } : {}) };
}

export interface ReplyInput {
  body: string;
  reply_to?: string | undefined;
  mentions?: string[] | undefined;
  idempotency_key?: string | undefined;
}

function replyInTx(ctx: AppContext, emit: Emit, actor: Actor, threadId: string, input: ReplyInput, opts: WriteOptions): { message: Message } {
  const { board, thread } = requireThread(ctx, actor, threadId, "contributor");
  const { idempotency_key: key, ...payload } = input;
  return idempotent(ctx, actor, key, { op: "reply", threadId, ...payload }, () => {
    const bytes = validateBody(ctx, input.body, board.id);
    const mentions = resolveMentions(ctx, board.id, input.mentions);
    if (input.reply_to) {
      const target = ctx.db.prepare("SELECT thread_id FROM messages WHERE id = ?").get(input.reply_to) as { thread_id: string } | undefined;
      if (!target || target.thread_id !== thread.id) throw invalid("reply_to must be a message in the same thread");
    }
    if (actor.kind === "agent") {
      const limit = board.agent_consecutive_limit ?? boardLimits(ctx, board.id).agent_consecutive_limit;
      if (thread.consecutive_agent_messages >= limit) {
        throw new OmbError("agent_loop_guard", `Agents have posted ${limit} messages in a row in this thread; a person needs to post before agents can continue`, {
          limit,
          consecutive: thread.consecutive_agent_messages,
        });
      }
    }
    chargePost(ctx, actor, board, bytes);
    const row = insertMessage(ctx, emit, { board, thread, author: actor, body: input.body, bytes, replyTo: input.reply_to ?? null, mentions, isRoot: false, ...(opts.source ? { source: opts.source } : {}) });
    return { message: presentMessage(ctx, row) };
  });
}

export function reply(ctx: AppContext, actor: Actor, threadId: string, input: ReplyInput, opts: WriteOptions = {}): { message: Message; usage_warning?: AllowanceUsage[] } {
  const thread = ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(threadId) as { board_id: string } | undefined;
  if (thread) checkWriteRate(ctx, actor, thread.board_id, opts);
  const result = tx(ctx, (emit) => replyInTx(ctx, emit, actor, threadId, input, opts));
  const warn = thread ? usageWarnings(ctx, thread.board_id) : undefined;
  return { ...result, ...(warn ? { usage_warning: warn } : {}) };
}

export function deleteMessage(ctx: AppContext, actor: Actor, messageId: string): { message: Message } {
  return tx(ctx, (emit) => {
    const row = ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as MessageRow | undefined;
    if (!row) throw notFound("Message");
    const { membership } = requireMember(ctx, actor, row.board_id, "reader", "Message");
    const ownerId = (ctx.db.prepare("SELECT owner_id FROM principals WHERE id = ?").get(row.author_id) as { owner_id: string | null } | undefined)?.owner_id ?? null;
    if (!canChangeMessage(actor, { id: row.author_id, owner_id: ownerId }, membership.role)) {
      throw forbidden(actor.profile ? "A profile can delete only what it wrote" : "You can delete your own messages; owners can delete any");
    }
    if (!row.deleted_at) {
      const now = nowIso(ctx);
      ctx.db.prepare("UPDATE messages SET body = NULL, deleted_at = ?, body_bytes = 0 WHERE id = ?").run(now, row.id);
      ctx.db.prepare("DELETE FROM mentions WHERE message_id = ?").run(row.id);
      ctx.db.prepare("UPDATE boards SET storage_bytes = MAX(0, storage_bytes - ?) WHERE id = ?").run(row.body_bytes, row.board_id);
      recordEvent(ctx, emit, { boardId: row.board_id, type: "message.deleted", threadId: row.thread_id, messageId: row.id, actorId: actor.id });
    }
    return { message: presentMessage(ctx, ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(row.id) as MessageRow) };
  });
}

// ---------- reads ----------

export function boardCursor(ctx: AppContext, boardId: string): string {
  const max = (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
  return encodeCursor("b", boardId, max);
}

export function getThread(
  ctx: AppContext,
  actor: Actor,
  threadId: string,
  page: { page_cursor?: string | undefined; limit?: number | undefined } = {},
): { thread: Thread; messages: Message[]; next_page_cursor: string | null; as_of: string } {
  const out = read(ctx, () => {
    const { thread } = requireThread(ctx, actor, threadId);
    const limit = Math.min(page.limit ?? 50, 200);
    const after = decodePage(page.page_cursor, `msgs:${thread.id}`);
    const rows = (
      after
        ? ctx.db
            .prepare("SELECT * FROM messages WHERE thread_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?")
            .all(thread.id, after[0], after[0], after[1], limit + 1)
        : ctx.db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT ?").all(thread.id, limit + 1)
    ) as MessageRow[];
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      thread: presentThread(ctx, thread, actor.id),
      messages: presentMessages(ctx, pageRows),
      next_page_cursor: more && last ? encodePage(`msgs:${thread.id}`, last.created_at, last.id) : null,
      as_of: boardCursor(ctx, thread.board_id),
    };
  });
  ctx.db
    .prepare("INSERT INTO read_markers (principal_id, thread_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(principal_id, thread_id) DO UPDATE SET last_read_at = excluded.last_read_at")
    .run(actor.id, threadId, nowIso(ctx));
  out.thread.unread_count = 0;
  return out;
}

export interface ListThreadsInput {
  filter?: "all" | "following" | "unread" | undefined;
  kind?: ThreadKind | undefined;
  task_state?: TaskState | undefined;
  assignee?: string | undefined;
  labels?: Record<string, string> | undefined;
  page_cursor?: string | undefined;
  limit?: number | undefined;
}

function labelClauses(labels: Record<string, string> | undefined, params: unknown[]): string {
  let sql = "";
  for (const [k, v] of Object.entries(validateLabels(labels ?? {}))) {
    sql += ` AND json_extract(t.labels, '$."${k}"') = ?`;
    params.push(v);
  }
  return sql;
}

export function listThreads(ctx: AppContext, actor: Actor, boardId: string, input: ListThreadsInput = {}): { threads: Thread[]; next_page_cursor: string | null; as_of: string } {
  return read(ctx, () => {
    requireMember(ctx, actor, boardId);
    const limit = Math.min(input.limit ?? 25, 100);
    const params: unknown[] = [boardId];
    let sql = "SELECT t.* FROM threads t WHERE t.board_id = ?";
    if (input.filter === "following") {
      sql += " AND EXISTS (SELECT 1 FROM follows f WHERE f.thread_id = t.id AND f.principal_id = ?)";
      params.push(actor.id);
    } else if (input.filter === "unread") {
      sql += ` AND EXISTS (SELECT 1 FROM messages m LEFT JOIN read_markers rm ON rm.thread_id = m.thread_id AND rm.principal_id = ?
               WHERE m.thread_id = t.id AND m.author_id != ? AND m.deleted_at IS NULL AND (rm.last_read_at IS NULL OR m.created_at > rm.last_read_at))`;
      params.push(actor.id, actor.id);
    }
    if (input.kind) {
      sql += " AND t.kind = ?";
      params.push(input.kind);
    }
    if (input.task_state) {
      sql += " AND t.task_state = ?";
      params.push(input.task_state);
    }
    if (input.assignee) {
      // A person's ID covers their profiles; "me" as a profile is just that profile.
      const ids = input.assignee === "me" && actor.profile ? [actor.id] : coveredPrincipalIds(ctx, input.assignee === "me" ? actor.id : input.assignee);
      sql += ` AND t.task_assignee_id IN (${ids.map(() => "?").join(",")})`;
      params.push(...ids);
    }
    sql += labelClauses(input.labels, params);
    const after = decodePage(input.page_cursor, `threads:${boardId}`);
    if (after) {
      sql += " AND (t.last_activity_at < ? OR (t.last_activity_at = ? AND t.id < ?))";
      params.push(after[0], after[0], after[1]);
    }
    sql += " ORDER BY t.last_activity_at DESC, t.id DESC LIMIT ?";
    params.push(limit + 1);
    const rows = ctx.db.prepare(sql).all(...params) as ThreadRow[];
    const more = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      threads: presentThreads(ctx, pageRows, actor.id),
      next_page_cursor: more && last ? encodePage(`threads:${boardId}`, last.last_activity_at, last.id) : null,
      as_of: boardCursor(ctx, boardId),
    };
  });
}

export function setFollow(ctx: AppContext, actor: Actor, threadId: string, following: boolean): { thread_id: string; following: boolean } {
  const { thread } = requireThread(ctx, actor, threadId);
  if (following) follow(ctx, actor.id, thread.id);
  else ctx.db.prepare("DELETE FROM follows WHERE principal_id = ? AND thread_id = ?").run(actor.id, thread.id);
  return { thread_id: thread.id, following };
}

// ---------- labels and tasks ----------

export function setLabels(ctx: AppContext, actor: Actor, threadId: string, input: { set?: Record<string, string> | undefined; remove?: string[] | undefined }): { thread: Thread } {
  checkWriteRate(ctx, actor, (ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(threadId) as { board_id: string } | undefined)?.board_id ?? "", {});
  return tx(ctx, (emit) => {
    const { thread } = requireThread(ctx, actor, threadId, "contributor");
    const current = JSON.parse(thread.labels) as Record<string, string>;
    const both = (input.remove ?? []).filter((k) => input.set && k in input.set);
    if (both.length) throw invalid(`Label ${both.map((k) => `"${k}"`).join(", ")} is in both set and remove`);
    for (const k of input.remove ?? []) delete current[k];
    const next = validateLabels({ ...current, ...(input.set ?? {}) });
    const before = JSON.parse(thread.labels) as Record<string, string>;
    const same = Object.keys(next).length === Object.keys(before).length && Object.entries(next).every(([k, v]) => before[k] === v);
    if (same) return { thread: presentThread(ctx, thread, actor.id) };
    ctx.db.prepare("UPDATE threads SET labels = ?, last_activity_at = ? WHERE id = ?").run(JSON.stringify(next), nowIso(ctx), thread.id);
    recordEvent(ctx, emit, { boardId: thread.board_id, type: "thread.updated", threadId: thread.id, actorId: actor.id });
    return { thread: presentThread(ctx, loadThread(ctx, thread.id), actor.id) };
  });
}

export function claimTask(
  ctx: AppContext,
  actor: Actor,
  input: { thread_id?: string | undefined; board_id?: string | undefined; labels?: Record<string, string> | undefined },
): { thread: Thread } {
  if ((input.thread_id ? 1 : 0) + (input.board_id ? 1 : 0) !== 1) throw invalid("Pass exactly one of thread_id or board_id");
  return tx(ctx, (emit) => {
    let thread: ThreadRow;
    if (input.thread_id) {
      thread = requireThread(ctx, actor, input.thread_id, "contributor").thread;
      if (thread.kind !== "task") throw new OmbError("task_not_claimable", "This thread is not a task", { state: null });
      if (thread.task_state === "claimed") {
        if (thread.task_assignee_id === actor.id) return { thread: presentThread(ctx, thread, actor.id) };
        throw new OmbError("task_already_claimed", "Someone else has claimed this task", { assignee: thread.task_assignee_id ? refOf(ctx, thread.task_assignee_id) : null });
      }
      if (thread.task_state !== "open") throw new OmbError("task_not_claimable", `This task is ${thread.task_state}`, { state: thread.task_state });
    } else {
      requireMember(ctx, actor, input.board_id!, "contributor");
      const params: unknown[] = [input.board_id];
      const sql = "SELECT t.* FROM threads t WHERE t.board_id = ? AND t.kind = 'task' AND t.task_state = 'open'" + labelClauses(input.labels, params) + " ORDER BY t.created_at, t.id LIMIT 1";
      const next = ctx.db.prepare(sql).get(...params) as ThreadRow | undefined;
      if (!next) throw new OmbError("no_task_available", "No open task matches");
      thread = next;
    }
    const now = nowIso(ctx);
    const info = ctx.db
      .prepare("UPDATE threads SET task_state = 'claimed', task_assignee_id = ?, task_claimed_at = ?, last_activity_at = ? WHERE id = ? AND task_state = 'open'")
      .run(actor.id, now, now, thread.id);
    if (info.changes === 0) {
      const winner = loadThread(ctx, thread.id).task_assignee_id;
      throw new OmbError("task_already_claimed", "Someone else claimed this task first", { assignee: winner ? refOf(ctx, winner) : null });
    }
    follow(ctx, actor.id, thread.id);
    recordEvent(ctx, emit, { boardId: thread.board_id, type: "thread.updated", threadId: thread.id, actorId: actor.id });
    return { thread: presentThread(ctx, loadThread(ctx, thread.id), actor.id) };
  });
}

export function updateTask(
  ctx: AppContext,
  actor: Actor,
  threadId: string,
  input: { action: TaskAction; result?: string | undefined; idempotency_key?: string | undefined },
): { thread: Thread; message: Message | null } {
  const boardId = (ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(threadId) as { board_id: string } | undefined)?.board_id;
  if (boardId) checkWriteRate(ctx, actor, boardId, {});
  return tx(ctx, (emit) => {
    const { thread, membership } = requireThread(ctx, actor, threadId, "contributor");
    const { idempotency_key: key, ...payload } = input;
    return idempotent(ctx, actor, key, { op: "update_task", threadId, ...payload }, () => {
      if (thread.kind !== "task" || !thread.task_state) throw new OmbError("task_not_claimable", "This thread is not a task", { state: null });
      const isOwner = membership.role === "owner";
      const isAssignee = thread.task_assignee_id === actor.id;
      const isCreator = thread.created_by === actor.id;
      const state = thread.task_state;
      const now = nowIso(ctx);
      let next: TaskState;
      switch (input.action) {
        case "complete":
          if (!(isAssignee || isOwner)) throw forbidden("Only the assignee or the board owner can complete this task");
          if (state !== "claimed" && !(isOwner && state === "open")) throw new OmbError("conflict", `A ${state} task can't be completed`, { state });
          next = "done";
          break;
        case "release":
          if (!(isAssignee || isOwner)) throw forbidden("Only the assignee or the board owner can release this task");
          if (state !== "claimed") throw new OmbError("conflict", `A ${state} task can't be released`, { state });
          next = "open";
          break;
        case "cancel":
          if (!(isCreator || isOwner)) throw forbidden("Only the task's creator or the board owner can cancel it");
          if (state !== "open" && state !== "claimed") throw new OmbError("conflict", `A ${state} task can't be cancelled`, { state });
          next = "cancelled";
          break;
        case "reopen":
          if (!(isCreator || isOwner)) throw forbidden("Only the task's creator or the board owner can reopen it");
          if (state !== "done" && state !== "cancelled") throw new OmbError("conflict", `A ${state} task can't be reopened`, { state });
          next = "open";
          break;
        default:
          throw invalid("Unknown task action");
      }
      let message: Message | null = null;
      if (input.result !== undefined && input.result.trim()) {
        message = replyInTx(ctx, emit, actor, thread.id, { body: input.result }, {}).message;
      }
      const assignee = next === "open" ? null : next === "done" ? (thread.task_assignee_id ?? actor.id) : thread.task_assignee_id;
      ctx.db
        .prepare("UPDATE threads SET task_state = ?, task_assignee_id = ?, task_claimed_at = ?, task_completed_at = ?, last_activity_at = ? WHERE id = ?")
        .run(next, assignee, next === "open" ? null : thread.task_claimed_at, next === "done" ? now : null, now, thread.id);
      recordEvent(ctx, emit, { boardId: thread.board_id, type: "thread.updated", threadId: thread.id, actorId: actor.id });
      return { thread: presentThread(ctx, loadThread(ctx, thread.id), actor.id), message };
    });
  });
}
