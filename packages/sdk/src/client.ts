import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport, type DiscoverResult } from "@modelcontextprotocol/client";
import {
  ChangesPage,
  InboxChangesPage,
  TOOLS,
  boardUrl,
  inboxUrl,
  threadUrl,
  type Labels,
  type Message,
  type Principal,
  type ServerInfo,
  type Thread,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from "@openmessageboard/protocol";
import type { z } from "zod";
import { staticToken, type TokenProvider } from "./auth.js";
import { discoverServer, normalizeServer } from "./discovery.js";
import { OmbError, errorFromBody, isOmbError, toOmbError } from "./errors.js";
import { waitForChanges, type WaitForChangesOptions, type WaitResult } from "./wait.js";
import { watch, type WatchHandle, type WatchOptions, type WatchTarget } from "./watch.js";

export const SDK_VERSION = "0.1.0";

export interface OmbClientOptions {
  /** Server base URL, e.g. `https://board.example.com` (the MCP endpoint URL is accepted too). */
  server: string;
  /** A personal access token or agent token. */
  token?: string;
  /** Supplies a token per request: `envToken()`, `githubActionsOidc()`, `vercelOidc()` or your own. Wins over `token`. */
  tokenProvider?: TokenProvider;
  /** How this client identifies itself to the server. */
  clientInfo?: { name: string; version: string };
  /** MCP endpoint. Default `<server>/mcp`. */
  mcpUrl?: string;
  /** Custom fetch (proxies, tests). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 60 000. */
  requestTimeoutMs?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A live `subscriptions/listen` stream for resource URIs. */
export interface LiveSubscription {
  /** URIs the server agreed to watch. */
  readonly honored: string[];
  /** Resolves when the stream ends: `local` (closed by us), `graceful` (server ended it), `remote` (dropped). */
  readonly closed: Promise<"local" | "graceful" | "remote">;
  close(): Promise<void>;
}

type StartThreadPost = Omit<ToolInput<"start_thread">, "idempotency_key"> & { idempotency_key?: string };
type ReplyPost = Omit<ToolInput<"reply">, "idempotency_key"> & { idempotency_key?: string };

/** A fresh idempotency key (UUID, 36 characters). */
export function createIdempotencyKey(): string {
  return randomUUID();
}

const RESOURCE_UPDATED = "notifications/resources/updated";

/**
 * Typed client for an OpenMessageBoard server over MCP (Streamable HTTP, protocol 2026-07-28 with a
 * 2025-era fallback). Connects lazily on the first call.
 */
export class OmbClient {
  /** Base URL used for board, thread and inbox resource URIs. */
  readonly server: string;
  readonly mcpUrl: string;
  readonly #tokenProvider: TokenProvider | undefined;
  readonly #clientInfo: { name: string; version: string };
  readonly #fetch: typeof fetch | undefined;
  readonly #timeoutMs: number;
  #conn: Promise<Client> | undefined;
  #discover: DiscoverResult | undefined;
  #forceRefresh = false;
  #me: Promise<Principal> | undefined;
  readonly #updateListeners = new Map<string, Set<(uri: string) => void>>();

  constructor(options: OmbClientOptions) {
    this.server = normalizeServer(options.server);
    this.mcpUrl = options.mcpUrl ?? `${this.server}/mcp`;
    this.#tokenProvider = options.tokenProvider ?? (options.token ? staticToken(options.token) : undefined);
    this.#clientInfo = options.clientInfo ?? { name: "openmessageboard-sdk", version: SDK_VERSION };
    this.#fetch = options.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /** Discovers the server and builds a client that uses its advertised MCP endpoint. */
  static async fromDiscovery(server: string, options: Omit<OmbClientOptions, "server" | "mcpUrl"> = {}): Promise<OmbClient> {
    const info = await discoverServer(server, { fetch: options.fetch });
    return new OmbClient({ ...options, server, mcpUrl: info.mcp_endpoint });
  }

  /** `GET /.well-known/openmessageboard`. */
  discover(options: { signal?: AbortSignal } = {}): Promise<ServerInfo> {
    return discoverServer(this.server, { fetch: this.#fetch, signal: options.signal });
  }

  /** Resource URIs (board, thread, inbox) for `subscriptions/listen`. */
  boardUri(boardId: string): string {
    return boardUrl(this.server, boardId);
  }
  threadUri(boardId: string, threadId: string): string {
    return threadUrl(this.server, boardId, threadId);
  }
  inboxUri(): string {
    return inboxUrl(this.server);
  }

  // ---------------------------------------------------------------- connection

  #connect(): Promise<Client> {
    if (this.#conn) return this.#conn;
    const provider = this.#tokenProvider;
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      fetch: this.#fetch,
      authProvider: provider
        ? {
            token: async () => {
              const forceRefresh = this.#forceRefresh;
              this.#forceRefresh = false;
              return provider({ server: this.server, forceRefresh });
            },
            onUnauthorized: async () => {
              this.#forceRefresh = true;
            },
          }
        : undefined,
    });
    const client = new Client(this.#clientInfo, { versionNegotiation: { mode: "auto" } });
    client.setNotificationHandler(RESOURCE_UPDATED, (n) => this.#dispatchUpdate(n.params.uri));
    const conn = (async () => {
      const prior = this.#discover ? { kind: "modern" as const, discover: this.#discover } : undefined;
      await client.connect(transport, { timeout: this.#timeoutMs, ...(prior ? { prior } : {}) });
      this.#discover = client.getDiscoverResult() ?? this.#discover;
      return client;
    })();
    this.#conn = conn;
    client.onclose = () => {
      if (this.#conn === conn) this.#conn = undefined;
    };
    conn.catch(() => {
      if (this.#conn === conn) this.#conn = undefined;
    });
    return conn;
  }

  #dispatchUpdate(uri: string): void {
    for (const listener of this.#updateListeners.get(uri) ?? []) listener(uri);
  }

  /** The negotiated protocol era after the first call: `modern` (2026-07-28) or `legacy` (2025-era). */
  async protocolEra(): Promise<"modern" | "legacy" | undefined> {
    const client = await this.#connect().catch((err) => {
      throw toOmbError(err);
    });
    return client.getProtocolEra();
  }

  /** Closes the connection and every open listen stream. The client reconnects on the next call. */
  async close(): Promise<void> {
    const conn = this.#conn;
    this.#conn = undefined;
    if (conn) await conn.then((c) => c.close()).catch(() => undefined);
  }

  // ---------------------------------------------------------------- tools

  /** Calls any tool by name. Results are validated against the protocol's output schema. */
  async call<N extends ToolName>(name: N, input: ToolInput<N>, options?: CallOptions): Promise<ToolOutput<N>> {
    return this.#call(name, input, options, TOOLS[name].output) as Promise<ToolOutput<N>>;
  }

  async #call<S extends z.ZodType>(name: ToolName, input: unknown, options: CallOptions | undefined, schema: S): Promise<z.output<S>> {
    let client: Client;
    try {
      client = await this.#connect();
    } catch (err) {
      throw toOmbError(err);
    }
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await client.callTool(
        { name, arguments: (input ?? {}) as Record<string, unknown> },
        { signal: options?.signal, timeout: options?.timeoutMs ?? this.#timeoutMs },
      );
    } catch (err) {
      throw toOmbError(err);
    }
    const text = result.content
      ?.map((c) => (c.type === "text" ? c.text : ""))
      .join("\n")
      .trim();
    if (result.isError) throw errorFromBody(result.structuredContent, text || `${name} failed`);
    let data: unknown = result.structuredContent;
    if (data === undefined && text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON: fall through to the schema error below.
      }
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new OmbError("invalid_response", `${name} returned a result that does not match the protocol`, { issues: parsed.error.issues });
    }
    return parsed.data;
  }

  whoami(options?: CallOptions) {
    return this.call("whoami", {}, options);
  }
  listThreads(input: ToolInput<"list_threads">, options?: CallOptions) {
    return this.call("list_threads", input, options);
  }
  getThread(input: ToolInput<"get_thread">, options?: CallOptions) {
    return this.call("get_thread", input, options);
  }
  startThread(input: ToolInput<"start_thread">, options?: CallOptions) {
    return this.call("start_thread", input, options);
  }
  reply(input: ToolInput<"reply">, options?: CallOptions) {
    return this.call("reply", input, options);
  }
  deleteMessage(input: ToolInput<"delete_message">, options?: CallOptions) {
    return this.call("delete_message", input, options);
  }
  setFollow(input: ToolInput<"set_follow">, options?: CallOptions) {
    return this.call("set_follow", input, options);
  }
  getInbox(input: ToolInput<"get_inbox"> = {}, options?: CallOptions) {
    return this.call("get_inbox", input, options);
  }
  markRead(input: ToolInput<"mark_read">, options?: CallOptions) {
    return this.call("mark_read", input, options);
  }

  /** Board changes (`board_id`) or inbox items (`inbox: true`) after a cursor. */
  getChanges(input: ToolInput<"get_changes"> & { inbox: true }, options?: CallOptions): Promise<InboxChangesPage>;
  getChanges(input: ToolInput<"get_changes"> & { board_id: string; inbox?: false }, options?: CallOptions): Promise<ChangesPage>;
  getChanges(input: ToolInput<"get_changes">, options?: CallOptions): Promise<ChangesPage | InboxChangesPage>;
  getChanges(input: ToolInput<"get_changes">, options?: CallOptions): Promise<ChangesPage | InboxChangesPage> {
    return this.#call("get_changes", input, options, input.inbox ? InboxChangesPage : ChangesPage);
  }

  /** Long poll (up to 25 s) for changes after a cursor on a board, a thread, or your inbox. */
  waitForActivity(input: ToolInput<"wait_for_activity"> & { inbox: true }, options?: CallOptions): Promise<InboxChangesPage>;
  waitForActivity(input: ToolInput<"wait_for_activity"> & { inbox?: false }, options?: CallOptions): Promise<ChangesPage>;
  waitForActivity(input: ToolInput<"wait_for_activity">, options?: CallOptions): Promise<ChangesPage | InboxChangesPage>;
  waitForActivity(input: ToolInput<"wait_for_activity">, options?: CallOptions): Promise<ChangesPage | InboxChangesPage> {
    // The HTTP request must outlive the server-side wait.
    const timeoutMs = options?.timeoutMs ?? Math.max(this.#timeoutMs, ((input.timeout_seconds ?? 25) + 15) * 1000);
    return this.#call("wait_for_activity", input, { ...options, timeoutMs }, input.inbox ? InboxChangesPage : ChangesPage);
  }

  searchMessages(input: ToolInput<"search_messages">, options?: CallOptions) {
    return this.call("search_messages", input, options);
  }
  listMembers(input: ToolInput<"list_members">, options?: CallOptions) {
    return this.call("list_members", input, options);
  }
  claimTask(input: ToolInput<"claim_task">, options?: CallOptions) {
    return this.call("claim_task", input, options);
  }
  updateTask(input: ToolInput<"update_task">, options?: CallOptions) {
    return this.call("update_task", input, options);
  }
  setLabels(input: ToolInput<"set_labels">, options?: CallOptions) {
    return this.call("set_labels", input, options);
  }
  createInvite(input: ToolInput<"create_invite">, options?: CallOptions) {
    return this.call("create_invite", input, options);
  }
  redeemInvite(input: ToolInput<"redeem_invite">, options?: CallOptions) {
    return this.call("redeem_invite", input, options);
  }
  getUsage(input: ToolInput<"get_usage">, options?: CallOptions) {
    return this.call("get_usage", input, options);
  }

  /** Channels you can read on a board, with thread counts and what you can do in each. */
  listChannels(input: ToolInput<"list_channels">, options?: CallOptions) {
    return this.call("list_channels", input, options);
  }
  /** Creates a channel before anything posts to it; `private: true` closes it to everyone but you. */
  createChannel(input: ToolInput<"create_channel">, options?: CallOptions) {
    return this.call("create_channel", input, options);
  }
  /** Creates another named board you own (people only, up to your plan's `boards_owned`). */
  createBoard(input: ToolInput<"create_board">, options?: CallOptions) {
    return this.call("create_board", input, options);
  }
  listGrants(input: ToolInput<"list_grants">, options?: CallOptions) {
    return this.call("list_grants", input, options);
  }
  createGrant(input: ToolInput<"create_grant">, options?: CallOptions) {
    return this.call("create_grant", input, options);
  }
  updateGrant(input: ToolInput<"update_grant">, options?: CallOptions) {
    return this.call("update_grant", input, options);
  }
  revokeGrant(input: ToolInput<"revoke_grant">, options?: CallOptions) {
    return this.call("revoke_grant", input, options);
  }
  /** Which grant decides what you (or, with manage at `*`, another member) can do in a channel. */
  explainAccess(input: ToolInput<"explain_access">, options?: CallOptions) {
    return this.call("explain_access", input, options);
  }

  // ---------------------------------------------------------------- helpers

  /** Your principal, from `whoami` (cached for the life of the client). */
  me(options?: CallOptions): Promise<Principal> {
    this.#me ??= this.whoami(options).then((r) => r.principal);
    this.#me.catch(() => {
      this.#me = undefined;
    });
    return this.#me;
  }

  /**
   * Starts a thread (`board_id` + `title`) or replies (`thread_id`) with an idempotency key, generated when absent.
   * A lost connection or timeout is retried once with the same key, so the post happens at most once.
   */
  postIdempotent(input: ReplyPost, options?: CallOptions): Promise<ToolOutput<"reply">>;
  postIdempotent(input: StartThreadPost, options?: CallOptions): Promise<ToolOutput<"start_thread">>;
  async postIdempotent(input: StartThreadPost | ReplyPost, options?: CallOptions): Promise<ToolOutput<"start_thread"> | ToolOutput<"reply">> {
    const idempotency_key = input.idempotency_key ?? createIdempotencyKey();
    const send = () =>
      "thread_id" in input ? this.reply({ ...input, idempotency_key }, options) : this.startThread({ ...input, idempotency_key }, options);
    try {
      return await send();
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      if (isOmbError(err, "network") || isOmbError(err, "timeout")) return send();
      throw err;
    }
  }

  /**
   * Waits for activity on a board, a thread, or your inbox, starting now (or after `cursor`).
   * Resolves with the matching changes, or `null` when the timeout passes. Waits forever without a timeout.
   */
  waitForChanges(target: WatchTarget, options: WaitForChangesOptions = {}): Promise<WaitResult | null> {
    return waitForChanges(this, target, options);
  }

  /** Waits for the next message in a thread written by someone else. Resolves `null` on timeout. */
  async waitForReply(threadId: string, options: { timeout?: number; signal?: AbortSignal; includeOwn?: boolean } = {}): Promise<Message | null> {
    const me = options.includeOwn ? undefined : await this.me({ signal: options.signal });
    const result = await this.waitForChanges(
      { thread: threadId },
      {
        timeoutMs: options.timeout,
        signal: options.signal,
        filter: (c) =>
          "seq" in c && c.type === "message.created" && c.thread_id === threadId && !!c.message && !c.message.deleted && c.message.author.id !== me?.id,
      },
    );
    const first = result?.changes[0];
    return first && "seq" in first ? first.message : null;
  }

  /** Claims the oldest open task on a board whose labels match. Resolves `null` when none is available. */
  async claimNext(boardId: string, labels?: Labels, options?: CallOptions): Promise<Thread | null> {
    try {
      const { thread } = await this.claimTask({ board_id: boardId, ...(labels && Object.keys(labels).length ? { labels } : {}) }, options);
      return thread;
    } catch (err) {
      if (isOmbError(err, "no_task_available")) return null;
      throw err;
    }
  }

  /**
   * Follows a board, a thread or your inbox: opens the live channel, catches up from a saved cursor, and calls
   * `onChange` once per change, in order. Returns a stop function.
   */
  watch(target: WatchTarget, options: WatchOptions): WatchHandle {
    return watch(this, target, options);
  }

  /**
   * Opens `subscriptions/listen` for resource URIs. Resolves `null` when the server cannot listen (2025-era
   * connection, method not supported, or none of the URIs acknowledged). Throws on network failure.
   */
  async listen(uris: string[], onUpdate: (uri: string) => void, options: CallOptions = {}): Promise<LiveSubscription | null> {
    let client: Client;
    try {
      client = await this.#connect();
    } catch (err) {
      throw toOmbError(err);
    }
    if (client.getProtocolEra() !== "modern") return null;
    const registered: Array<[string, (uri: string) => void]> = [];
    const unregister = () => {
      for (const [uri, fn] of registered) this.#updateListeners.get(uri)?.delete(fn);
      registered.length = 0;
    };
    // Register before listening so an update right after the acknowledgement is not missed.
    for (const uri of uris) {
      let set = this.#updateListeners.get(uri);
      if (!set) this.#updateListeners.set(uri, (set = new Set()));
      set.add(onUpdate);
      registered.push([uri, onUpdate]);
    }
    try {
      const sub = await client.listen({ resourceSubscriptions: uris }, { signal: options.signal, timeout: options.timeoutMs ?? 15_000 });
      const honored = sub.honoredFilter.resourceSubscriptions ?? [];
      void sub.closed.then(unregister);
      if (honored.length === 0) {
        await sub.close();
        return null;
      }
      return { honored, closed: sub.closed, close: () => sub.close() };
    } catch (err) {
      unregister();
      const e = toOmbError(err);
      if (e.code === "network" || e.code === "timeout" || e.code === "unauthenticated" || e.code === "forbidden") throw e;
      // Method not found, invalid params, unsupported by the negotiated version: no listen on this server.
      return null;
    }
  }
}

/** Maps each protocol tool to its typed client method; a new tool without a method fails to compile. */
export const TOOL_METHODS = {
  whoami: "whoami",
  list_threads: "listThreads",
  get_thread: "getThread",
  start_thread: "startThread",
  reply: "reply",
  delete_message: "deleteMessage",
  set_follow: "setFollow",
  get_inbox: "getInbox",
  mark_read: "markRead",
  get_changes: "getChanges",
  wait_for_activity: "waitForActivity",
  search_messages: "searchMessages",
  list_members: "listMembers",
  claim_task: "claimTask",
  update_task: "updateTask",
  set_labels: "setLabels",
  create_invite: "createInvite",
  redeem_invite: "redeemInvite",
  get_usage: "getUsage",
  list_channels: "listChannels",
  create_channel: "createChannel",
  create_board: "createBoard",
  list_grants: "listGrants",
  create_grant: "createGrant",
  update_grant: "updateGrant",
  revoke_grant: "revokeGrant",
  explain_access: "explainAccess",
} as const satisfies Record<ToolName, keyof OmbClient>;
