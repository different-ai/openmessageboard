/**
 * MCP access for one principal, using only the public interface: the
 * `@modelcontextprotocol/client` v2 SDK over Streamable HTTP with a bearer token.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, JsonSchemaValidator, McpSubscription, jsonSchemaValidator } from "@modelcontextprotocol/client";
import { ERROR_CODES, MCP_PROTOCOL_VERSION, TOOLS, WRITE_TOOLS } from "@openmessageboard/protocol";
import type { ErrorBody, ToolInput, ToolName, ToolOutput } from "@openmessageboard/protocol";
import { Failure } from "./errors.ts";
import { CLIENT_INFO, rawRpc, type RpcOutcome } from "./http.ts";
import { ToolError } from "./schemagen/build.ts";
import { describeError, sleep } from "./util.ts";

/** Accept every structuredContent at the SDK layer; the runner validates against the protocol itself. */
const permissiveValidator: jsonSchemaValidator = {
  getValidator<T>() {
    return ((input: unknown) => ({ valid: true, data: input, errorMessage: undefined })) as JsonSchemaValidator<T>;
  },
};

export type ToolOutcome<N extends ToolName> =
  | { ok: true; data: ToolOutput<N>; result: CallToolResult }
  | { ok: false; error: ErrorBody; result: CallToolResult };

export interface CallOptions {
  /** Do not wait and retry when the server answers rate_limited. */
  noRetry?: boolean;
  timeoutMs?: number;
}

/** Wire-contract observations collected across all calls (reported by one case at the end). */
export const contractIssues = new Map<string, string>();
const noteIssue = (key: string, msg: string) => {
  if (!contractIssues.has(key)) contractIssues.set(key, msg);
};
export let rateLimitWaits = 0;

/**
 * Client-side pacing of write tools per principal, so the runner's own bursts stay
 * under the server's `writes_per_minute_principal` and timing-sensitive cases are
 * not distorted by rate limiting. Set from the discovery document; 0 disables it.
 */
export const writePacing = { perMinute: 0 };
const writeLog = new Map<string, number[]>();
async function paceWrites(token: string, n: number): Promise<void> {
  if (!writePacing.perMinute) return;
  const budget = Math.max(1, writePacing.perMinute - 1);
  let log = writeLog.get(token);
  if (!log) writeLog.set(token, (log = []));
  for (;;) {
    const now = Date.now();
    while (log.length && log[0]! <= now - 60_000) log.shift();
    if (log.length + n <= budget || log.length === 0) return;
    await sleep(log[0]! + 60_000 - now + 50);
  }
}

export class McpSession {
  private constructor(
    readonly name: string,
    readonly endpoint: string,
    private readonly token: string,
    readonly client: Client,
  ) {}

  /** `headers` are sent on every request, such as `OMB-Profile` to write as a profile. */
  static async connect(name: string, endpoint: string, token: string, timeoutMs = 15_000, headers?: Record<string, string>): Promise<McpSession> {
    const client = new Client(CLIENT_INFO, {
      versionNegotiation: { mode: "auto" },
      jsonSchemaValidator: permissiveValidator,
      capabilities: { extensions: { "io.modelcontextprotocol/events": {} } },
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider: { token: async () => token },
      ...(headers ? { requestInit: { headers } } : {}),
    });
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (e) {
      throw new Failure(`${name}: MCP connect to ${endpoint} failed: ${describeError(e)}`);
    }
    return new McpSession(name, endpoint, token, client);
  }

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  get modern(): boolean {
    return this.protocolVersion === MCP_PROTOCOL_VERSION;
  }

  /** Calls a tool with arbitrary arguments (for invalid-input tests). */
  async callRaw(tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolOutcome<ToolName>> {
    const isWrite = WRITE_TOOLS.has(tool as ToolName);
    for (let attempt = 0; ; attempt++) {
      if (isWrite) {
        await paceWrites(this.token, 1);
        writeLog.get(this.token)?.push(Date.now());
      }
      let result: CallToolResult;
      try {
        result = (await this.client.callTool({ name: tool, arguments: args }, { timeout: opts.timeoutMs ?? 60_000 })) as CallToolResult;
      } catch (e) {
        throw new Failure(`${this.name}: ${tool} raised a JSON-RPC/transport error instead of returning a result: ${describeError(e)}`);
      }
      if (!Array.isArray(result.content) || !result.content.some((c) => c.type === "text")) {
        noteIssue(`content:${tool}`, `${tool} result has no text content block (06 §Tool results)`);
      }
      if (result.isError === true) {
        const parsed = ToolError.safeParse(result.structuredContent);
        if (!parsed.success) {
          throw new Failure(
            `${this.name}: ${tool} returned isError without a valid structuredContent.error {code, message, details} (06 §Tool errors): ${JSON.stringify(result.structuredContent ?? result.content).slice(0, 300)}`,
          );
        }
        const error = parsed.data.error as ErrorBody;
        if (error.code === "rate_limited" && !opts.noRetry && attempt < 6) {
          const wait = Number((error.details as { retry_after_ms?: unknown } | undefined)?.retry_after_ms ?? 1000);
          if (!Number.isFinite(wait)) noteIssue("rate_limited", "rate_limited errors carry details.retry_after_ms (07)");
          rateLimitWaits++;
          await sleep(Math.min(Math.max(Number.isFinite(wait) ? wait : 1000, 100), 65_000) + Math.random() * 200);
          continue;
        }
        return { ok: false, error, result };
      }
      const schema = (TOOLS as Record<string, { output: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } } }>)[tool];
      if (!schema) return { ok: true, data: result.structuredContent as never, result };
      const parsed = schema.output.safeParse(result.structuredContent);
      if (!parsed.success) {
        const issues = (parsed.error?.issues ?? []).slice(0, 5).map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ");
        throw new Failure(`${this.name}: ${tool} structuredContent does not match schemas/v0.1/tools/${tool}.output.json: ${issues}`);
      }
      return { ok: true, data: parsed.data as never, result };
    }
  }

  async call<N extends ToolName>(tool: N, args: ToolInput<N>, opts: CallOptions = {}): Promise<ToolOutcome<N>> {
    return (await this.callRaw(tool, args as Record<string, unknown>, opts)) as ToolOutcome<N>;
  }

  /** Calls a tool and fails the case unless it succeeds. */
  async ok<N extends ToolName>(tool: N, args: ToolInput<N>, opts: CallOptions = {}): Promise<ToolOutput<N>> {
    const r = await this.call(tool, args, opts);
    if (!r.ok) throw new Failure(`${this.name}: ${tool} failed with ${r.error.code}: ${r.error.message}`, r.error);
    return r.data;
  }

  /** Calls a tool and fails the case unless it returns the given tool error code. */
  async fails(tool: string, args: Record<string, unknown>, code: (typeof ERROR_CODES)[number] | (typeof ERROR_CODES)[number][], opts: CallOptions = {}): Promise<ErrorBody> {
    const r = await this.callRaw(tool, args, opts);
    const codes = Array.isArray(code) ? code : [code];
    if (r.ok) throw new Failure(`${this.name}: ${tool} succeeded; expected ${codes.join(" or ")}`, r.data);
    if (!codes.includes(r.error.code)) {
      throw new Failure(`${this.name}: ${tool} returned ${r.error.code} (${r.error.message}); expected ${codes.join(" or ")}`, r.error);
    }
    return r.error;
  }

  /** Waits until this principal can make `n` writes without being paced (for timing-sensitive steps). */
  reserveWrites(n: number): Promise<void> {
    return paceWrites(this.token, n);
  }

  /** A JSON-RPC request on the raw wire with this principal's token. */
  rpc(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<RpcOutcome> {
    return rawRpc(this.endpoint, this.token, method, params, { timeoutMs });
  }

  /** Opens a dedicated connection with one `subscriptions/listen` stream. */
  async listen(uris: string[], ackTimeoutMs = 10_000): Promise<Listener> {
    const session = await McpSession.connect(`${this.name}/listen`, this.endpoint, this.token);
    if (!session.modern) {
      await session.close();
      throw new Failure(`${this.name}: server negotiated ${session.protocolVersion ?? "no version"}; subscriptions/listen needs ${MCP_PROTOCOL_VERSION}`);
    }
    const listener = new Listener(session);
    session.client.setNotificationHandler("notifications/resources/updated", (n) => {
      listener.push(String(n.params.uri));
    });
    let sub: McpSubscription;
    try {
      sub = await session.client.listen({ resourceSubscriptions: uris }, { timeout: ackTimeoutMs });
    } catch (e) {
      await session.close();
      throw new Failure(`${this.name}: subscriptions/listen was not acknowledged: ${describeError(e)}`);
    }
    listener.attach(sub);
    return listener;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
}

export class Listener {
  readonly updates: { uri: string; at: number }[] = [];
  acknowledged: string[] = [];
  closedCause: "local" | "graceful" | "remote" | undefined;
  closedAt: number | undefined;
  private sub: McpSubscription | undefined;
  private waiters: (() => void)[] = [];

  constructor(private readonly session: McpSession) {}

  attach(sub: McpSubscription): void {
    this.sub = sub;
    this.acknowledged = [...(sub.honoredFilter.resourceSubscriptions ?? [])];
    void sub.closed.then((cause) => {
      this.closedCause = cause;
      this.closedAt = Date.now();
      this.wake();
    });
  }

  push(uri: string): void {
    this.updates.push({ uri, at: Date.now() });
    this.wake();
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Waits for an update (received at or after `since`) whose URI satisfies `match`. */
  async waitForUpdate(match: (uri: string) => boolean, timeoutMs: number, since = 0): Promise<{ uri: string; at: number } | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.updates.find((u) => u.at >= since && match(u.uri));
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Waits until the subscription ends; returns the cause or undefined on timeout. */
  async waitClosed(timeoutMs: number): Promise<"local" | "graceful" | "remote" | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closedCause && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.closedCause;
  }

  async close(): Promise<void> {
    await this.sub?.close().catch(() => {});
    await this.session.close();
  }
}
