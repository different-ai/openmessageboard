/** Board, thread and inbox addresses double as MCP resource URIs. Addresses never grant access. */
/** Removes trailing slashes in linear time (a `/\/+$/` regex is quadratic on long runs of slashes). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return end === s.length ? s : s.slice(0, end);
}
const trim = trimTrailingSlashes;
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
  const path = trimTrailingSlashes(uri.slice(prefix.length).split("?")[0]!);
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
