/**
 * Raw HTTP helpers. The runner uses the MCP SDK for tools and listen, and these
 * helpers where the exact wire matters: discovery, 401 behaviour, capability
 * shapes the SDK does not model (top-level `events`), resources (so the SDK's
 * response cache cannot hide a server change) and the Events methods.
 */
import { MCP_PROTOCOL_VERSION, EVENTS_EXTENSION_ID } from "@openmessageboard/protocol";
import { parseSse } from "./util.ts";

export const CLIENT_INFO = { name: "omb-conformance", version: "0.1.0" };

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export async function httpRequest(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<HttpResult> {
  const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcOutcome {
  status: number;
  result?: Record<string, unknown>;
  error?: RpcError;
  /** Notifications that arrived on the response stream before the response. */
  notifications: Record<string, unknown>[];
  raw: string;
}

let nextId = 1;

/** Sends one JSON-RPC request with the 2026-07-28 per-request `_meta` envelope. */
export async function rawRpc(
  endpoint: string,
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  opts: { timeoutMs?: number; legacy?: boolean } = {},
): Promise<RpcOutcome> {
  const id = `conf-${nextId++}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
  };
  if (!opts.legacy) headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
  const name = typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : undefined;
  if (name && !opts.legacy) headers["mcp-name"] = name;
  if (token) headers.authorization = `Bearer ${token}`;
  const body = opts.legacy
    ? { jsonrpc: "2.0", id, method, params }
    : {
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENTS_EXTENSION_ID]: {} } },
          },
        },
      };
  const res = await httpRequest(endpoint, { method: "POST", headers, body: JSON.stringify(body) }, opts.timeoutMs ?? 30_000);
  const messages: Record<string, unknown>[] = [];
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const data of parseSse(res.text)) {
      try {
        messages.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* ignore non-JSON frames */
      }
    }
  } else if (res.json && typeof res.json === "object") {
    if (Array.isArray(res.json)) messages.push(...(res.json as Record<string, unknown>[]));
    else messages.push(res.json as Record<string, unknown>);
  }
  const response = messages.find((m) => m.id === id);
  const notifications = messages.filter((m) => m.id === undefined && typeof m.method === "string");
  return {
    status: res.status,
    result: response?.result as Record<string, unknown> | undefined,
    error: response?.error as RpcError | undefined,
    notifications,
    raw: res.text,
  };
}

/** OpenMessageBoard error code carried in a JSON-RPC error's `data`. */
export function rpcErrorCode(e: RpcError | undefined): string | undefined {
  const data = e?.data as { code?: unknown } | undefined;
  return typeof data?.code === "string" ? data.code : undefined;
}
