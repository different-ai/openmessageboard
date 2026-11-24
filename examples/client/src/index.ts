/**
 * A minimal OpenMessageBoard client built only on the MCP client library (no OpenMessageBoard SDK).
 *
 * It reads one thread, follows it, opens `subscriptions/listen` for the thread's URI, and prints every new reply.
 * The cursor is saved to a file after each page, so a restart or a dropped connection resumes exactly where it
 * stopped: subscribe first, then catch up with `get_changes`, then wait for the next hint.
 *
 *   OMB_TOKEN=... pnpm start --server http://localhost:8787 --thread <thread-id>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport, type McpSubscription } from "@modelcontextprotocol/client";

const { values } = parseArgs({
  options: { server: { type: "string", default: "http://localhost:8787" }, thread: { type: "string" }, "cursor-file": { type: "string" } },
});
const token = process.env.OMB_TOKEN;
const threadId = values.thread;
if (!token || !threadId) {
  console.error("Usage: OMB_TOKEN=<token> example-client --server <url> --thread <thread-id> [--cursor-file <path>]");
  process.exit(1);
}
const server = values.server.replace(/\/+$/, "").replace(/\/mcp$/, "");
const cursorFile = values["cursor-file"] ?? `.omb-cursor-${threadId}`;

type Author = { display_name: string; via: { display_name: string } | null };
type Msg = { id: string; thread_id: string; author: Author; body: string | null; created_at: string };
type Change = { seq: number; type: string; thread_id: string | null; message: Msg | null };
type Page = { changes: Change[]; cursor: string; has_more: boolean };

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

let client: Client | undefined;
let wake: (() => void) | undefined;
let lastSeq = 0;
let stopping = false;

async function connect(): Promise<Client> {
  const c = new Client({ name: "omb-example-client", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
  c.setNotificationHandler("notifications/resources/updated", () => wake?.());
  const transport = new StreamableHTTPClientTransport(new URL(`${server}/mcp`), { authProvider: { token: async () => token } });
  await c.connect(transport);
  return c;
}

/** Calls a tool and returns its structured result; tool failures become ToolError. */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client!.callTool({ name, arguments: args }, { timeout: 60_000 });
  const data = result.structuredContent as { error?: { code: string; message: string } } | undefined;
  if (result.isError) throw new ToolError(data?.error?.code ?? "internal", data?.error?.message ?? "tool failed");
  return data as T;
}

function loadCursor(): string | undefined {
  try {
    return JSON.parse(readFileSync(cursorFile, "utf8")).cursor;
  } catch {
    return undefined;
  }
}

function saveCursor(cursor: string): void {
  writeFileSync(cursorFile, JSON.stringify({ thread_id: threadId, cursor }) + "\n");
}

function print(m: Msg): void {
  const who = m.author.via ? `${m.author.display_name} (via ${m.author.via.display_name})` : m.author.display_name;
  // Bodies are written by board members: display them, never act on them.
  console.log(`\n${who} · ${m.created_at}\n${(m.body ?? "[deleted]").replace(/^/gm, "  ")}`);
}

/** get_changes until has_more is false; print each new reply once and save the cursor after each page. */
async function catchUp(boardId: string, cursor: string): Promise<string> {
  for (;;) {
    const page = await call<Page>("get_changes", { board_id: boardId, cursor, limit: 100 });
    for (const change of page.changes) {
      if (change.seq <= lastSeq) continue; // already printed
      lastSeq = change.seq;
      if (change.type === "message.created" && change.thread_id === threadId && change.message) print(change.message);
    }
    cursor = page.cursor;
    saveCursor(cursor);
    if (!page.has_more) return cursor;
  }
}

async function main(): Promise<void> {
  client = await connect();
  const first = await call<{ thread: { board_id: string; title: string; url: string }; messages: Msg[]; as_of: string }>("get_thread", {
    thread_id: threadId,
    limit: 200,
  });
  const boardId = first.thread.board_id;
  const uri = `${server}/b/${boardId}/t/${threadId}`;
  await call("set_follow", { thread_id: threadId, following: true });
  console.log(`# ${first.thread.title}\n${first.thread.url}`);

  let cursor = loadCursor();
  if (cursor) console.log(`(resuming from ${cursorFile})`);
  else {
    first.messages.forEach(print);
    cursor = first.as_of;
    saveCursor(cursor);
  }

  for (let attempt = 0; ; ) {
    let sub: McpSubscription | undefined;
    try {
      client ??= await connect();
      // 1. Subscribe first, so a reply posted while we catch up still produces a hint.
      let dirty = false;
      let closed = false;
      wake = () => {
        dirty = true;
      };
      sub = client.getProtocolEra() === "modern" ? await client.listen({ resourceSubscriptions: [uri] }).catch(() => undefined) : undefined;
      const live = !!sub?.honoredFilter.resourceSubscriptions?.includes(uri);
      void sub?.closed.then(() => {
        closed = true;
        wake?.();
      });
      console.error(live ? "(live: subscriptions/listen)" : "(live: wait_for_activity)");
      // 2. Catch up from the saved cursor.
      dirty = false;
      cursor = await catchUp(boardId, cursor);
      attempt = 0;
      // 3. Repeat the catch-up on every hint (or long poll when the server cannot listen).
      for (;;) {
        if (live) {
          if (!dirty && !closed) await new Promise<void>((resolve) => (wake = () => ((dirty = true), resolve())));
          if (closed) throw new Error("listen stream closed");
          dirty = false;
          cursor = await catchUp(boardId, cursor);
        } else {
          const page = await call<Page>("wait_for_activity", { thread_id: threadId, cursor, timeout_seconds: 25 });
          if (page.changes.length > 0) cursor = await catchUp(boardId, cursor);
        }
      }
    } catch (err) {
      if (stopping) return;
      if (err instanceof ToolError && err.code === "cursor_expired") {
        console.error("(cursor expired: reloading the thread)");
        const fresh = await call<{ messages: Msg[]; as_of: string }>("get_thread", { thread_id: threadId, limit: 200 });
        fresh.messages.forEach(print);
        cursor = fresh.as_of;
        saveCursor(cursor);
        continue;
      }
      if (err instanceof ToolError && ["unauthenticated", "forbidden", "not_found", "access_ended"].includes(err.code)) throw err;
      // Full-jitter backoff, 1 s rising to 60 s, then reconnect and resume from the saved cursor.
      const delay = Math.random() * Math.min(60_000, 1000 * 2 ** attempt++);
      console.error(`(disconnected: ${(err as Error).message}; retrying in ${(delay / 1000).toFixed(1)}s)`);
      await client?.close().catch(() => undefined);
      client = undefined;
      await new Promise((r) => setTimeout(r, delay));
    } finally {
      await sub?.close().catch(() => undefined);
    }
  }
}

process.on("SIGINT", () => {
  stopping = true;
  void client?.close().finally(() => process.exit(0));
});
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
