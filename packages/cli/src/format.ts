import type { AccessExplanation, BoardActor, Change, Channel, Grant, InboxItem, Member, Membership, Message, PrincipalRef, Schedule, Thread, Usage, Watcher, WatcherFilter } from "@openmessageboard/sdk";

/** "release-agent (via Maya)" for agents, the display name otherwise. */
export function authorName(p: PrincipalRef): string {
  return p.via ? `${p.display_name} (via ${p.via.display_name})` : p.display_name;
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  if (ms < 0) return iso.slice(0, 16).replace("T", " ");
  const s = Math.floor(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return iso.slice(0, 10);
}

function indent(text: string, prefix = "  "): string {
  return text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

/** `name (via person) · time · id`, then the body indented. */
export function formatMessage(m: Message, now?: Date): string {
  const parts = [authorName(m.author), relativeTime(m.created_at, now)];
  if (m.source) parts.push(`from ${m.source.platform} (${m.source.author_name})`);
  parts.push(m.id);
  const body = m.deleted || m.body === null ? "[deleted]" : m.body;
  return `${parts.join(" · ")}\n${indent(body)}`;
}

export function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function taskSummary(t: Thread): string | undefined {
  if (!t.task) return undefined;
  return t.task.assignee ? `${t.task.state} by ${authorName(t.task.assignee)}` : t.task.state;
}

export function formatThreadHeader(t: Thread): string {
  const meta = [t.id, t.channel];
  const task = taskSummary(t);
  if (task) meta.push(`task: ${task}`);
  if (Object.keys(t.labels).length) meta.push(formatLabels(t.labels));
  meta.push(t.url);
  return `# ${t.title}\n${meta.join(" · ")}`;
}

export function formatThreadRow(t: Thread, now?: Date): string {
  const badge = t.task ? `[${t.task.state}] ` : "";
  const meta = [`${t.message_count} message${t.message_count === 1 ? "" : "s"}`];
  if (t.unread_count > 0) meta.push(`${t.unread_count} unread`);
  if (Object.keys(t.labels).length) meta.push(formatLabels(t.labels));
  meta.push(relativeTime(t.last_activity_at, now));
  return `${t.id}  ${badge}${t.title}\n  ${[t.channel, ...meta].join(" · ")}`;
}

/** Left-aligned columns separated by two spaces; the last column is not padded. */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatTasks(threads: Thread[]): string {
  if (threads.length === 0) return "No tasks.";
  return formatTable(
    ["ID", "STATE", "ASSIGNEE", "LABELS", "TITLE"],
    threads.map((t) => [t.id, t.task?.state ?? "-", t.task?.assignee ? authorName(t.task.assignee) : "-", formatLabels(t.labels) || "-", truncate(t.title, 72)]),
  );
}

export function formatBoards(memberships: Membership[]): string {
  if (memberships.length === 0) return "No boards.";
  return formatTable(
    ["ID", "ROLE", "NAME", "ACCESS ENDS", "URL"],
    memberships.map((m) => [m.board_id, m.is_owner ? "owner" : m.role, m.board_name, m.access_ends_at ?? "-", m.board_url]),
  );
}

export function formatMembers(members: Member[]): string {
  if (members.length === 0) return "No members.";
  return formatTable(
    ["ID", "HANDLE", "NAME", "KIND", "ROLE", "ACCESS ENDS"],
    members.map((m) => [m.principal.id, `@${m.handle}`, authorName(m.principal), m.principal.kind, m.role, m.access_ends_at ?? "-"]),
  );
}

export function formatActors(actors: BoardActor[]): string {
  if (actors.length === 0) return "No one yet.";
  return formatTable(
    ["ID", "HANDLE", "NAME", "KIND", "MEMBER"],
    actors.map((a) => [a.id, `@${a.handle}`, a.via ? `${a.display_name} (via ${a.via.display_name})` : a.display_name, a.kind, a.is_member ? "yes" : "no"]),
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatUsage(usage: Usage): string {
  const fmt = (n: number, unit: "count" | "bytes") => (unit === "bytes" ? formatBytes(n) : String(n));
  const table = formatTable(
    ["ALLOWANCE", "USED", "LIMIT", "RESETS", ""],
    usage.allowances.map((a) => [a.allowance, fmt(a.used, a.unit), fmt(a.limit, a.unit), a.resets_at ?? "-", a.warning ? "! 80%+" : ""]),
  );
  return `${table}\n${usage.storage_formula}`;
}

export function formatInboxItem(item: InboxItem, now?: Date): string {
  const head = `${item.read_at ? " " : "*"} ${item.kind} · ${item.thread_title} (${item.thread_id})`;
  return item.message ? `${head}\n${indent(formatMessage(item.message, now))}` : head;
}

/** One line (plus body for messages) per change, for `omb tail` and `omb wait`. */
export function formatChange(c: Change, now?: Date): string {
  const by = c.actor ? ` by ${authorName(c.actor)}` : "";
  switch (c.type) {
    case "thread.created":
      return `+ ${c.thread?.kind === "task" ? "task" : "thread"} ${c.thread_id} "${c.thread?.title ?? ""}"${by}`;
    case "message.created":
      return c.message ? `${c.thread_id} ${formatMessage(c.message, now)}` : `+ message ${c.message_id} in ${c.thread_id}${by}`;
    case "message.deleted":
      return `- message ${c.message_id} in ${c.thread_id} deleted${by}`;
    case "thread.updated": {
      const t = c.thread;
      const assignee = t?.task?.assignee && t.task.assignee.id !== c.actor?.id ? ` (assignee ${authorName(t.task.assignee)})` : "";
      const labels = t && Object.keys(t.labels).length ? ` [${formatLabels(t.labels)}]` : "";
      return `~ ${c.thread_id}${t?.task ? ` task ${t.task.state}` : " updated"}${by}${assignee}${labels}`;
    }
    case "member.joined":
    case "member.updated":
    case "member.left": {
      const who = c.member ? `${authorName(c.member.principal)} (${c.member.role})` : (c.actor?.display_name ?? "someone");
      return `${c.type === "member.left" ? "-" : "+"} member ${who} ${c.type.split(".")[1]}`;
    }
    case "board.updated":
      return `~ board updated${by}`;
  }
}

/** "every 1h", "every 2d" and so on, for schedules. */
export function formatInterval(seconds: number): string {
  for (const [unit, n] of [["w", 604_800], ["d", 86_400], ["h", 3600], ["m", 60]] as const) if (seconds % n === 0) return `${seconds / n}${unit}`;
  return `${seconds}s`;
}

function repeatOf(s: Schedule): string {
  if (!s.every_seconds) return "once";
  const parts = [`every ${formatInterval(s.every_seconds)}`];
  if (s.times !== null) parts.push(`${s.times} times`);
  if (s.until) parts.push(`until ${s.until}`);
  return parts.join(", ");
}

export function formatSchedules(schedules: Schedule[]): string {
  if (schedules.length === 0) return "No scheduled posts.";
  return formatTable(
    ["ID", "STATE", "NEXT RUN", "REPEAT", "IN", "BY", "TEXT"],
    schedules.map((s) => [
      s.id,
      s.state === "stopped" && s.stopped_reason ? `stopped (${s.stopped_reason})` : s.state,
      s.next_run_at ?? "-",
      repeatOf(s),
      s.thread_id ?? `new thread in ${s.channel}: "${truncate(s.title ?? "", 30)}"`,
      authorName(s.created_by),
      truncate(s.body.replace(/\s+/g, " "), 48),
    ]),
  );
}

/** Channels grouped by path, with thread counts and what you can do in each. */
export function formatChannels(channels: Channel[], now?: Date): string {
  if (channels.length === 0) return "No channels yet. A first post creates one.";
  return formatTable(
    ["CHANNEL", "THREADS", "LAST ACTIVITY", "YOU CAN", ""],
    channels.map((c) => [c.path, String(c.thread_count), c.last_activity_at ? relativeTime(c.last_activity_at, now) : "-", c.my_permissions.join(",") || "-", c.private ? "private" : ""]),
  );
}

export function formatGrants(grants: Grant[], members: Member[] = []): string {
  if (grants.length === 0) return "No grants you can manage. With no grants, board roles decide everything.";
  const name = (id: string) => {
    const m = members.find((x) => x.principal.id === id);
    return m ? `@${m.handle}` : id;
  };
  return formatTable(
    ["ID", "WHO", "CAN"],
    grants.map((g) => [
      g.id,
      g.principals.map((p) => (p.kind === "member" ? name(p.principal_id) : p.kind)).join(", "),
      Object.entries(g.can)
        .map(([pattern, perms]) => `${pattern}=${perms.length ? perms.join(",") : "none"}`)
        .join(" "),
    ]),
  );
}

export function formatScheduled(s: Schedule): string {
  return `Scheduled ${s.id}: ${s.next_run_at ? `next run ${s.next_run_at}` : s.state}, ${repeatOf(s)}`;
}

export function formatWatcherFilter(f: WatcherFilter): string {
  const parts: string[] = [];
  if (f.channel) parts.push(`channel=${f.channel}`);
  if (f.thread) parts.push(`re=${f.thread}`);
  if (f.types) parts.push(`types=${f.types.join(",")}`);
  if (f.by) parts.push(`by=${f.by}`);
  if (f.mentions) parts.push(`mentions=${f.mentions}`);
  if (f.labels) parts.push(formatLabels(f.labels));
  if (f.text) parts.push(`text="${f.text}"`);
  if (f.source) parts.push(`source=${f.source}`);
  return parts.join(" ") || "every change";
}

export function formatWatchers(watchers: Watcher[]): string {
  if (watchers.length === 0) return "No watchers.";
  return formatTable(
    ["ID", "STATUS", "URL", "FILTER", "LAST DELIVERY"],
    watchers.map((w) => {
      const d = w.recent_deliveries[0];
      return [
        w.id,
        w.status === "stopped" && w.stopped_reason ? `stopped (${w.stopped_reason})` : w.status,
        w.url,
        formatWatcherFilter(w.filter),
        d ? `${d.status}${d.last_error ? ` (${d.last_error})` : ""} ${d.created_at}` : "-",
      ];
    }),
  );
}

export function formatAccess(a: AccessExplanation): string {
  const lines = [`${authorName(a.principal)} (${a.role}) in ${a.channel}: ${a.can.length ? a.can.join(", ") : "nothing"}`];
  lines.push(a.pattern ? `Decided by ${a.grant_ids.join(", ")} at ${a.pattern} (${a.level?.replace("_", " ")}), which gives ${a.granted.join(", ") || "none"}` : `No grant applies; the ${a.role} role's defaults hold`);
  lines.push(`The ${a.role} role allows at most ${a.role_cap.join(", ")}`);
  if (a.person_cap) lines.push(`The person this agent acts for can ${a.person_cap.join(", ") || "do nothing"} here`);
  return lines.join("\n");
}
