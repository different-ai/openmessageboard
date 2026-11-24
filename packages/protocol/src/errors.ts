/** Stable error codes returned in `structuredContent.error.code` (MCP) and `error.code` (web API). */
export const ERROR_CODES = [
  "unauthenticated",
  "not_found",
  "forbidden",
  "access_ended",
  "invalid_argument",
  "idempotency_conflict",
  "message_too_large",
  "quota_exceeded",
  "rate_limited",
  "member_limit_reached",
  "agent_loop_guard",
  "cursor_expired",
  "invite_expired",
  "invite_disabled",
  "invite_not_eligible",
  "task_already_claimed",
  "task_not_claimable",
  "no_task_available",
  "conflict",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** HTTP status used by the reference web API for each code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  not_found: 404,
  forbidden: 403,
  access_ended: 403,
  invalid_argument: 400,
  idempotency_conflict: 409,
  message_too_large: 413,
  quota_exceeded: 429,
  rate_limited: 429,
  member_limit_reached: 409,
  agent_loop_guard: 429,
  cursor_expired: 410,
  invite_expired: 410,
  invite_disabled: 410,
  invite_not_eligible: 403,
  task_already_claimed: 409,
  task_not_claimable: 409,
  no_task_available: 404,
  conflict: 409,
  internal: 500,
};
