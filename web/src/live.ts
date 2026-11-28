import type { Change, InboxItem } from "@openmessageboard/protocol";
import { api, isApiError, streamUrls } from "./api";

/** `polling`: no stream, the page asks for changes on a timer (someone reading a public board). */
export type LiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "polling";

/** How often a page without a stream asks for changes, while it is visible. */
export const POLL_SECONDS = 20;

type StreamHandlers = {
  events: Record<string, (data: unknown) => void>;
  onResync?: () => void;
  onEnded?: (reason: string) => void;
  onStatus?: (status: LiveStatus) => void;
};

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/**
 * One Server-Sent Events stream with cursor resume.
 * Applies each frame, then saves its id as the cursor. Reconnects with
 * full-jitter backoff (1 s rising to 60 s) using `?cursor=`.
 */
export class LiveStream {
  private es: EventSource | null = null;
  private cursor: string | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private pendingResync = false;
  status: LiveStatus = "idle";

  constructor(
    private readonly path: string,
    private readonly handlers: StreamHandlers,
  ) {}

  start(cursor?: string | null) {
    if (cursor) this.cursor = cursor;
    this.connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.es?.close();
    this.es = null;
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    this.handlers.onStatus?.(s);
  }

  private connect() {
    if (this.closed) return;
    const url = this.cursor ? `${this.path}?cursor=${encodeURIComponent(this.cursor)}` : this.path;
    const es = new EventSource(url, { withCredentials: true });
    this.es = es;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    es.addEventListener("ready", (e) => {
      const data = parse((e as MessageEvent).data) as { cursor?: string } | undefined;
      if (!this.cursor && data?.cursor) this.cursor = data.cursor;
      this.attempt = 0;
      this.setStatus("live");
      if (this.pendingResync) {
        this.pendingResync = false;
        this.handlers.onResync?.();
      }
    });

    for (const [name, apply] of Object.entries(this.handlers.events)) {
      es.addEventListener(name, (e) => {
        const ev = e as MessageEvent;
        const data = parse(ev.data);
        if (data !== undefined) apply(data);
        if (ev.lastEventId) this.cursor = ev.lastEventId;
      });
    }

    es.addEventListener("resync", () => {
      // Cursor expired: reconnect from now, then reload lists once the stream is open.
      this.cursor = null;
      this.pendingResync = true;
      es.close();
      this.schedule(0);
    });

    es.addEventListener("access_ended", (e) => {
      const data = parse((e as MessageEvent).data) as { reason?: string } | undefined;
      this.close();
      this.setStatus("ended");
      this.handlers.onEnded?.(data?.reason ?? "ended");
    });

    es.onerror = () => {
      if (this.closed) return;
      es.close();
      this.setStatus("reconnecting");
      const cap = Math.min(60_000, 1000 * 2 ** this.attempt);
      this.attempt++;
      this.schedule(Math.max(1000, Math.random() * cap));
    };
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), ms);
  }
}

type PollHandlers = {
  onChange: (change: Change) => void;
  onResync: () => void;
  onLost: (error: unknown) => void;
  onStatus: (status: LiveStatus) => void;
};

/**
 * Catch-up by polling `GET changes`, for someone who reads a board through a public grant: the server gives them
 * no stream. Asks every POLL_SECONDS while the page is visible, when it becomes visible again, and when told to.
 */
class ChangePoller {
  private cursor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private running: Promise<void> | null = null;
  status: LiveStatus = "idle";

  constructor(
    private readonly boardId: string,
    private readonly handlers: PollHandlers,
  ) {}

  start(cursor?: string | null) {
    this.cursor = cursor ?? null;
    document.addEventListener("visibilitychange", this.onVisible);
    this.setStatus("polling");
    // A view that just loaded passes its `as_of` cursor and waits its turn; without one, ask for the current cursor.
    if (this.cursor) this.schedule();
    else void this.poll();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  /** Asks now. Resolves once what came back has been applied. */
  poll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.running ??= this.run().finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") void this.poll();
    else clearTimeout(this.timer);
  };

  private setStatus(s: LiveStatus) {
    if (this.status === s) return;
    this.status = s;
    this.handlers.onStatus(s);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.closed || document.visibilityState !== "visible") return;
    this.timer = setTimeout(() => void this.poll(), POLL_SECONDS * 1000);
  }

  private async run() {
    clearTimeout(this.timer);
    try {
      for (;;) {
        const page = await api.changes(this.boardId, this.cursor);
        if (this.closed) return;
        for (const change of page.changes) this.handlers.onChange(change);
        this.cursor = page.cursor;
        if (!page.has_more) break;
      }
      this.setStatus("polling");
    } catch (e) {
      if (this.closed) return;
      if (isApiError(e, "cursor_expired")) {
        // Too old to catch up from: take the current cursor, then have the views reload.
        this.cursor = await api
          .changes(this.boardId)
          .then((page) => page.cursor)
          .catch(() => null);
        if (!this.closed) this.handlers.onResync();
      } else if (isApiError(e, "not_found", "forbidden", "access_ended", "unauthenticated")) {
        // The board stopped being public, or the session ended.
        this.close();
        this.setStatus("ended");
        this.handlers.onLost(e);
      } else {
        this.setStatus("reconnecting");
      }
    }
  }
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  emit(value: T) {
    for (const fn of [...this.listeners]) fn(value);
  }
}

/**
 * A board's changes as they happen, shared by every view of that board: the live stream for a member, and
 * polling for someone reading through a public grant, who gets no stream.
 */
export class BoardLive {
  readonly changes = new Emitter<Change>();
  readonly resync = new Emitter<void>();
  readonly ended = new Emitter<string>();
  /** Polling only: the board can no longer be read (it stopped being public, or the session ended). */
  readonly lost = new Emitter<unknown>();
  readonly statusChanged = new Emitter<LiveStatus>();
  /** Set before the first `ensure`: true for someone who is not a member. */
  polling = false;
  private stream: LiveStream | null = null;
  private poller: ChangePoller | null = null;
  private lastSeq = 0;

  constructor(private readonly boardId: string) {}

  get status(): LiveStatus {
    return this.stream?.status ?? this.poller?.status ?? "idle";
  }

  private apply(change: Change) {
    if (typeof change?.seq !== "number" || change.seq <= this.lastSeq) return;
    this.lastSeq = change.seq;
    this.changes.emit(change);
  }

  /**
   * Opens the stream (or starts polling) once. The first view to load passes its `as_of` cursor so
   * nothing that happened between its read and the stream opening is missed.
   */
  ensure(cursor?: string | null) {
    if (this.stream || this.poller) return;
    if (this.polling) {
      this.poller = new ChangePoller(this.boardId, {
        onChange: (change) => this.apply(change),
        onResync: () => this.resync.emit(),
        onLost: (e) => this.lost.emit(e),
        onStatus: (s) => this.statusChanged.emit(s),
      });
      this.poller.start(cursor);
      return;
    }
    this.stream = new LiveStream(streamUrls.board(this.boardId), {
      events: { change: (data) => this.apply(data as Change) },
      onResync: () => this.resync.emit(),
      onEnded: (reason) => this.ended.emit(reason),
      onStatus: (s) => this.statusChanged.emit(s),
    });
    this.stream.start(cursor);
  }

  /** Polling only: asks for changes now. With a stream there is nothing to ask for. */
  refresh(): Promise<void> {
    return this.poller?.poll() ?? Promise.resolve();
  }

  close() {
    this.stream?.close();
    this.stream = null;
    this.poller?.close();
    this.poller = null;
  }
}

/** The signed-in principal's inbox stream. */
export class InboxLive {
  readonly items = new Emitter<InboxItem>();
  readonly resync = new Emitter<void>();
  private stream: LiveStream | null = null;
  private seen = new Set<string>();

  start(cursor?: string | null) {
    if (this.stream) return;
    this.stream = new LiveStream(streamUrls.inbox(), {
      events: {
        inbox: (data) => {
          const item = data as InboxItem;
          if (!item?.id || this.seen.has(item.id)) return;
          this.seen.add(item.id);
          this.items.emit(item);
        },
      },
      onResync: () => this.resync.emit(),
    });
    this.stream.start(cursor);
  }

  close() {
    this.stream?.close();
    this.stream = null;
  }
}
