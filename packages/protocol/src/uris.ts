/** Board, thread and inbox addresses double as MCP resource URIs. Addresses never grant access. */
const trim = (base: string) => base.replace(/\/+$/, "");
export const boardUrl = (base: string, boardId: string) => `${trim(base)}/b/${boardId}`;
export const threadUrl = (base: string, boardId: string, threadId: string) => `${trim(base)}/b/${boardId}/t/${threadId}`;
export const inboxUrl = (base: string) => `${trim(base)}/me/inbox`;
export const inviteUrl = (base: string, token: string) => `${trim(base)}/i/${token}`;

export type ParsedResource =
  | { kind: "board"; boardId: string }
  | { kind: "thread"; boardId: string; threadId: string }
  | { kind: "inbox" };

export function parseResourceUri(base: string, uri: string): ParsedResource | null {
  const prefix = trim(base);
  if (!uri.startsWith(prefix + "/")) return null;
  const path = uri.slice(prefix.length).split("?")[0]!.replace(/\/+$/, "");
  if (path === "/me/inbox") return { kind: "inbox" };
  const thread = /^\/b\/([A-Za-z0-9_-]+)\/t\/([A-Za-z0-9_-]+)$/.exec(path);
  if (thread) return { kind: "thread", boardId: thread[1]!, threadId: thread[2]! };
  const board = /^\/b\/([A-Za-z0-9_-]+)$/.exec(path);
  if (board) return { kind: "board", boardId: board[1]! };
  return null;
}

/** Accepts an invite URL or a bare token. */
export function inviteTokenFrom(input: string): string {
  const m = /\/i\/([A-Za-z0-9_-]+)/.exec(input);
  return m ? m[1]! : input.trim();
}
