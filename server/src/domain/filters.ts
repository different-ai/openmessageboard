/**
 * Message filters shared by read_messages, get_changes, wait_for_activity, the browser stream and watchers.
 *
 * A message matches when it passes every filter given. A change matches when its message does; for
 * `thread.updated` (which names no message) that is the thread's root message. Changes are matched against
 * the current state of their thread and message, like the rest of the change log.
 *
 * Channel access applies everywhere: rows in channels the viewer can't read are left out (`threadAccessSql`), the
 * same rule `boardChanges` uses. Extension points: `resolveMember` (handle formats) and `labelSql` (message labels).
 */
import {
  LABEL_KEY_PATTERN,
  MAX_FILTER_TEXT,
  MESSAGE_SOURCES,
  READ_MESSAGES_DEFAULT,
  READ_MESSAGES_MAX,
  type EventType,
  type Message,
  type MessageSourceName,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { read } from "../context.js";
import type { DB } from "../db/index.js";
import { OmbError, invalid, notFound } from "../errors.js";
import { requireMember } from "./access.js";
import { decodeCursor, encodeCursor } from "./cursors.js";
import type { Actor, EventRow, MessageRow } from "./model.js";
import { CHANNEL_FILTER_PATTERN, MAX_CHANNEL_CHARS } from "@openmessageboard/protocol";
import { presentMessages } from "./present.js";
import { ChannelAccess, channelFilterSql, readableSql } from "./grants.js";
import { coveredPrincipalIds, findProfile } from "./profiles.js";

export interface FilterInput {
  channel?: string | undefined;
  by?: string | undefined;
  mentions?: string | undefined;
  labels?: Record<string, string> | undefined;
  text?: string | undefined;
  source?: MessageSourceName | undefined;
  re?: string | undefined;
  types?: EventType[] | undefined;
}

/** A filter with handles resolved to principal IDs and the thread resolved. */
export interface ResolvedFilter {
  /** A channel, or a path ending in `/` for its subtree. */
  channel?: string;
  /** Author principal IDs (a person and the agents that act for them). */
  authors?: string[];
  mentions?: string;
  /** Label key and the values that match it. */
  labels?: [string, string[]][];
  /** Lowercased. */
  text?: string;
  source?: MessageSourceName;
  threadId?: string;
  types?: EventType[];
}

const CREATE_TYPES = "('thread.created','message.created')";
/** Board events scanned per filtered page; a page can come back empty with has_more when none match. */
const SCAN_WINDOW = 1000;
/** Principal IDs minted by this server. Values that are neither a handle nor one of these are rejected. */
const PRINCIPAL_ID = /^p_[0-9A-Z]{26}$/;

export const FILTER_KEYS = ["channel", "by", "mentions", "labels", "text", "source", "re"] as const;

export function hasFilterInput(input: FilterInput): boolean {
  return FILTER_KEYS.some((k) => input[k] !== undefined) || input.types !== undefined;
}

export function isEmptyFilter(f: ResolvedFilter | undefined): boolean {
  return !f || (!f.channel && !f.authors && !f.mentions && !f.labels && f.text === undefined && !f.source && !f.threadId && !f.types);
}

/** Criteria that need the change's message (everything except the thread and the change type). */
function hasMessageCriteria(f: ResolvedFilter): boolean {
  return !!(f.authors || f.mentions || f.labels || f.text !== undefined || f.source);
}

const functionsReady = new WeakSet<DB>();
/** SQLite's lower() folds ASCII only; register a Unicode-aware one for text filters. */
function ensureSqlFunctions(db: DB): void {
  if (functionsReady.has(db)) return;
  db.function("omb_lower", { deterministic: true }, (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v));
  functionsReady.add(db);
}

/**
 * A member reference: `me`, a member handle on the board (with or without `@`), a profile handle
 * (`<person-handle>/<profile>`), or a principal ID. A principal ID is accepted without checking that it exists,
 * so the answer never reveals who exists.
 */
export function resolveMember(ctx: AppContext, actor: Actor, boardId: string, raw: string, field: string): string {
  const v = raw.trim().replace(/^@/, "");
  if (!v) throw invalid(`${field} can't be empty`);
  if (v === "me") return actor.id;
  const memberByHandle = (handle: string) =>
    (ctx.db.prepare("SELECT principal_id FROM memberships WHERE board_id = ? AND handle = ?").get(boardId, handle) as { principal_id: string } | undefined)?.principal_id;
  const byHandle = memberByHandle(v.toLowerCase()) ?? memberByHandle(v);
  if (byHandle) return byHandle;
  const slash = v.indexOf("/");
  if (slash > 0) {
    const person = memberByHandle(v.slice(0, slash).toLowerCase());
    const profile = person ? findProfile(ctx, person, v.slice(slash + 1)) : undefined;
    if (profile) return profile.id;
  }
  if (PRINCIPAL_ID.test(v)) return v;
  throw invalid(`${field}: no member of this board has the handle "${v}"`, { field });
}

/** A person covers their profiles and the agents that act for them; an agent or a profile covers only itself. */
function authorsOf(ctx: AppContext, principalId: string): string[] {
  const covered = coveredPrincipalIds(ctx, principalId);
  if (covered.length === 1 && covered[0] === principalId) {
    const kind = (ctx.db.prepare("SELECT kind FROM principals WHERE id = ?").get(principalId) as { kind: string } | undefined)?.kind;
    if (kind !== "human") return covered;
  }
  const agents = ctx.db.prepare("SELECT id FROM principals WHERE owner_id = ? AND kind = 'agent'").all(principalId) as { id: string }[];
  return [...new Set([...covered, ...agents.map((a) => a.id)])];
}

/** Whether the viewer can read the channel of a thread on the board. */
function canReadThread(ctx: AppContext, viewer: Actor, boardId: string, threadId: string): boolean {
  const row = ctx.db.prepare("SELECT channel FROM threads WHERE id = ? AND board_id = ?").get(threadId, boardId) as { channel: string } | undefined;
  return !!row && ChannelAccess.load(ctx, boardId, viewer).can(row.channel, "read");
}

/**
 * A thread on the board, named by its ID or by any message in it. Unknown threads, other boards' threads and
 * threads in channels the viewer can't read are all not found.
 */
export function resolveThreadRef(ctx: AppContext, viewer: Actor, boardId: string, raw: string): string {
  const thread = ctx.db.prepare("SELECT id, board_id FROM threads WHERE id = ?").get(raw) as { id: string; board_id: string } | undefined;
  const msg = thread ? undefined : (ctx.db.prepare("SELECT thread_id, board_id FROM messages WHERE id = ?").get(raw) as { thread_id: string; board_id: string } | undefined);
  const id = thread?.board_id === boardId ? thread.id : msg?.board_id === boardId ? msg.thread_id : undefined;
  if (!id || !canReadThread(ctx, viewer, boardId, id)) throw notFound("Thread");
  return id;
}

/** The board of a message or thread ID, so a wait can name only the message it follows. Unknown IDs are not found. */
export function boardOfRef(ctx: AppContext, raw: string): string {
  const row = (ctx.db.prepare("SELECT board_id FROM messages WHERE id = ?").get(raw) ?? ctx.db.prepare("SELECT board_id FROM threads WHERE id = ?").get(raw)) as
    | { board_id: string }
    | undefined;
  if (!row) throw notFound("Message");
  return row.board_id;
}

export function resolveFilter(ctx: AppContext, actor: Actor, boardId: string, input: FilterInput): ResolvedFilter {
  const f: ResolvedFilter = {};
  if (input.channel !== undefined) {
    if (input.channel.length > MAX_CHANNEL_CHARS + 1 || !CHANNEL_FILTER_PATTERN.test(input.channel)) {
      throw invalid("channel is a channel path, or a path ending in '/' for the channel and everything under it", { field: "channel" });
    }
    f.channel = input.channel;
  }
  if (input.by !== undefined) f.authors = authorsOf(ctx, resolveMember(ctx, actor, boardId, input.by, "by"));
  if (input.mentions !== undefined) f.mentions = resolveMember(ctx, actor, boardId, input.mentions, "mentions");
  if (input.labels !== undefined) {
    const entries = Object.entries(input.labels);
    for (const [k, v] of entries) {
      if (!LABEL_KEY_PATTERN.test(k)) throw invalid(`Label key "${k}" must be lowercase letters, digits, '.', '_' or '-' (up to 32)`);
      if (typeof v !== "string" || v.length === 0) throw invalid(`Label "${k}" needs a value`);
    }
    if (entries.length) f.labels = entries.map(([k, v]) => [k, [...new Set(v.split("|").filter(Boolean))]]);
  }
  if (input.text !== undefined) {
    const t = input.text.trim();
    if (!t) throw invalid("text can't be empty");
    if ([...t].length > MAX_FILTER_TEXT) throw invalid(`text can be up to ${MAX_FILTER_TEXT} characters`);
    f.text = t.toLowerCase();
  }
  if (input.source !== undefined) {
    if (!(MESSAGE_SOURCES as readonly string[]).includes(input.source)) throw invalid(`source must be one of ${MESSAGE_SOURCES.join(", ")}`);
    f.source = input.source;
  }
  if (input.re !== undefined) f.threadId = resolveThreadRef(ctx, actor, boardId, input.re);
  if (input.types !== undefined) f.types = [...new Set(input.types)];
  return f;
}

/** Thread labels. When messages carry labels of their own, match those here too (either one). */
function labelSql(labels: [string, string[]][], params: unknown[], m: string, t: string): string {
  let sql = "";
  for (const [k, values] of labels) {
    // Keys are validated against LABEL_KEY_PATTERN, so they are safe inside the JSON path.
    sql += ` AND ${m}.deleted_at IS NULL AND json_extract(${t}.labels, '$."${k}"') IN (${values.map(() => "?").join(",")})`;
    params.push(...values);
  }
  return sql;
}

/** Message criteria as SQL over a message alias `m` joined to its thread `t`. */
function messageCriteriaSql(f: ResolvedFilter, params: unknown[], m = "m", t = "t"): string {
  let sql = "";
  if (f.authors) {
    sql += ` AND ${m}.author_id IN (${f.authors.map(() => "?").join(",")})`;
    params.push(...f.authors);
  }
  if (f.mentions) {
    sql += ` AND EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = ${m}.id AND x.principal_id = ?)`;
    params.push(f.mentions);
  }
  if (f.text !== undefined) {
    sql += ` AND ${m}.body IS NOT NULL AND instr(omb_lower(${m}.body), ?) > 0`;
    params.push(f.text);
  }
  if (f.source) {
    if (f.source === "board") sql += ` AND ${m}.source_platform IS NULL`;
    else {
      sql += ` AND ${m}.source_platform = ?`;
      params.push(f.source);
    }
  }
  if (f.labels) sql += labelSql(f.labels, params, m, t);
  return sql;
}

/** Keeps rows whose thread (alias `t`) is in a channel the viewer can read, the rule `boardChanges` uses. */
export function threadAccessSql(ctx: AppContext, viewer: Actor, boardId: string, threadAlias: string, params: unknown[]): string {
  return readableSql(`${threadAlias}.channel`, ChannelAccess.load(ctx, boardId, viewer).readableChannels(ctx), params);
}

function purgedUpto(ctx: AppContext): number {
  return Number((ctx.db.prepare("SELECT value FROM meta WHERE key = 'events_purged_upto'").get() as { value: string }).value);
}

function maxSeq(ctx: AppContext): number {
  return (ctx.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number }).s;
}

function expired(boardId: string): OmbError {
  return new OmbError("cursor_expired", "That point is older than the server keeps changes. Read again without it and follow on from the result's cursor.", {
    resync: true,
    board_id: boardId,
  });
}

/** The seq of the change that created a message, or null when that change is no longer kept. */
function createSeq(ctx: AppContext, boardId: string, messageId: string): number | null {
  const row = ctx.db
    .prepare(`SELECT seq FROM events WHERE message_id = ? AND board_id = ? AND type IN ${CREATE_TYPES} ORDER BY seq LIMIT 1`)
    .get(messageId, boardId) as { seq: number } | undefined;
  return row?.seq ?? null;
}

type Point = { kind: "message"; id: string; rowid: number } | { kind: "cursor"; seq: number };

/**
 * Parses `after`/`before`: a message ID, a thread ID (its root message) or a board cursor, all on this board.
 * A message or thread the viewer can't read is not found, like an unknown one.
 */
function resolvePoint(ctx: AppContext, viewer: Actor, boardId: string, raw: string, field: string): Point {
  const msg = ctx.db.prepare("SELECT id, board_id, thread_id, rowid AS r FROM messages WHERE id = ?").get(raw) as
    | { id: string; board_id: string; thread_id: string; r: number }
    | undefined;
  if (msg) {
    if (msg.board_id !== boardId || !canReadThread(ctx, viewer, boardId, msg.thread_id)) throw notFound("Message");
    return { kind: "message", id: msg.id, rowid: msg.r };
  }
  const thread = ctx.db.prepare("SELECT id, board_id FROM threads WHERE id = ?").get(raw) as { id: string; board_id: string } | undefined;
  if (thread) {
    if (thread.board_id !== boardId || !canReadThread(ctx, viewer, boardId, thread.id)) throw notFound("Thread");
    const root = ctx.db.prepare("SELECT id, rowid AS r FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1").get(thread.id) as { id: string; r: number } | undefined;
    if (!root) throw notFound("Thread");
    return { kind: "message", id: root.id, rowid: root.r };
  }
  let seq: number;
  try {
    seq = decodeCursor(raw, "b", boardId).s;
  } catch {
    throw invalid(`${field} must be a message ID, a thread ID or a cursor of this board`);
  }
  if (seq < purgedUpto(ctx)) throw expired(boardId);
  return { kind: "cursor", seq };
}

/** The change-log position just after `after` (for get_changes, wait_for_activity and the stream). */
export function seqAfter(ctx: AppContext, viewer: Actor, boardId: string, after: string): number {
  const p = resolvePoint(ctx, viewer, boardId, after, "after");
  if (p.kind === "cursor") return p.seq;
  const seq = createSeq(ctx, boardId, p.id);
  if (seq === null) throw expired(boardId);
  return seq;
}

/** A board cursor positioned just after `after`. */
export function cursorAfter(ctx: AppContext, viewer: Actor, boardId: string, after: string): string {
  return encodeCursor("b", boardId, seqAfter(ctx, viewer, boardId, after));
}

/** First message rowid created after change `seq`, or null when none. Rowid order is commit order within a board. */
function firstRowidAfterSeq(ctx: AppContext, boardId: string, seq: number): number | null {
  const row = ctx.db
    .prepare(`SELECT MIN(m.rowid) AS r FROM events e JOIN messages m ON m.id = e.message_id WHERE e.board_id = ? AND e.seq > ? AND e.type IN ${CREATE_TYPES}`)
    .get(boardId, seq) as { r: number | null };
  return row.r;
}

/**
 * Board events after `afterSeq` that match `f`, oldest first, at most `limit`. Scans at most SCAN_WINDOW board
 * events; `windowEnd` is the last seq scanned when more events remain past the window, else null.
 */
export function filteredEventRows(
  ctx: AppContext,
  viewer: Actor,
  boardId: string,
  afterSeq: number,
  f: ResolvedFilter,
  limit: number,
): { rows: EventRow[]; windowEnd: number | null } {
  ensureSqlFunctions(ctx.db);
  const end = ctx.db.prepare("SELECT seq FROM events WHERE board_id = ? AND seq > ? ORDER BY seq LIMIT 1 OFFSET ?").get(boardId, afterSeq, SCAN_WINDOW - 1) as
    | { seq: number }
    | undefined;
  const windowEnd = end?.seq ?? null;
  const needsMessage = hasMessageCriteria(f);
  const params: unknown[] = [];
  let sql = "SELECT e.* FROM events e LEFT JOIN threads t ON t.id = e.thread_id";
  if (needsMessage) {
    sql += " JOIN messages m ON m.id = COALESCE(e.message_id, (SELECT r.id FROM messages r WHERE r.thread_id = e.thread_id ORDER BY r.created_at, r.id LIMIT 1))";
  }
  sql += " WHERE e.board_id = ? AND e.seq > ?";
  params.push(boardId, afterSeq);
  if (windowEnd !== null) {
    sql += " AND e.seq <= ?";
    params.push(windowEnd);
  }
  if (f.threadId) {
    sql += " AND e.thread_id = ?";
    params.push(f.threadId);
  }
  if (f.types) {
    sql += ` AND e.type IN (${f.types.map(() => "?").join(",")})`;
    params.push(...f.types);
  }
  if (f.channel) sql += ` AND t.id IS NOT NULL${channelFilterSql("t.channel", f.channel, params)}`;
  if (needsMessage) sql += messageCriteriaSql(f, params);
  // Changes in channels the viewer can't read are left out; changes without a thread are board-wide.
  const access = threadAccessSql(ctx, viewer, boardId, "t", params);
  if (access) sql += ` AND (e.thread_id IS NULL OR (t.id IS NOT NULL${access}))`;
  sql += " ORDER BY e.seq LIMIT ?";
  params.push(limit);
  return { rows: ctx.db.prepare(sql).all(...params) as EventRow[], windowEnd };
}

/**
 * A page of filtered changes after `afterSeq`. The cursor skips past scanned changes that did not match, so a
 * page may be empty with `has_more: true` when many changes in a row do not match.
 */
export function filteredPage(ctx: AppContext, viewer: Actor, boardId: string, afterSeq: number, f: ResolvedFilter, n: number): { rows: EventRow[]; next: number; more: boolean } {
  const { rows, windowEnd } = filteredEventRows(ctx, viewer, boardId, afterSeq, f, n + 1);
  if (rows.length > n) {
    const page = rows.slice(0, n);
    return { rows: page, next: page[page.length - 1]!.seq, more: true };
  }
  if (windowEnd !== null) return { rows, next: windowEnd, more: true };
  return { rows, next: Math.max(rows[rows.length - 1]?.seq ?? afterSeq, maxSeq(ctx)), more: false };
}

export interface ReadMessagesInput extends FilterInput {
  after?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}

/** read_messages: matching messages on a board, oldest first. */
export function readMessages(ctx: AppContext, actor: Actor, boardId: string, input: ReadMessagesInput): { messages: Message[]; cursor: string; has_more: boolean } {
  return read(ctx, () => {
    requireMember(ctx, actor, boardId);
    if (input.after !== undefined && input.before !== undefined) throw invalid("Pass after or before, not both");
    ensureSqlFunctions(ctx.db);
    const f = resolveFilter(ctx, actor, boardId, { ...input, types: undefined });
    const limit = Math.min(Math.max(input.limit ?? READ_MESSAGES_DEFAULT, 1), READ_MESSAGES_MAX);
    const params: unknown[] = [boardId];
    let sql = "SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.board_id = ?";
    if (f.threadId) {
      sql += " AND m.thread_id = ?";
      params.push(f.threadId);
    }
    sql += channelFilterSql("t.channel", f.channel, params);
    sql += messageCriteriaSql(f, params);
    sql += threadAccessSql(ctx, actor, boardId, "t", params);
    let ascending = false;
    if (input.after !== undefined) {
      const p = resolvePoint(ctx, actor, boardId, input.after, "after");
      const bound = p.kind === "message" ? p.rowid : (firstRowidAfterSeq(ctx, boardId, p.seq) ?? Number.MAX_SAFE_INTEGER) - 1;
      sql += " AND m.rowid > ?";
      params.push(bound);
      ascending = true;
    } else if (input.before !== undefined) {
      const p = resolvePoint(ctx, actor, boardId, input.before, "before");
      const bound = p.kind === "message" ? p.rowid : (firstRowidAfterSeq(ctx, boardId, p.seq) ?? Number.MAX_SAFE_INTEGER);
      sql += " AND m.rowid < ?";
      params.push(bound);
    }
    sql += ` ORDER BY m.rowid ${ascending ? "ASC" : "DESC"} LIMIT ?`;
    params.push(limit + 1);
    const rows = ctx.db.prepare(sql).all(...params) as MessageRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!ascending) page.reverse();
    let seq = maxSeq(ctx);
    if (ascending && more) {
      // Follow on from the last returned message, not from now, so nothing between is skipped.
      const last = page[page.length - 1]!;
      seq = createSeq(ctx, boardId, last.id) ?? purgedUpto(ctx);
    }
    return { messages: presentMessages(ctx, page), cursor: encodeCursor("b", boardId, seq), has_more: more };
  });
}
