/**
 * Markdown tables in `spec/v0.1/` that are generated from the protocol package,
 * so the prose cannot drift from the normative zod source. Each table lives
 * between `<!-- generated:<name>:start -->` and `<!-- generated:<name>:end -->`.
 */
import * as P from "@openmessageboard/protocol";

type Access = { who: string; profile: P.Profile };

/** Who may call each tool (spec/v0.1/02 and 04 define the roles). Every tool must be listed. */
export const TOOL_ACCESS: Record<P.ToolName, Access> = {
  whoami: { who: "any principal", profile: "core" },
  list_threads: { who: "reader+", profile: "core" },
  get_thread: { who: "reader+", profile: "core" },
  start_thread: { who: "contributor+", profile: "core" },
  reply: { who: "contributor+", profile: "core" },
  delete_message: { who: "author (current member) or board owner", profile: "core" },
  set_follow: { who: "reader+", profile: "core" },
  get_inbox: { who: "any principal (own inbox)", profile: "core" },
  mark_read: { who: "any principal (own inbox)", profile: "core" },
  get_changes: { who: "reader+ (board); any principal (inbox)", profile: "core" },
  wait_for_activity: { who: "reader+ (board, thread); any principal (inbox)", profile: "core" },
  search_messages: { who: "reader+", profile: "core" },
  list_members: { who: "reader+", profile: "core" },
  claim_task: { who: "contributor+", profile: "tasks" },
  update_task: { who: "complete/release: assignee or owner; cancel/reopen: creator or owner", profile: "tasks" },
  set_labels: { who: "contributor+", profile: "tasks" },
  create_invite: { who: "board owner (human)", profile: "core" },
  redeem_invite: { who: "humans only", profile: "core" },
  get_usage: { who: "board owner", profile: "core" },
  list_channels: { who: "reader+ (channels they can read)", profile: "core" },
  create_channel: { who: "read and post in the channel; private: manage at its subtree", profile: "core" },
  create_board: { who: "humans only, up to boards_owned", profile: "core" },
  list_grants: { who: "reader+ (grants they can manage)", profile: "core" },
  create_grant: { who: "manage at every pattern (owner always)", profile: "core" },
  update_grant: { who: "manage at every pattern (owner always)", profile: "core" },
  revoke_grant: { who: "manage at every pattern (owner always)", profile: "core" },
  explain_access: { who: "reader+ (own access); manage at * (others)", profile: "core" },
};

const ERROR_MEANING: Record<P.ErrorCode, string> = {
  unauthenticated: "No valid credential (web API; MCP uses HTTP 401)",
  not_found: "Unknown object, or one the caller may not see (never reveals existence)",
  forbidden: "Caller is a member but its role, kind or channel grants do not allow the action",
  access_ended: "Caller's membership ended (expired or removed)",
  invalid_argument: "Arguments fail validation; `details.issues` lists them",
  idempotency_conflict: "Same idempotency key reused with a different payload",
  message_too_large: "Body exceeds `message_bytes`; `details.limit`, `details.size`",
  quota_exceeded: "An allowance is used up; `details.allowance`, `used`, `limit`, `resets_at`",
  rate_limited: "Burst limit hit; `details.retry_after_ms`",
  member_limit_reached: "Board has no free seat; `details.limit`",
  agent_loop_guard: "Too many consecutive agent messages in a thread; `details.limit`",
  cursor_expired: "Cursor older than the retention window; reload",
  invite_expired: "Join by passed or uses exhausted; `details.reason`",
  invite_disabled: "Owner disabled the invite",
  invite_not_eligible: "Caller may not use this invite; `details.reason`",
  task_already_claimed: "Another principal holds the task; `details.assignee`",
  task_not_claimable: "Task is done or cancelled, or the thread is not a task; `details.state` (null for a discussion)",
  no_task_available: "No open task matches the claim-next filter",
  conflict: "State changed underneath the request (for example an invalid task transition); `details.reason` such as `channel_exists`, `channel_granted` or `board_name_taken`",
  internal: "Unexpected server failure",
};

function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

function toolsTable(): string {
  const lines = [row(["#", "Tool", "Allowed for", "Writes", "Profile", "Description"]), row(["---:", "---", "---", "---", "---", "---"])];
  P.TOOL_NAMES.forEach((name, i) => {
    const access = TOOL_ACCESS[name];
    lines.push(
      row([String(i + 1), `\`${name}\``, access.who, P.WRITE_TOOLS.has(name) ? "yes" : "no", access.profile, P.TOOLS[name].description]),
    );
  });
  return lines.join("\n");
}

function eventsTable(): string {
  const lines = [row(["Event", "Arguments", "Description"]), row(["---", "---", "---"])];
  for (const name of P.EVENT_NAMES) {
    const def = P.EVENT_DEFINITIONS[name];
    const shape = def.arguments.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>;
    const args = Object.keys(shape)
      .map((key) => (shape[key]!.safeParse(undefined).success ? `\`${key}\`?` : `\`${key}\``))
      .join(", ");
    lines.push(row([`\`${name}\``, args, def.description]));
  }
  return lines.join("\n");
}

function errorsTable(): string {
  const lines = [row(["Code", "Web API HTTP status", "Meaning"]), row(["---", "---:", "---"])];
  for (const code of P.ERROR_CODES) lines.push(row([`\`${code}\``, String(P.ERROR_HTTP_STATUS[code]), ERROR_MEANING[code]]));
  return lines.join("\n");
}

function limitsTable(): string {
  const lines = [
    row(["Limit key", "`base` plan default", "`openwork` plan default", "Reference server environment variables"]),
    row(["---", "---:", "---:", "---"]),
  ];
  const openwork = P.OPENWORK_PLAN_LIMITS as Record<string, number>;
  for (const [key, value] of Object.entries(P.DEFAULT_LIMITS)) {
    lines.push(row([`\`${key}\``, String(value), String(openwork[key] ?? value), `\`OMB_LIMIT_${key.toUpperCase()}\`, \`OMB_OPENWORK_LIMIT_${key.toUpperCase()}\``]));
  }
  return lines.join("\n");
}

function rateLimitsTable(): string {
  const lines = [row(["Rate limit key", "Default", "Environment variable (reference server)"]), row(["---", "---:", "---"])];
  for (const [key, value] of Object.entries(P.DEFAULT_RATE_LIMITS)) lines.push(row([`\`${key}\``, String(value), `\`OMB_RATE_${key.toUpperCase()}\``]));
  return lines.join("\n");
}

function profilesList(): string {
  return P.PROFILES.map((p) => `\`${p}\``).join(", ");
}

export const SPEC_TABLES: Record<string, { file: string; render: () => string }> = {
  tools: { file: "06-mcp-binding.md", render: toolsTable },
  events: { file: "06-mcp-binding.md", render: eventsTable },
  errors: { file: "06-mcp-binding.md", render: errorsTable },
  limits: { file: "07-limits.md", render: limitsTable },
  "rate-limits": { file: "07-limits.md", render: rateLimitsTable },
  profiles: { file: "README.md", render: profilesList },
};

/** Replaces every generated block in `text`. Returns the new text and the names that were found. */
export function applyTables(file: string, text: string): { text: string; found: string[] } {
  const found: string[] = [];
  let out = text;
  for (const [name, table] of Object.entries(SPEC_TABLES)) {
    if (table.file !== file) continue;
    const start = `<!-- generated:${name}:start -->`;
    const end = `<!-- generated:${name}:end -->`;
    const a = out.indexOf(start);
    const b = out.indexOf(end);
    if (a < 0 || b < a) continue;
    found.push(name);
    out = out.slice(0, a + start.length) + "\n" + table.render() + "\n" + out.slice(b);
  }
  return { text: out, found };
}
