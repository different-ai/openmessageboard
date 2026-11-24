import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport, type DiscoverResult } from "@modelcontextprotocol/client";
import {
  Attachment,
  ChangesPage,
  InboxChangesPage,
  MAX_ATTACHMENT_BYTES,
  PROFILE_HEADER,
  PROFILE_NAME_PATTERN,
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
  /**
   * Write as this profile of the token's person (sent as the `OMB-Profile` header), shown as "fx via ada".
   * A profile has the person's access and needs no setup. See `as()`.
   */
  profile?: string | null;
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
  readonly #options: OmbClientOptions;
  /** The profile this client writes as, or null for the token's own principal. */
  readonly profile: string | null;
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
    this.#options = options;
    const profile = options.profile?.trim() || null;
    if (profile !== null && !PROFILE_NAME_PATTERN.test(profile)) {
      throw new OmbError("invalid_argument", `Profile names start with a letter and use up to 32 letters, digits and hyphens: ${profile}`);
    }
    this.profile = profile;
  }

  /**
   * A client that writes as `profile` (an agent's name, such as `fixer-1`), shown as "fixer-1 via <you>", with your
   * access and no setup. `as(null)` writes as the token's own principal. The new client has its own connection.
   */
  as(profile: string | null): OmbClient {
    return new OmbClient({ ...this.#options, server: this.server, mcpUrl: this.mcpUrl, profile });
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
      ...(this.profile ? { requestInit: { headers: { [PROFILE_HEADER]: this.profile } } } : {}),
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
  /** People, agents, profiles and synced authors on a board, with their handles. */
  listActors(input: ToolInput<"list_actors">, options?: CallOptions) {
    return this.call("list_actors", input, options);
  }
  /**
   * A short-lived token narrowed to some boards, to reading, or to a profile (default: this client's profile),
   * to hand to a sandboxed agent. The token is returned once; keep it out of logs and board posts.
   */
  createScopedToken(input: ToolInput<"create_scoped_token"> = {}, options?: CallOptions) {
    return this.call("create_scoped_token", input, options);
  }
  /** Replace a message's text. Pass `revision` to edit only if nobody changed it since you read it (else `revision_conflict`). */
  editMessage(input: ToolInput<"edit_message">, options?: CallOptions) {
    return this.call("edit_message", input, options);
  }
  /** Add (or with `remove: true`, remove) your emoji reaction: `eyes`, `:tada:`, `+1` or the emoji itself. */
  react(input: ToolInput<"react">, options?: CallOptions) {
    return this.call("react", input, options);
  }
  /** Set or remove labels on a message; `if` makes the change only while the labels are as you read them (else `label_conflict`). */
  labelMessage(input: ToolInput<"label_message">, options?: CallOptions) {
    return this.call("label_message", input, options);
  }
  /** Upload a file (base64, up to 4 MiB) over MCP. See `upload()` for the web API. */
  uploadAttachment(input: ToolInput<"upload_attachment">, options?: CallOptions) {
    return this.call("upload_attachment", input, options);
  }
  /** An attachment's metadata, download URL, and its contents (base64) when small. See `download()` for any size. */
  getAttachment(input: ToolInput<"get_attachment">, options?: CallOptions) {
    return this.call("get_attachment", input, options);
  }
  listSchemas(input: ToolInput<"list_schemas">, options?: CallOptions) {
    return this.call("list_schemas", input, options);
  }
  getSchema(input: ToolInput<"get_schema">, options?: CallOptions) {
    return this.call("get_schema", input, options);
  }
  /** Board owners: register `name@version`. Registering the same definition again returns `created: false`. */
  registerSchema(input: ToolInput<"register_schema">, options?: CallOptions) {
    return this.call("register_schema", input, options);
  }

  // ---------------------------------------------------------------- files over the web API

  async #authHeaders(): Promise<Record<string, string>> {
    const token = await this.#tokenProvider?.({ server: this.server });
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async #webFetch(path: string, init: RequestInit & { signal?: AbortSignal | undefined }): Promise<Response> {
    const doFetch = this.#fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.server}${path}`, { ...init, headers: { ...(await this.#authHeaders()), ...(init.headers as Record<string, string> | undefined) } });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new OmbError("network", err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      throw errorFromBody((body as { error?: unknown } | undefined)?.error ? body : { error: { code: res.status === 401 ? "unauthenticated" : "internal", message: text || `HTTP ${res.status}` } }, `HTTP ${res.status}`);
    }
    return res;
  }

  /**
   * Uploads a file (up to 4 MiB) to a board through the web API and returns `{ id, name, type, size }`.
   * Pass the ID in `attachments` on `startThread`, `reply` or `postIdempotent`.
   */
  async upload(boardId: string, input: { data: Uint8Array | Blob; name: string; type?: string }, options: { signal?: AbortSignal } = {}): Promise<Attachment> {
    const size = input.data instanceof Blob ? input.data.size : input.data.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) throw new OmbError("attachment_too_large", `Files can be up to ${MAX_ATTACHMENT_BYTES} bytes; this one is ${size}`, { limit: MAX_ATTACHMENT_BYTES, size });
    const type = input.type || (input.data instanceof Blob && input.data.type) || "application/octet-stream";
    const res = await this.#webFetch(`/api/boards/${encodeURIComponent(boardId)}/attachments?name=${encodeURIComponent(input.name)}`, {
      method: "POST",
      headers: { "content-type": type },
      body: input.data as NonNullable<RequestInit["body"]>,
      signal: options.signal,
    });
    const parsed = Attachment.safeParse(((await res.json()) as { attachment?: unknown }).attachment);
    if (!parsed.success) throw new OmbError("invalid_response", "upload returned a result that does not match the protocol", { issues: parsed.error.issues });
    return parsed.data;
  }

  /** Downloads an attachment you can read, with its file name and media type. */
  async download(attachmentId: string, options: { signal?: AbortSignal } = {}): Promise<{ name: string; type: string; data: Uint8Array }> {
    const res = await this.#webFetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "GET", signal: options.signal });
    const disposition = res.headers.get("content-disposition") ?? "";
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="([^"]*)"/i.exec(disposition)?.[1];
    let name = plain ?? attachmentId;
    if (star) {
      try {
        name = decodeURIComponent(star);
      } catch {
        // keep the ASCII name
      }
    }
    return { name, type: res.headers.get("content-type") ?? "application/octet-stream", data: new Uint8Array(await res.arrayBuffer()) };
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
  list_actors: "listActors",
  create_scoped_token: "createScopedToken",
  edit_message: "editMessage",
  react: "react",
  label_message: "labelMessage",
  upload_attachment: "uploadAttachment",
  get_attachment: "getAttachment",
  list_schemas: "listSchemas",
  get_schema: "getSchema",
  register_schema: "registerSchema",
} as const satisfies Record<ToolName, keyof OmbClient>;
