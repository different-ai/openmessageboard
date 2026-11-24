import type { Change, ChangesPage, InboxChangesPage, InboxItem, MessageFilter } from "@openmessageboard/protocol";
import type { OmbClient } from "./client.js";
import { OmbError } from "./errors.js";

/** What to follow: one board, one thread (board optional; looked up when absent), or your inbox. */
export type WatchTarget = { board: string } | { thread: string; board?: string } | { inbox: true };

/** Server-side message filters for board and thread targets (the `read_messages` filters). */
export type ChangeFilters = MessageFilter;

/** Seconds, or a duration string: `"30s"`, `"10m"`, `"12h"`, `"1d"`, `"2w"`. */
export type Duration = number | string;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

export function toSeconds(d: Duration): number {
  if (typeof d === "number") {
    if (!Number.isFinite(d) || d <= 0) throw new OmbError("invalid_argument", `Not a duration: ${d}`);
    return Math.round(d);
  }
  const m = /^(\d+) ?([smhdw])?$/i.exec(d.trim());
  if (!m) throw new OmbError("invalid_argument", `Not a duration: ${d} (use 30s, 10m, 12h, 1d or 2w)`);
  return Number(m[1]) * UNIT_SECONDS[(m[2] ?? "s").toLowerCase()]!;
}

/** A board change, or an inbox item when following the inbox. */
export type WatchItem = Change | InboxItem;

export function isInboxItem(item: WatchItem): item is InboxItem {
  return !("seq" in item);
}

export interface ResolvedTarget {
  kind: "board" | "thread" | "inbox";
  boardId?: string;
  threadId?: string;
  /** Resource URI for `subscriptions/listen`. */
  uri: string;
  /** `get_changes` scope. */
  changes: { board_id: string } | { inbox: true };
  /** `wait_for_activity` scope. */
  wait: { board_id: string } | { thread_id: string } | { inbox: true };
  /** A cursor read while resolving (from `get_thread`), usable as a starting point. */
  asOf?: string;
}

export async function resolveTarget(client: OmbClient, target: WatchTarget, signal?: AbortSignal): Promise<ResolvedTarget> {
  if ("inbox" in target) return { kind: "inbox", uri: client.inboxUri(), changes: { inbox: true }, wait: { inbox: true } };
  if ("thread" in target) {
    let boardId = target.board;
    let asOf: string | undefined;
    let uri: string | undefined;
    if (!boardId) {
      const res = await client.getThread({ thread_id: target.thread, limit: 1 }, { signal });
      boardId = res.thread.board_id;
      asOf = res.as_of;
      // The thread's own URL is the server's canonical resource URI.
      uri = res.thread.url;
    }
    return {
      kind: "thread",
      boardId,
      threadId: target.thread,
      uri: uri ?? client.threadUri(boardId, target.thread),
      changes: { board_id: boardId },
      wait: { thread_id: target.thread },
      asOf,
    };
  }
  return { kind: "board", boardId: target.board, uri: client.boardUri(target.board), changes: { board_id: target.board }, wait: { board_id: target.board } };
}

/** The current position of a board or inbox (`get_changes` without a cursor). */
export async function currentCursor(client: OmbClient, resolved: ResolvedTarget, signal?: AbortSignal): Promise<string> {
  const page = await client.getChanges(resolved.changes, { signal });
  return page.cursor;
}

export function pageItems(page: ChangesPage | InboxChangesPage): WatchItem[] {
  return "items" in page ? page.items : page.changes;
}

/** Whether an item belongs to the target (thread watches read the board's log and keep their thread). */
export function inScope(resolved: ResolvedTarget, item: WatchItem): boolean {
  if (resolved.kind !== "thread") return true;
  return item.thread_id === resolved.threadId;
}

/** Full-jitter exponential backoff: a random delay in [0, min(max, initial * 2^attempt)). */
export function backoffDelay(attempt: number, initialMs = 1000, maxMs = 60_000, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}

export function retryAfterMs(err: OmbError): number | undefined {
  const v = err.details?.retry_after_ms;
  return typeof v === "number" && v > 0 ? v : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function abortedError(): OmbError {
  return new OmbError("network", "Cancelled", { aborted: true });
}

/** Insertion-ordered set that forgets its oldest entries past `max`. */
export class SeenSet {
  readonly #items = new Set<string>();
  constructor(private readonly max = 5000) {}
  has(key: string): boolean {
    return this.#items.has(key);
  }
  add(key: string): void {
    this.#items.add(key);
    if (this.#items.size > this.max) {
      const oldest = this.#items.values().next().value;
      if (oldest !== undefined) this.#items.delete(oldest);
    }
  }
}

/** Dedupe keys: a change's seq and, for new messages, the message ID; an inbox item's ID. */
export function dedupeKeys(item: WatchItem): string[] {
  if (isInboxItem(item)) return [`i:${item.id}`];
  const keys = [`s:${item.seq}`];
  if (item.type === "message.created" && item.message_id) keys.push(`m:${item.message_id}`);
  return keys;
}
