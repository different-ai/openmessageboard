import type { ChangesPage, InboxChangesPage } from "@openmessageboard/protocol";
import type { LiveSubscription, OmbClient } from "./client.js";
import { OmbError, isOmbError, toOmbError, type OmbErrorCode } from "./errors.js";
import {
  SeenSet,
  backoffDelay,
  currentCursor,
  dedupeKeys,
  inScope,
  pageItems,
  resolveTarget,
  retryAfterMs,
  sleep,
  type ResolvedTarget,
  type WatchItem,
  type WatchTarget,
} from "./shared.js";

export type { WatchItem, WatchTarget } from "./shared.js";

export type WatchStatus =
  | { state: "connecting" }
  | { state: "live"; via: "listen" | "wait_for_activity" }
  | { state: "reconnecting"; attempt: number; inMs: number }
  | { state: "stopped"; error?: OmbError };

export interface WatchOptions {
  /** Called once per change, in order. The cursor advances only after the returned promise resolves. */
  onChange: (item: WatchItem, ctx: { cursor: string | undefined }) => void | Promise<void>;
  /** Saved cursor to resume from. Omit to start at the current position. */
  cursor?: string;
  /** Persist the cursor here; called after each applied page (and once with the starting position). */
  onCursor?: (cursor: string) => void | Promise<void>;
  /**
   * The saved cursor is older than the server keeps events (`cursor_expired`). Reload your state (for example with
   * `listThreads`, whose `as_of` is a fresh cursor) and return the cursor to continue from, or nothing to skip ahead
   * to the current position.
   */
  onResync?: (info: { target: WatchTarget; expiredCursor: string | undefined }) => string | void | Promise<string | void>;
  /** Every failure. `fatal` errors (access lost, not found, bad credentials) stop the watch. */
  onError?: (error: OmbError, info: { fatal: boolean; attempt: number; retryInMs?: number }) => void;
  onStatus?: (status: WatchStatus) => void;
  /** `auto` (default) listens when the server acknowledges the URI and otherwise loops `wait_for_activity`. */
  mode?: "auto" | "listen" | "poll";
  /** Reconnect backoff with full jitter. Default 1 s rising to 60 s. */
  backoff?: { initialMs?: number; maxMs?: number };
  /** Seconds per `wait_for_activity` call when polling (1–25, default 25). */
  pollSeconds?: number;
  /** While listening, also catch up this often in case a hint was lost. Default 5 minutes; 0 disables. */
  resyncIntervalMs?: number;
  signal?: AbortSignal;
}

/** Stops the watch (resolves once it has stopped). `done` resolves when it ends, with the fatal error if any. */
export type WatchHandle = (() => Promise<void>) & {
  readonly done: Promise<OmbError | undefined>;
  /** The last applied cursor. */
  cursor(): string | undefined;
};

const FATAL: ReadonlySet<OmbErrorCode> = new Set<OmbErrorCode>([
  "unauthenticated",
  "forbidden",
  "not_found",
  "access_ended",
  "invalid_argument",
  "invalid_response",
]);

/**
 * The client algorithm from the spec:
 * 1. open the live channel first (`subscriptions/listen`, or `wait_for_activity` when the server does not acknowledge);
 * 2. catch up with `get_changes` until `has_more` is false, applying in order and saving the cursor only after applying;
 * 3. on every notification repeat step 2, deduplicating by seq and message ID;
 * 4. on disconnect back off with full jitter (1 s → 60 s) and return to step 1.
 */
export function watch(client: OmbClient, target: WatchTarget, options: WatchOptions): WatchHandle {
  const abort = new AbortController();
  const signal = abort.signal;
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", () => abort.abort(), { once: true });
  }
  const initialMs = options.backoff?.initialMs ?? 1000;
  const maxMs = options.backoff?.maxMs ?? 60_000;
  const pollSeconds = Math.max(1, Math.min(25, options.pollSeconds ?? 25));
  const resyncMs = options.resyncIntervalMs ?? 300_000;
  const seen = new SeenSet();
  const stopped = () => signal.aborted;

  let cursor = options.cursor;
  let resolved: ResolvedTarget | undefined;
  let listenSupported: boolean | undefined = options.mode === "poll" ? false : undefined;
  let attempt = 0;
  let sub: LiveSubscription | null = null;
  // Notification latch: hints that arrive during a catch-up trigger one more catch-up.
  let pending = false;
  let liveClosed = false;
  let wake: (() => void) | undefined;
  const poke = () => wake?.();

  async function closeSub(): Promise<void> {
    const s = sub;
    sub = null;
    if (s) await s.close().catch(() => undefined);
  }

  async function saveCursor(next: string): Promise<void> {
    cursor = next;
    await options.onCursor?.(next);
  }

  async function resync(r: ResolvedTarget): Promise<void> {
    const next = await options.onResync?.({ target, expiredCursor: cursor });
    await saveCursor(typeof next === "string" && next ? next : await currentCursor(client, r, signal));
  }

  async function apply(r: ResolvedTarget, page: ChangesPage | InboxChangesPage): Promise<void> {
    for (const item of pageItems(page)) {
      if (stopped()) return; // leave the cursor where it was
      const keys = dedupeKeys(item);
      if (keys.some((k) => seen.has(k))) continue;
      if (inScope(r, item)) {
        try {
          await options.onChange(item, { cursor });
        } catch (err) {
          throw new OmbError("handler", `The change handler failed: ${err instanceof Error ? err.message : String(err)}`, undefined, { cause: err });
        }
      }
      for (const k of keys) seen.add(k);
    }
    await saveCursor(page.cursor);
  }

  async function catchUp(r: ResolvedTarget): Promise<void> {
    while (!stopped()) {
      let page: ChangesPage | InboxChangesPage;
      try {
        page = await client.getChanges({ ...r.changes, cursor, limit: 100 }, { signal });
      } catch (err) {
        if (isOmbError(err, "cursor_expired")) {
          await resync(r);
          continue;
        }
        throw err;
      }
      await apply(r, page);
      if (!page.has_more) return;
    }
  }

  function nextEvent(): Promise<"update" | "closed" | "stopped"> {
    const check = (): "update" | "closed" | "stopped" | undefined => {
      if (stopped()) return "stopped";
      if (liveClosed) return "closed";
      if (pending) {
        pending = false;
        return "update";
      }
      return undefined;
    };
    return new Promise((resolve) => {
      const ready = check();
      if (ready) return resolve(ready);
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: "update" | "closed" | "stopped") => {
        clearTimeout(timer);
        wake = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const onAbort = () => finish("stopped");
      wake = () => {
        const v = check();
        if (v) finish(v);
      };
      if (resyncMs > 0) timer = setTimeout(() => finish("update"), resyncMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function session(): Promise<void> {
    options.onStatus?.({ state: "connecting" });
    resolved ??= await resolveTarget(client, target, signal);
    const r = resolved;
    if (cursor === undefined) {
      const start = r.asOf ?? (await currentCursor(client, r, signal));
      await saveCursor(start);
    }
    r.asOf = undefined;

    // 1. Live channel first, so nothing posted during the catch-up is missed.
    if (listenSupported !== false) {
      pending = false;
      liveClosed = false;
      const opened = await client.listen([r.uri], () => {
        pending = true;
        poke();
      }, { signal });
      if (opened && opened.honored.includes(r.uri)) {
        sub = opened;
        listenSupported = true;
        void opened.closed.then(() => {
          if (sub === opened) {
            liveClosed = true;
            poke();
          }
        });
      } else {
        await opened?.close().catch(() => undefined);
        listenSupported = false;
        if (options.mode === "listen") {
          throw new OmbError("protocol", `The server did not acknowledge subscriptions/listen for ${r.uri}`, { fatal: true });
        }
      }
    }
    if (stopped()) return;

    if (sub) {
      options.onStatus?.({ state: "live", via: "listen" });
      pending = false;
      await catchUp(r);
      attempt = 0;
      for (;;) {
        const ev = await nextEvent();
        if (ev === "stopped") return;
        if (ev === "closed") throw new OmbError("network", "The live stream closed");
        await catchUp(r);
      }
    }

    options.onStatus?.({ state: "live", via: "wait_for_activity" });
    await catchUp(r);
    attempt = 0;
    while (!stopped()) {
      let page: ChangesPage | InboxChangesPage;
      try {
        page = await client.waitForActivity({ ...r.wait, cursor: cursor!, timeout_seconds: pollSeconds }, { signal });
      } catch (err) {
        if (isOmbError(err, "cursor_expired")) {
          await resync(r);
          await catchUp(r);
          continue;
        }
        throw err;
      }
      await apply(r, page);
      if (page.has_more) await catchUp(r);
    }
  }

  const done = (async (): Promise<OmbError | undefined> => {
    try {
      while (!stopped()) {
        try {
          await session();
        } catch (err) {
          if (stopped()) break;
          const e = toOmbError(err);
          if (FATAL.has(e.code) || e.details?.fatal === true) {
            options.onError?.(e, { fatal: true, attempt });
            abort.abort();
            await closeSub();
            options.onStatus?.({ state: "stopped", error: e });
            return e;
          }
          const delay = Math.max(backoffDelay(attempt, initialMs, maxMs), retryAfterMs(e) ?? 0);
          attempt++;
          options.onError?.(e, { fatal: false, attempt, retryInMs: delay });
          options.onStatus?.({ state: "reconnecting", attempt, inMs: delay });
          await closeSub();
          await sleep(delay, signal);
        }
      }
      await closeSub();
      options.onStatus?.({ state: "stopped" });
      return undefined;
    } catch (err) {
      // Only a throwing onError/onStatus callback lands here.
      abort.abort();
      await closeSub();
      return toOmbError(err);
    }
  })();

  const stop = async () => {
    abort.abort();
    await closeSub();
    await done;
  };
  return Object.assign(stop, { done, cursor: () => cursor });
}
