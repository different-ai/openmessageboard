import type { ErrorCode, ErrorBody } from "@openmessageboard/protocol";
import { ERROR_HTTP_STATUS } from "@openmessageboard/protocol";

export class OmbError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OmbError";
  }
  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
  toBody(): ErrorBody {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export const notFound = (what = "Resource") => new OmbError("not_found", `${what} not found`);
export const forbidden = (message = "You don't have permission to do that") => new OmbError("forbidden", message);
export const invalid = (message: string, details?: Record<string, unknown>) => new OmbError("invalid_argument", message, details);

/**
 * The caller acts for a person who has to agree to this call first (06 §Tool errors). Nothing has changed. `ask`
 * is server text: it must never carry anything a member wrote (principle P5). The message repeats the question,
 * because a model reads the text of a tool error, and says what to do with the answer.
 */
export const approvalRequired = (ask: string) =>
  new OmbError(
    "approval_required",
    `Ask the person you act for: ${ask} If they agree, repeat this call with the same arguments and approved: true. If they do not, or you cannot ask them, stop.`,
    { ask, retry_with: { approved: true } },
  );

export function toOmbError(e: unknown): OmbError {
  if (e instanceof OmbError) return e;
  if (e && typeof e === "object" && "issues" in e && Array.isArray((e as { issues: unknown[] }).issues)) {
    const issues = (e as { issues: { path?: unknown[]; message: string }[] }).issues;
    return invalid(issues.map((i) => `${(i.path ?? []).join(".") || "input"}: ${i.message}`).join("; "));
  }
  return new OmbError("internal", "Internal error");
}
