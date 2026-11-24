import {
  boardUrl,
  threadUrl,
  type Board,
  type ExternalLink,
  type Member,
  type Message,
  type PrincipalRef,
  type SyncPlatform,
  type TaskNeed,
  type TaskState,
  type Thread,
  type InboxItem,
  type Invite,
} from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import type { BoardRow, InboxRow, InviteRow, MembershipRow, MessageRow, PrincipalRow, ThreadRow } from "./model.js";
import { boardLimits } from "./plans.js";
import { messageExtras } from "./message-extras.js";
import { ChannelAccess } from "./grants.js";

/** Resolves principal references in bulk; agents carry their owner as `via`. */
export function principalRefs(ctx: AppContext, ids: Iterable<string | null | undefined>): Map<string, PrincipalRef> {
  const unique = [...new Set([...ids].filter((x): x is string => typeof x === "string"))];
  const out = new Map<string, PrincipalRef>();
  if (unique.length === 0) return out;
  const rows: (PrincipalRow & { owner_name: string | null })[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    rows.push(
      ...(ctx.db
        .prepare(
          `SELECT p.*, o.display_name AS owner_name FROM principals p LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk) as (PrincipalRow & { owner_name: string | null })[]),
    );
  }
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      kind: r.kind,
      display_name: r.display_name,
      via: r.kind === "agent" && r.owner_id && r.owner_name ? { id: r.owner_id, display_name: r.owner_name } : null,
    });
  }
  for (const id of unique) {
    if (!out.has(id)) out.set(id, { id, kind: "human", display_name: "Former member", via: null });
  }
  return out;
}

export function refOf(ctx: AppContext, id: string): PrincipalRef {
  return principalRefs(ctx, [id]).get(id)!;
}

export function presentBoard(ctx: AppContext, b: BoardRow, m: MembershipRow): Board {
  const limits = boardLimits(ctx, b.id);
  return {
    id: b.id,
    name: b.name,
    url: boardUrl(ctx.config.publicUrl, b.id),
    owner: refOf(ctx, b.owner_id),
    is_personal: b.is_personal === 1,
    my_role: m.role,
    my_access_ends_at: m.access_ends_at,
    created_at: b.created_at,
    settings: {
      members_can_add_agents: b.members_can_add_agents === 1,
      agent_posts_per_day: b.agent_posts_per_day ?? limits.agent_posts_per_day,
      agent_consecutive_limit: b.agent_consecutive_limit ?? limits.agent_consecutive_limit,
    },
  };
}

export function presentMember(ctx: AppContext, m: MembershipRow, refs?: Map<string, PrincipalRef>): Member {
  const r = refs?.get(m.principal_id) ?? refOf(ctx, m.principal_id);
  return { principal: r, role: m.role, joined_at: m.joined_at, access_ends_at: m.access_ends_at, handle: m.handle };
}

function parseLabels(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Presents threads for a viewer (following and unread counts are per viewer). */
export function presentThreads(ctx: AppContext, rows: ThreadRow[], viewerId: string | null): Thread[] {
  if (rows.length === 0) return [];
  const refs = principalRefs(ctx, rows.flatMap((t) => [t.created_by, t.task_assignee_id, t.task_for_id]));
  const ids = rows.map((t) => t.id);
  const ph = ids.map(() => "?").join(",");
  const tasks = taskDetails(ctx, rows, viewerId);
  const following = new Set<string>();
  const unread = new Map<string, number>();
  if (viewerId) {
    for (const r of ctx.db.prepare(`SELECT thread_id FROM follows WHERE principal_id = ? AND thread_id IN (${ph})`).all(viewerId, ...ids) as { thread_id: string }[]) {
      following.add(r.thread_id);
    }
    const counts = ctx.db
      .prepare(
        `SELECT m.thread_id, COUNT(*) AS n FROM messages m
         LEFT JOIN read_markers rm ON rm.thread_id = m.thread_id AND rm.principal_id = ?
         WHERE m.thread_id IN (${ph}) AND m.author_id != ? AND m.deleted_at IS NULL
           AND (rm.last_read_at IS NULL OR m.created_at > rm.last_read_at)
         GROUP BY m.thread_id`,
      )
      .all(viewerId, ...ids, viewerId) as { thread_id: string; n: number }[];
    for (const c of counts) unread.set(c.thread_id, c.n);
  }
  const links = new Map<string, ExternalLink[]>();
  for (const l of ctx.db
    .prepare(
      `SELECT l.id, l.thread_id, l.external_ref, l.url, i.platform FROM thread_links l JOIN integrations i ON i.id = l.integration_id WHERE l.thread_id IN (${ph})`,
    )
    .all(...ids) as { id: string; thread_id: string; external_ref: string; url: string | null; platform: SyncPlatform }[]) {
    const list = links.get(l.thread_id) ?? [];
    list.push({ id: l.id, platform: l.platform, external_ref: l.external_ref, url: l.url });
    links.set(l.thread_id, list);
  }
  return rows.map((t) => ({
    id: t.id,
    board_id: t.board_id,
    channel: t.channel,
    url: threadUrl(ctx.config.publicUrl, t.board_id, t.id),
    title: t.title,
    kind: t.kind,
    labels: parseLabels(t.labels),
    task:
      t.kind === "task" && t.task_state
        ? {
            state: t.task_state,
            owner: refs.get(t.created_by)!,
            for: t.task_for_id ? (refs.get(t.task_for_id) ?? null) : null,
            assignee: t.task_assignee_id ? (refs.get(t.task_assignee_id) ?? null) : null,
            claimed_at: t.task_claimed_at,
            lease_until: t.task_state === "claimed" ? t.task_lease_until : null,
            completed_at: t.task_completed_at,
            needs: tasks.needs.get(t.id) ?? [],
            result: t.task_result_message_id ? (tasks.results.get(t.task_result_message_id) ?? null) : null,
            failure_reason: t.task_state === "failed" ? t.task_reason : null,
            blocked_reason: t.task_state === "blocked" ? t.task_reason : null,
            blocked_kind: t.task_state === "blocked" ? t.task_blocked_kind : null,
            canceled_reason: t.task_state === "canceled" ? t.task_reason : null,
          }
        : null,
    created_by: refs.get(t.created_by)!,
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
    message_count: t.message_count,
    following: following.has(t.id),
    unread_count: unread.get(t.id) ?? 0,
    links: links.get(t.id) ?? [],
  }));
}

/**
 * Prerequisites and result bodies for the task rows among `rows`, in two queries. A prerequisite in another channel
 * that the viewer can't read keeps its ID and state but not its title.
 */
function taskDetails(ctx: AppContext, rows: ThreadRow[], viewerId: string | null): { needs: Map<string, TaskNeed[]>; results: Map<string, string> } {
  const needs = new Map<string, TaskNeed[]>();
  const results = new Map<string, string>();
  const taskIds = rows.filter((t) => t.kind === "task").map((t) => t.id);
  if (taskIds.length) {
    const channelOf = new Map(rows.map((t) => [t.id, t.channel]));
    const viewer = viewerId ? (ctx.db.prepare("SELECT * FROM principals WHERE id = ?").get(viewerId) as PrincipalRow | undefined) : undefined;
    const access = new Map<string, ChannelAccess>();
    const readable = (boardId: string, channel: string): boolean => {
      if (!viewer) return false;
      let a = access.get(boardId);
      if (!a) access.set(boardId, (a = ChannelAccess.load(ctx, boardId, { id: viewer.id, kind: viewer.kind, ownerId: viewer.owner_id, profile: viewer.profile_name ?? null })));
      return a.can(channel, "read");
    };
    for (const r of ctx.db
      .prepare(
        `SELECT n.task_id, p.id, p.board_id, p.channel, p.title, p.task_state FROM task_needs n JOIN threads p ON p.id = n.needs_id
         WHERE n.task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY p.created_at, p.id`,
      )
      .all(...taskIds) as { task_id: string; id: string; board_id: string; channel: string; title: string; task_state: TaskState }[]) {
      const list = needs.get(r.task_id) ?? [];
      const shown = r.channel === channelOf.get(r.task_id) || readable(r.board_id, r.channel);
      list.push({ thread_id: r.id, title: shown ? r.title : "", state: r.task_state });
      needs.set(r.task_id, list);
    }
  }
  const resultIds = rows.map((t) => t.task_result_message_id).filter((x): x is string => !!x);
  if (resultIds.length) {
    for (const m of ctx.db
      .prepare(`SELECT id, body FROM messages WHERE id IN (${resultIds.map(() => "?").join(",")}) AND deleted_at IS NULL`)
      .all(...resultIds) as { id: string; body: string | null }[]) {
      if (m.body !== null) results.set(m.id, m.body);
    }
  }
  return { needs, results };
}

export function presentThread(ctx: AppContext, row: ThreadRow, viewerId: string | null): Thread {
  return presentThreads(ctx, [row], viewerId)[0]!;
}

/** `viewerId` sets each reaction's `me`; without one, `me` is false. */
export function presentMessages(ctx: AppContext, rows: MessageRow[], viewerId: string | null = null): Message[] {
  if (rows.length === 0) return [];
  const extras = messageExtras(ctx, rows, viewerId);
  const ids = rows.map((m) => m.id);
  const ph = ids.map(() => "?").join(",");
  const mentionRows = ctx.db.prepare(`SELECT message_id, principal_id FROM mentions WHERE message_id IN (${ph})`).all(...ids) as {
    message_id: string;
    principal_id: string;
  }[];
  const refs = principalRefs(ctx, [...rows.map((m) => m.author_id), ...mentionRows.map((r) => r.principal_id)]);
  const mentionMap = new Map<string, PrincipalRef[]>();
  for (const r of mentionRows) {
    const list = mentionMap.get(r.message_id) ?? [];
    list.push(refs.get(r.principal_id)!);
    mentionMap.set(r.message_id, list);
  }
  return rows.map((m) => ({
    id: m.id,
    board_id: m.board_id,
    thread_id: m.thread_id,
    author: refs.get(m.author_id)!,
    body: m.deleted_at ? null : m.body,
    deleted: m.deleted_at !== null,
    reply_to: m.reply_to,
    mentions: m.deleted_at ? [] : (mentionMap.get(m.id) ?? []),
    source:
      m.source_platform && m.source_external_id
        ? {
            platform: m.source_platform as SyncPlatform,
            author_name: m.source_author_name ?? "unknown",
            url: m.source_url,
            external_id: m.source_external_id,
          }
        : null,
    created_at: m.created_at,
    ...extras.get(m.id)!,
  }));
}

export function presentMessage(ctx: AppContext, row: MessageRow, viewerId: string | null = null): Message {
  return presentMessages(ctx, [row], viewerId)[0]!;
}

export function presentInbox(ctx: AppContext, rows: InboxRow[], viewerId: string | null = null): InboxItem[] {
  if (rows.length === 0) return [];
  const threadIds = [...new Set(rows.map((r) => r.thread_id))];
  const titles = new Map(
    (ctx.db.prepare(`SELECT id, title FROM threads WHERE id IN (${threadIds.map(() => "?").join(",")})`).all(...threadIds) as { id: string; title: string }[]).map(
      (t) => [t.id, t.title],
    ),
  );
  const msgIds = rows.map((r) => r.message_id).filter((x): x is string => !!x);
  const msgs = new Map<string, Message>();
  if (msgIds.length) {
    const mrows = ctx.db.prepare(`SELECT * FROM messages WHERE id IN (${msgIds.map(() => "?").join(",")})`).all(...msgIds) as MessageRow[];
    for (const m of presentMessages(ctx, mrows, viewerId ?? rows[0]?.principal_id ?? null)) msgs.set(m.id, m);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    board_id: r.board_id,
    thread_id: r.thread_id,
    thread_title: titles.get(r.thread_id) ?? "",
    message: r.message_id ? (msgs.get(r.message_id) ?? null) : null,
    created_at: r.created_at,
    read_at: r.read_at,
  }));
}

export function presentInvite(ctx: AppContext, row: InviteRow, url: string | null): Invite {
  return {
    id: row.id,
    board_id: row.board_id,
    url,
    audience: row.audience,
    audience_value: row.audience_value,
    role: row.role,
    join_by: row.join_by,
    access_ends_at: row.access_ends_at,
    max_uses: row.max_uses,
    uses: row.uses,
    disabled_at: row.disabled_at,
    created_at: row.created_at,
    created_by: refOf(ctx, row.created_by),
  };
}
