import type { OmbClient } from "./client.js";
import { OmbError, toOmbError } from "./errors.js";
import {
  abortedError,
  backoffDelay,
  currentCursor,
  inScope,
  pageItems,
  resolveTarget,
  retryAfterMs,
  sleep,
  type ChangeFilters,
  type WatchItem,
  type WatchTarget,
} from "./shared.js";

export interface WaitForChangesOptions {
  /** Give up after this many milliseconds and resolve `null`. Omit to wait forever. */
  timeoutMs?: number;
  /** Start after this cursor instead of now. */
  cursor?: string;
  /**
   * Start after this message ID, thread ID or cursor. A message that already follows it returns at once, so
   * `{ after: myPost.id }` never misses a fast answer.
   */
  after?: string;
  /** Server-side message filters (board and thread targets): `by`, `mentions`, `labels`, `text`, `source`, `re`. */
  filters?: ChangeFilters;
  /** Only resolve for items that pass (others are skipped and waiting continues). */
  filter?: (item: WatchItem) => boolean;
  signal?: AbortSignal;
}

export interface WaitResult {
  changes: WatchItem[];
  /** Position after the returned changes; pass it back to continue. */
  cursor: string;
}

/**
 * Loops `wait_for_activity` (25 s at a time) until matching changes arrive or the timeout passes.
 * Lost connections are retried with backoff; an expired cursor restarts from the current position.
 */
export async function waitForChanges(client: OmbClient, target: WatchTarget, options: WaitForChangesOptions = {}): Promise<WaitResult | null> {
  const { signal } = options;
  const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  const resolved = await resolveTarget(client, target, signal);
  if (options.after && options.cursor) throw new OmbError("invalid_argument", "Pass cursor or after, not both");
  let after = options.after;
  let cursor = options.cursor ?? (after ? "" : (resolved.asOf ?? (await currentCursor(client, resolved, signal))));
  const filters = "inbox" in resolved.wait ? {} : (options.filters ?? {});
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw abortedError();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const timeout_seconds = Math.max(1, Math.min(25, Math.ceil(remaining / 1000)));
    try {
      const page = await client.waitForActivity({ ...resolved.wait, ...filters, ...(after ? { after } : { cursor }), timeout_seconds }, { signal });
      attempt = 0;
      after = undefined;
      cursor = page.cursor;
      const matches = pageItems(page).filter((item) => inScope(resolved, item) && (options.filter?.(item) ?? true));
      if (matches.length > 0) return { changes: matches, cursor };
    } catch (err) {
      if (signal?.aborted) throw abortedError();
      const e = toOmbError(err);
      if (e.code === "cursor_expired") {
        after = undefined;
        cursor = await currentCursor(client, resolved, signal);
        continue;
      }
      if (!e.retryable) throw e;
      const delay = Math.max(backoffDelay(attempt++), retryAfterMs(e) ?? 0);
      if (Date.now() + delay >= deadline) return null;
      await sleep(delay, signal);
    }
  }
}
