/**
 * A tiny in-process OpenMessageBoard server that speaks just enough MCP (Streamable HTTP, 2026-07-28 with an
 * optional 2025-era mode) for the SDK tests. One board, in-memory event log, controllable failures.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Change, Message, PrincipalRef, Thread } from "@openmessageboard/protocol";

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  auth: string | undefined;
  /** The `OMB-Profile` header, when sent. */
  profile?: string | undefined;
}

export interface CallContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Destroy the socket after the handler ran, so the client never sees the response. */
  dropResponse(): void;
}

type ToolHandler = (args: Record<string, unknown>, ctx: CallContext) => unknown | Promise<unknown>;

export interface FakeOptions {
  /** `modern` answers server/discover; `legacy` only answers initialize. */
  era?: "modern" | "legacy";
  /** `honor` acknowledges listen URIs; `ignore` acknowledges an empty filter. */
  listen?: "honor" | "ignore";
  pageSize?: number;
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export const MAYA: PrincipalRef = { id: "p_maya", kind: "human", display_name: "Maya", via: null };
export const RELEASE_AGENT: PrincipalRef = { id: "p_release", kind: "agent", display_name: "release-agent", via: { id: "p_maya", display_name: "Maya" } };
export const OMAR: PrincipalRef = { id: "p_omar", kind: "human", display_name: "Omar", via: null };

export class FakeServer {
  readonly options: Required<FakeOptions>;
  readonly calls: CallRecord[] = [];
  readonly rpcMethods: string[] = [];
  readonly tools: Record<string, ToolHandler> = {};
  readonly boardId = "b_main";
  /** Principal returned by whoami. */
  me: PrincipalRef = MAYA;
  events: Change[] = [];
  threads = new Map<string, Thread>();
  messages = new Map<string, Message>();
  expiredCursors = new Set<string>();
  /** Runs before get_changes computes its answer. */
  beforeGetChanges?: (args: Record<string, unknown>) => void | Promise<void>;
  /** Runs after get_changes computed its answer but before it is sent. */
  afterGetChanges?: (args: Record<string, unknown>) => void | Promise<void>;
  idempotency = new Map<string, unknown>();
  url = "";
  #server: Server;
  #listens = new Set<{ res: ServerResponse; uris: string[]; id: unknown }>();
  #waiters = new Set<() => void>();
  #seq = 0;
  #ids = 0;

  constructor(options: FakeOptions = {}) {
    this.options = { era: "modern", listen: "honor", pageSize: 100, ...options };
    this.#server = createServer((req, res) => void this.#handle(req, res));
    this.#installDefaultTools();
  }

  async start(port = 0): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.dropListens();
    for (const w of this.#waiters) w();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  get port(): number {
    return Number(new URL(this.url).port);
  }

  // ------------------------------------------------------------ board state

  nextId(prefix: string): string {
    return `${prefix}_${++this.#ids}`;
  }

  cursorFor(seq: number): string {
    return `c${seq}`;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  boardUri(): string {
    return `${this.url}/b/${this.boardId}`;
  }

  threadUri(threadId: string): string {
    return `${this.url}/b/${this.boardId}/t/${threadId}`;
  }

  addThread(title: string, author: PrincipalRef = MAYA, body = "Root message", opts: { task?: boolean; labels?: Record<string, string> } = {}): { thread: Thread; message: Message } {
    const id = this.nextId("t");
    const thread: Thread = {
      id,
      board_id: this.boardId,
      url: this.threadUri(id),
      title,
      kind: opts.task ? "task" : "discussion",
      labels: opts.labels ?? {},
      task: opts.task ? { state: "open", assignee: null, claimed_at: null, completed_at: null } : null,
      created_by: author,
      created_at: iso(),
      last_activity_at: iso(),
      message_count: 0,
      following: true,
      unread_count: 0,
      links: [],
    };
    this.threads.set(id, thread);
    this.#append({ type: "thread.created", thread_id: id, message_id: null, actor: author, thread, message: null });
    const message = this.postMessage(id, body, author, { silent: true });
    return { thread, message };
  }

  postMessage(threadId: string, body: string, author: PrincipalRef = OMAR, opts: { silent?: boolean } = {}): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`no thread ${threadId}`);
    const message: Message = {
      id: this.nextId("m"),
      board_id: this.boardId,
      thread_id: threadId,
      author,
      body,
      deleted: false,
      reply_to: null,
      mentions: [],
      source: null,
      created_at: iso(),
      revision: 1,
      edited_at: null,
      labels: {},
      reactions: [],
      blocks: [],
      attachments: [],
    };
    this.messages.set(message.id, message);
    thread.message_count++;
    thread.last_activity_at = message.created_at;
    this.#append({ type: "message.created", thread_id: threadId, message_id: message.id, actor: author, thread: null, message });
    if (!opts.silent) this.notify([this.boardUri(), this.threadUri(threadId)]);
    return message;
  }

  #append(partial: Omit<Change, "seq" | "board_id" | "created_at" | "member">): Change {
    const change: Change = { seq: ++this.#seq, board_id: this.boardId, created_at: iso(), member: null, ...partial };
    this.events.push(change);
    for (const w of [...this.#waiters]) w();
    return change;
  }

  /** Sends `notifications/resources/updated` on every open listen stream watching one of the URIs. */
  notify(uris: string[]): void {
    for (const l of this.#listens) {
      for (const uri of uris) {
        if (!l.uris.includes(uri)) continue;
        this.#sse(l.res, { jsonrpc: "2.0", method: "notifications/resources/updated", params: { _meta: { "io.modelcontextprotocol/subscriptionId": l.id }, uri } });
      }
    }
  }

  get openListens(): number {
    return this.#listens.size;
  }

  /** Ends every listen stream without a response (an unexpected disconnect). */
  dropListens(): void {
    for (const l of this.#listens) l.res.destroy();
    this.#listens.clear();
  }

  #changesAfter(cursor: string, threadId?: string): { changes: Change[]; cursor: string; has_more: boolean } {
    const after = Number(cursor.slice(1));
    const all = this.events.filter((e) => e.seq > after && (!threadId || e.thread_id === threadId));
    const page = all.slice(0, this.options.pageSize);
    const last = page.at(-1)?.seq ?? (threadId ? this.#seq : Math.max(after, 0));
    return { changes: page, cursor: this.cursorFor(threadId && page.length === 0 ? this.#seq : last), has_more: all.length > page.length };
  }

  #installDefaultTools(): void {
    this.tools.whoami = () => ({
      principal: { id: this.me.id, kind: this.me.kind, display_name: this.me.display_name, email: null, owner: null },
      owned_board: null,
      memberships: [],
      server: {
        spec_version: "0.1",
        implementation: { name: "fake", version: "0" },
        profiles: ["core", "live"],
        mcp_endpoint: `${this.url}/mcp`,
        issuer: this.url,
        web_url: this.url,
        limits: {},
        rate_limits: {},
      },
    });
    this.tools.get_changes = async (args) => {
      await this.beforeGetChanges?.(args);
      const cursor = args.cursor as string | undefined;
      if (cursor && this.expiredCursors.has(cursor)) throw new ToolError("cursor_expired", "Cursor is older than the retention window");
      const result = cursor ? this.#changesAfter(cursor) : { changes: [], cursor: this.cursorFor(this.#seq), has_more: false };
      await this.afterGetChanges?.(args);
      return result;
    };
    this.tools.wait_for_activity = async (args) => {
      const cursor = args.cursor as string;
      if (this.expiredCursors.has(cursor)) throw new ToolError("cursor_expired", "Cursor is older than the retention window");
      const threadId = args.thread_id as string | undefined;
      const deadline = Date.now() + Number(args.timeout_seconds ?? 25) * 1000;
      for (;;) {
        const page = this.#changesAfter(cursor, threadId);
        if (page.changes.length > 0 || Date.now() >= deadline) return page;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, deadline - Date.now());
          const self = this;
          function done() {
            clearTimeout(timer);
            self.#waiters.delete(done);
            resolve();
          }
          this.#waiters.add(done);
        });
      }
    };
    this.tools.get_thread = (args) => {
      const thread = this.threads.get(args.thread_id as string);
      if (!thread) throw new ToolError("not_found", "No such thread");
      const messages = [...this.messages.values()].filter((m) => m.thread_id === thread.id).slice(0, Number(args.limit ?? 50));
      return { thread, messages, next_page_cursor: null, as_of: this.cursorFor(this.#seq) };
    };
    this.tools.start_thread = (args) => {
      const key = `start:${args.idempotency_key}`;
      if (this.idempotency.has(key)) return this.idempotency.get(key);
      const { thread, message } = this.addThread(args.title as string, this.me, args.body as string, { task: args.task === true });
      const result = { thread, message };
      this.idempotency.set(key, result);
      return result;
    };
    this.tools.reply = (args) => {
      const key = `reply:${args.idempotency_key}`;
      if (this.idempotency.has(key)) return this.idempotency.get(key);
      if (!this.threads.has(args.thread_id as string)) throw new ToolError("not_found", "No such thread");
      const result = { message: this.postMessage(args.thread_id as string, args.body as string, this.me) };
      this.idempotency.set(key, result);
      return result;
    };
  }

  // ------------------------------------------------------------ HTTP

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && path === "/.well-known/openmessageboard") {
      return this.#json(res, 200, (this.tools.whoami!({}, this.#ctx(req, res)) as { server: unknown }).server);
    }
    if (path !== "/mcp") return this.#json(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string; params?: Record<string, unknown> };
    if (msg.method) this.rpcMethods.push(msg.method);
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const modern = this.options.era === "modern";
    // 2026-07-28 results must carry resultType; 2025-era results must not need it.
    const reply = (result: object) => this.#json(res, 200, { jsonrpc: "2.0", id: msg.id, result: modern ? { resultType: "complete", ...result } : result });
    const fail = (code: number, message: string) => this.#json(res, 200, { jsonrpc: "2.0", id: msg.id, error: { code, message } });

    switch (msg.method) {
      case "server/discover":
        if (this.options.era === "legacy") return fail(-32601, "Method not found");
        return reply({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: { subscribe: true } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake-omb", version: "0.0.0" } },
        });
      case "initialize":
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-omb", version: "0.0.0" } });
      case "ping":
        return reply({});
      case "tools/call":
        return this.#toolsCall(req, res, msg.id, msg.params ?? {});
      case "subscriptions/listen": {
        const filter = (msg.params?.notifications ?? {}) as { resourceSubscriptions?: string[] };
        const uris = this.options.listen === "honor" ? (filter.resourceSubscriptions ?? []) : [];
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        res.flushHeaders();
        const entry = { res, uris, id: msg.id };
        this.#listens.add(entry);
        res.on("close", () => this.#listens.delete(entry));
        this.#sse(res, {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: { _meta: { "io.modelcontextprotocol/subscriptionId": msg.id }, notifications: { resourceSubscriptions: uris } },
        });
        return;
      }
      default:
        return fail(-32601, "Method not found");
    }
  }

  #ctx(req: IncomingMessage, res: ServerResponse, onDrop?: () => void): CallContext {
    return { req, res, dropResponse: () => onDrop?.() };
  }

  async #toolsCall(req: IncomingMessage, res: ServerResponse, id: unknown, params: Record<string, unknown>): Promise<void> {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const auth = req.headers.authorization;
    const profile = req.headers["omb-profile"];
    this.calls.push({ name, args, auth, ...(typeof profile === "string" ? { profile } : {}) });
    if (auth === "Bearer bad-token") {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer error="invalid_token"' }).end();
      return;
    }
    let drop = false;
    const handler = this.tools[name];
    let result: unknown;
    try {
      if (!handler) throw new ToolError("invalid_argument", `Unknown tool ${name}`);
      const structured = await handler(args, this.#ctx(req, res, () => (drop = true)));
      result = { content: [{ type: "text", text: `${name} ok` }], structuredContent: structured };
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      result = {
        content: [{ type: "text", text: err.message }],
        structuredContent: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
        isError: true,
      };
    }
    if (drop) {
      res.socket?.destroy();
      return;
    }
    const typed = this.options.era === "modern" ? { resultType: "complete", ...(result as object) } : result;
    this.#json(res, 200, { jsonrpc: "2.0", id, result: typed });
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  #sse(res: ServerResponse, message: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
}
