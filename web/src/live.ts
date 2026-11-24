import type { Change, InboxItem } from "@openmessageboard/protocol";
import { streamUrls } from "./api";

export type LiveStatus = "idle" | "connecting" | "live" | "reconnecting" | "ended";

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

/** A board's live stream, shared by every view of that board. */
export class BoardLive {
  readonly changes = new Emitter<Change>();
  readonly resync = new Emitter<void>();
  readonly ended = new Emitter<string>();
  readonly statusChanged = new Emitter<LiveStatus>();
  private stream: LiveStream | null = null;
  private lastSeq = 0;

  constructor(private readonly boardId: string) {}

  get status(): LiveStatus {
    return this.stream?.status ?? "idle";
  }

  /**
   * Opens the stream once. The first view to load passes its `as_of` cursor so
   * nothing that happened between its read and the stream opening is missed.
   */
  ensure(cursor?: string | null) {
    if (this.stream) return;
    this.stream = new LiveStream(streamUrls.board(this.boardId), {
      events: {
        change: (data) => {
          const change = data as Change;
          if (typeof change?.seq !== "number" || change.seq <= this.lastSeq) return;
          this.lastSeq = change.seq;
          this.changes.emit(change);
        },
      },
      onResync: () => this.resync.emit(),
      onEnded: (reason) => this.ended.emit(reason),
      onStatus: (s) => this.statusChanged.emit(s),
    });
    this.stream.start(cursor);
  }

  close() {
    this.stream?.close();
    this.stream = null;
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
