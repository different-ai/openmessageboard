import type {
  AccessExplanation,
  AddAgentToBoardBody,
  Agent,
  Board,
  BoardActor,
  Channel,
  CreateGrantBody,
  Grant,
  UpdateGrantBody,
  ClaimTaskBody,
  CreateIntegrationBody,
  CreateTasksBody,
  CreateInviteBody,
  CreateWorkloadTrustBody,
  CreateWatcherBody,
  CreatedToken,
  CreateTokenBody,
  EditMessageBody,
  ErrorCode,
  ExternalLink,
  Integration,
  Invite,
  InvitePreview,
  LabelMessageBody,
  LabelsBody,
  LinkThreadBody,
  MarkReadBody,
  Member,
  OAuthConsentBody,
  OAuthConsentInfo,
  PersonalToken,
  Principal,
  ReactBody,
  RenewTaskBody,
  ReplyBody,
  ScheduleBody,
  ServerInfo,
  StartThreadBody,
  TaskStateFilter,
  ToolOutput,
  UpdateBoardBody,
  UpdateMemberBody,
  UpdateTaskBody,
  Usage,
  WorkloadTrust,
} from "@openmessageboard/protocol";

/** Output type of a protocol schema, without importing zod at runtime. */
type Out<T> = T extends { _output: infer O } ? O : never;

export type StartThreadInput = Out<typeof StartThreadBody>;
export type ReplyInput = Out<typeof ReplyBody>;
export type LabelsInput = Out<typeof LabelsBody>;
export type EditMessageInput = Out<typeof EditMessageBody>;
export type ReactInput = Out<typeof ReactBody>;
export type LabelMessageInput = Out<typeof LabelMessageBody>;
export type UpdateTaskInput = Out<typeof UpdateTaskBody>;
export type ClaimTaskInput = Out<typeof ClaimTaskBody>;
export type RenewTaskInput = Out<typeof RenewTaskBody>;
export type CreateTasksInput = Out<typeof CreateTasksBody>;
export type MarkReadInput = Out<typeof MarkReadBody>;
export type UpdateBoardInput = Out<typeof UpdateBoardBody>;
export type UpdateMemberInput = Out<typeof UpdateMemberBody>;
export type CreateInviteInput = Out<typeof CreateInviteBody>;
export type AddAgentToBoardInput = Out<typeof AddAgentToBoardBody>;
export type CreateIntegrationInput = Out<typeof CreateIntegrationBody>;
export type LinkThreadInput = Out<typeof LinkThreadBody>;
export type CreateWorkloadTrustInput = Out<typeof CreateWorkloadTrustBody>;
export type ConsentInfo = Out<typeof OAuthConsentInfo>;
export type ConsentInput = Out<typeof OAuthConsentBody>;
export type ScheduleInput = Out<typeof ScheduleBody>;
export type CreateWatcherInput = Out<typeof CreateWatcherBody>;
export type MessageQuery = {
  channel?: string;
  by?: string;
  mentions?: string;
  labels?: Record<string, string>;
  text?: string;
  source?: string;
  re?: string;
  after?: string;
  before?: string;
  limit?: number;
};
export type CreateGrantInput = Out<typeof CreateGrantBody>;
export type UpdateGrantInput = Out<typeof UpdateGrantBody>;

export type Whoami = ToolOutput<"whoami">;
export type ThreadList = ToolOutput<"list_threads">;
export type ThreadPage = ToolOutput<"get_thread">;
export type InboxPage = ToolOutput<"get_inbox">;
export type { PersonalToken };
export type CreateTokenInput = Out<typeof CreateTokenBody>;

export type ClientErrorCode = ErrorCode | "network" | "http_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: ClientErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown, ...codes: ClientErrorCode[]): e is ApiError {
  return e instanceof ApiError && (codes.length === 0 || codes.includes(e.code));
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: "invalid_argument",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "cursor_expired",
  413: "message_too_large",
  429: "rate_limited",
};

function toApiError(status: number, data: unknown): ApiError {
  const body = (data ?? {}) as Record<string, unknown>;
  const err = body.error as Record<string, unknown> | undefined;
  if (err && typeof err === "object" && typeof err.code === "string") {
    return new ApiError(
      status,
      err.code as ErrorCode,
      typeof err.message === "string" ? err.message : "Something went wrong.",
      (err.details as Record<string, unknown>) ?? {},
    );
  }
  // Better Auth endpoints answer with { code, message }.
  const fallback = STATUS_CODES[status] ?? (status >= 500 ? "internal" : "http_error");
  const message =
    typeof body.message === "string" && body.message
      ? body.message
      : status >= 500
        ? "The server had a problem. Try again in a moment."
        : `Request failed (${status}).`;
  return new ApiError(status, fallback, message, typeof body.code === "string" ? { code: body.code } : {});
}

type Query = Record<string, string | number | boolean | string[] | null | undefined>;

export function qs(query: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => p.append(k, item));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

/** Sends JSON, or a FormData body as multipart (the browser sets its Content-Type and boundary). */
async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw toApiError(res.status, data);
  return data as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const del = <T = unknown>(path: string, body?: unknown) => request<T>("DELETE", path, body);

/** Board routes are documented as returning `{ board }`; accept a bare Board too. */
function unwrapBoard(res: { board: Board } | Board): Board {
  return "board" in res && typeof res.board === "object" ? res.board : (res as Board);
}

export type ThreadQuery = {
  channel?: string;
  filter?: "all" | "following" | "unread";
  kind?: "discussion" | "task";
  task_state?: TaskStateFilter;
  assignee?: string;
  for?: string;
  labels?: Record<string, string>;
  page_cursor?: string;
  limit?: number;
};

/** Labels travel as repeated `label=key=value` query parameters. */
function labelParams(labels?: Record<string, string>): string[] | undefined {
  if (!labels) return undefined;
  const list = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  return list.length ? list : undefined;
}

/** The extension that gives boards short names (`<server>/<name>`). */
export const NAMES_EXTENSION = "openmessageboard.cloudflare/names";
export interface BoardNameState {
  name: string | null;
  address: string | null;
  /** The owner also sees when the name is released, and earlier names. */
  releases_at?: string | null;
  held?: { name: string; until: string }[];
  released?: { name: string; until: string }[];
}

/** The extension that lets people who sign in choose the newsletter. Servers without it never show the choice. */
export const NEWSLETTER_EXTENSION = "openmessageboard.cloudflare/newsletter";
let serverInfoCache: Promise<ServerInfo> | null = null;

export const api = {
  // Session and identity
  session: () => get<{ principal: Principal | null }>("/api/session"),
  me: () => get<Whoami>("/api/me"),
  sendSignInCode: (email: string) =>
    post<unknown>("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  signIn: (email: string, otp: string) => post<unknown>("/api/auth/sign-in/email-otp", { email, otp }),
  signOut: () => post<unknown>("/api/auth/sign-out", {}),
  serverInfo: () => (serverInfoCache ??= get<ServerInfo>("/.well-known/openmessageboard").catch((e) => ((serverInfoCache = null), Promise.reject(e)))),
  /** The names extension (only on servers that list it). */
  hasExtension: (id: string) => api.serverInfo().then((s) => !!s.extensions?.[id]).catch(() => false),
  resolveBoardName: (name: string) => get<{ board_id: string }>(`/x/names/resolve/${encodeURIComponent(name)}`),
  boardName: (boardId: string) => get<BoardNameState>(`/x/names/boards/${boardId}`),
  claimBoardName: (boardId: string, name: string) => put<BoardNameState>(`/x/names/boards/${boardId}`, { name }),
  releaseBoardName: (boardId: string) => del<BoardNameState>(`/x/names/boards/${boardId}`),
  keepBoardName: (boardId: string) => post<BoardNameState>(`/x/names/boards/${boardId}/keep`),
  /** The newsletter extension (only on servers that list it): the signed-in person's choice. */
  newsletter: () => get<{ subscribed: boolean }>("/x/newsletter/me"),
  setNewsletter: (subscribed: boolean) => request<{ subscribed: boolean }>("PUT", "/x/newsletter/me", { subscribed }),
  /** Starts sign-in with the server's OpenID Connect provider; returns the authorization URL to open. */
  signInWithProvider: (callbackURL: string) => post<{ url: string }>("/api/auth/sign-in/social", { provider: "oidc", callbackURL }),

  // Boards
  createBoard: async (name?: string) => unwrapBoard(await post<{ board: Board }>("/api/boards", name ? { name } : {})),
  board: async (boardId: string, signal?: AbortSignal) =>
    unwrapBoard(await get<{ board: Board }>(`/api/boards/${enc(boardId)}`, signal)),
  updateBoard: async (boardId: string, body: UpdateBoardInput) =>
    unwrapBoard(await patch<{ board: Board }>(`/api/boards/${enc(boardId)}`, body)),
  deleteBoard: (boardId: string, confirm_name: string) => del(`/api/boards/${enc(boardId)}`, { confirm_name }),
  usage: (boardId: string) => get<Usage>(`/api/boards/${enc(boardId)}/usage`),
  exportUrl: (boardId: string) => `/api/boards/${enc(boardId)}/export`,
  importBoard: async (file: unknown) => unwrapBoard(await post<{ board: Board }>("/api/import", file)),

  // Threads and messages
  threads: (boardId: string, q: ThreadQuery = {}, signal?: AbortSignal) =>
    get<ThreadList>(
      `/api/boards/${enc(boardId)}/threads${qs({
        channel: q.channel,
        filter: q.filter && q.filter !== "all" ? q.filter : undefined,
        kind: q.kind,
        task_state: q.task_state,
        assignee: q.assignee,
        for: q.for,
        label: labelParams(q.labels),
        page_cursor: q.page_cursor,
        limit: q.limit,
      })}`,
      signal,
    ),
  startThread: (boardId: string, body: StartThreadInput) =>
    post<ToolOutput<"start_thread">>(`/api/boards/${enc(boardId)}/threads`, body),
  thread: (threadId: string, page_cursor?: string, signal?: AbortSignal) =>
    get<ThreadPage>(`/api/threads/${enc(threadId)}${qs({ page_cursor, limit: 200 })}`, signal),
  reply: (threadId: string, body: ReplyInput) => post<ToolOutput<"reply">>(`/api/threads/${enc(threadId)}/messages`, body),
  deleteMessage: (messageId: string) => del<ToolOutput<"delete_message">>(`/api/messages/${enc(messageId)}`),
  /** Pass the revision you loaded; a newer one on the server fails with `revision_conflict`. */
  editMessage: (messageId: string, body: EditMessageInput) =>
    patch<ToolOutput<"edit_message">>(`/api/messages/${enc(messageId)}`, body),
  react: (messageId: string, body: ReactInput) => post<ToolOutput<"react">>(`/api/messages/${enc(messageId)}/reactions`, body),
  labelMessage: (messageId: string, body: LabelMessageInput) =>
    post<ToolOutput<"label_message">>(`/api/messages/${enc(messageId)}/labels`, body),
  uploadAttachment: (boardId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return post<ToolOutput<"upload_attachment">>(`/api/boards/${enc(boardId)}/attachments`, form);
  },
  /** Always downloads (the server sends `Content-Disposition: attachment`). */
  attachmentUrl: (attachmentId: string) => `/api/attachments/${enc(attachmentId)}`,
  follow: (threadId: string, following: boolean) =>
    put<ToolOutput<"set_follow">>(`/api/threads/${enc(threadId)}/follow`, { following }),
  setLabels: (threadId: string, body: LabelsInput) =>
    post<ToolOutput<"set_labels">>(`/api/threads/${enc(threadId)}/labels`, body),
  search: (boardId: string, query: string) =>
    get<ToolOutput<"search_messages">>(`/api/boards/${enc(boardId)}/search${qs({ query })}`),

  messages: (boardId: string, q: MessageQuery = {}, signal?: AbortSignal) =>
    get<ToolOutput<"read_messages">>(
      `/api/boards/${enc(boardId)}/messages${qs({
        channel: q.channel,
        by: q.by,
        mentions: q.mentions,
        label: labelParams(q.labels),
        text: q.text,
        source: q.source,
        re: q.re,
        after: q.after,
        before: q.before,
        limit: q.limit,
      })}`,
      signal,
    ),

  // Scheduled posts and watchers
  threadSchedules: (threadId: string, all = false, signal?: AbortSignal) =>
    get<ToolOutput<"list_schedules">>(`/api/threads/${enc(threadId)}/schedules${qs({ all: all || undefined })}`, signal),
  boardSchedules: (boardId: string, all = false, signal?: AbortSignal) =>
    get<ToolOutput<"list_schedules">>(`/api/boards/${enc(boardId)}/schedules${qs({ all: all || undefined })}`, signal),
  scheduleReply: (threadId: string, body: ScheduleInput) => post<ToolOutput<"schedule_post">>(`/api/threads/${enc(threadId)}/schedules`, body),
  scheduleThread: (boardId: string, body: ScheduleInput) => post<ToolOutput<"schedule_post">>(`/api/boards/${enc(boardId)}/schedules`, body),
  cancelSchedule: (scheduleId: string) => del<ToolOutput<"cancel_schedule">>(`/api/schedules/${enc(scheduleId)}`),
  watchers: (boardId: string, signal?: AbortSignal) => get<ToolOutput<"list_watchers">>(`/api/boards/${enc(boardId)}/watchers`, signal),
  createWatcher: (boardId: string, body: CreateWatcherInput) => post<ToolOutput<"create_watcher">>(`/api/boards/${enc(boardId)}/watchers`, body),
  deleteWatcher: (watcherId: string) => del<ToolOutput<"delete_watcher">>(`/api/watchers/${enc(watcherId)}`),
  // Channels and access
  channels: (boardId: string, signal?: AbortSignal) => get<{ channels: Channel[] }>(`/api/boards/${enc(boardId)}/channels`, signal),
  createChannel: (boardId: string, body: { path: string; private?: boolean }) =>
    post<{ channel: Channel; created: boolean; grants: Grant[] }>(`/api/boards/${enc(boardId)}/channels`, body),
  grants: (boardId: string, signal?: AbortSignal) => get<{ grants: Grant[] }>(`/api/boards/${enc(boardId)}/grants`, signal),
  createGrant: (boardId: string, body: CreateGrantInput) => post<{ grant: Grant }>(`/api/boards/${enc(boardId)}/grants`, body),
  updateGrant: (grantId: string, body: UpdateGrantInput) => patch<{ grant: Grant }>(`/api/grants/${enc(grantId)}`, body),
  revokeGrant: (grantId: string) => del<{ grant_id: string; revoked: boolean }>(`/api/grants/${enc(grantId)}`),
  explainAccess: (boardId: string, channel: string, principalId?: string) =>
    get<AccessExplanation>(`/api/boards/${enc(boardId)}/access${qs({ channel, principal_id: principalId })}`),

  // Tasks
  updateTask: (threadId: string, body: UpdateTaskInput) =>
    post<ToolOutput<"update_task">>(`/api/threads/${enc(threadId)}/task`, body),
  claimTask: (boardId: string, body: ClaimTaskInput) =>
    post<ToolOutput<"claim_task">>(`/api/boards/${enc(boardId)}/tasks/claim`, body),
  renewTask: (threadId: string, body: RenewTaskInput) =>
    post<ToolOutput<"renew_task">>(`/api/threads/${enc(threadId)}/task/renew`, body),
  createTasks: (boardId: string, body: CreateTasksInput) =>
    post<ToolOutput<"create_tasks">>(`/api/boards/${enc(boardId)}/tasks`, body),

  // Inbox
  inbox: (q: { unread_only?: boolean; board_id?: string; page_cursor?: string; limit?: number } = {}) =>
    get<InboxPage>(`/api/inbox${qs(q)}`),
  markRead: (body: MarkReadInput) => post<ToolOutput<"mark_read">>("/api/inbox/read", body),

  // Members and invites
  members: (boardId: string) => get<{ members: Member[] }>(`/api/boards/${enc(boardId)}/members`),
  actors: (boardId: string) => get<{ actors: BoardActor[] }>(`/api/boards/${enc(boardId)}/actors`),
  updateMember: (boardId: string, principalId: string, body: UpdateMemberInput) =>
    patch<{ member: Member }>(`/api/boards/${enc(boardId)}/members/${enc(principalId)}`, body),
  removeMember: (boardId: string, principalId: string) => del(`/api/boards/${enc(boardId)}/members/${enc(principalId)}`),
  invites: (boardId: string) => get<{ invites: Invite[] }>(`/api/boards/${enc(boardId)}/invites`),
  createInvite: (boardId: string, body: CreateInviteInput) =>
    post<{ invite: Invite }>(`/api/boards/${enc(boardId)}/invites`, body),
  disableInvite: (inviteId: string) => del(`/api/invites/${enc(inviteId)}`),
  invitePreview: (token: string) => get<InvitePreview>(`/api/invite-links/${enc(token)}`),
  redeemInvite: async (token: string) => unwrapBoard(await post<{ board: Board }>(`/api/invite-links/${enc(token)}/redeem`, {})),

  // Agents and tokens
  agents: () => get<{ agents: Agent[] }>("/api/agents"),
  createAgent: (display_name: string) => post<{ agent: Agent }>("/api/agents", { display_name }),
  disableAgent: (agentId: string) => del(`/api/agents/${enc(agentId)}`),
  createAgentToken: (agentId: string, body: CreateTokenInput = {}) => post<CreatedToken>(`/api/agents/${enc(agentId)}/tokens`, body),
  revokeAgentToken: (agentId: string, tokenId: string) => del(`/api/agents/${enc(agentId)}/tokens/${enc(tokenId)}`),
  addAgentToBoard: (boardId: string, body: AddAgentToBoardInput) =>
    post<unknown>(`/api/boards/${enc(boardId)}/agents`, body),
  tokens: () => get<{ tokens: PersonalToken[] }>("/api/tokens"),
  createToken: (body: CreateTokenInput = {}) => post<CreatedToken>("/api/tokens", body),
  revokeToken: (tokenId: string) => del(`/api/tokens/${enc(tokenId)}`),

  // Sync integrations
  integrations: (boardId: string) => get<{ integrations: Integration[] }>(`/api/boards/${enc(boardId)}/integrations`),
  createIntegration: (boardId: string, body: CreateIntegrationInput) =>
    post<{ integration: Integration }>(`/api/boards/${enc(boardId)}/integrations`, body),
  deleteIntegration: (integrationId: string) => del(`/api/integrations/${enc(integrationId)}`),
  linkThread: (threadId: string, body: LinkThreadInput) =>
    post<{ link: ExternalLink }>(`/api/threads/${enc(threadId)}/links`, body),
  unlinkThread: (linkId: string) => del(`/api/links/${enc(linkId)}`),

  // Workload identity
  workloadTrusts: (boardId: string) => get<{ trusts: WorkloadTrust[] }>(`/api/boards/${enc(boardId)}/workload-trusts`),
  createWorkloadTrust: (boardId: string, body: CreateWorkloadTrustInput) =>
    post<{ trust: WorkloadTrust }>(`/api/boards/${enc(boardId)}/workload-trusts`, body),
  deleteWorkloadTrust: (trustId: string) => del(`/api/workload-trusts/${enc(trustId)}`),

  // MCP client consent
  consentInfo: (rawQuery: string) => get<ConsentInfo>(`/api/oauth/consent${rawQuery ? `?${rawQuery}` : ""}`),
  consent: (body: ConsentInput) => post<{ redirect_url: string }>("/api/oauth/consent", body),
};

export const streamUrls = {
  board: (boardId: string) => `/api/boards/${enc(boardId)}/stream`,
  inbox: () => "/api/inbox/stream",
};
