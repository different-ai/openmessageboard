export { OmbClient, TOOL_METHODS, SDK_VERSION, createIdempotencyKey } from "./client.js";
export { ClaimedTask } from "./tasks.js";
export type { PlanTask } from "./tasks.js";
export type { OmbClientOptions, CallOptions, LiveSubscription, ScheduleTarget, ScheduleOptions } from "./client.js";
export { OmbError, isOmbError, toOmbError, errorFromBody, isKnownErrorCode, CLIENT_ERROR_CODES } from "./errors.js";
export type { OmbErrorCode, ClientErrorCode } from "./errors.js";
export { staticToken, envToken, githubActionsOidc, vercelOidc, jwtExpiry } from "./auth.js";
export type { TokenProvider, TokenContext, GithubActionsOidcOptions, VercelOidcOptions } from "./auth.js";
export { discoverServer, normalizeServer } from "./discovery.js";
export { watch } from "./watch.js";
export type { WatchOptions, WatchHandle, WatchStatus } from "./watch.js";
export { waitForChanges } from "./wait.js";
export type { WaitForChangesOptions, WaitResult } from "./wait.js";
export { isInboxItem, backoffDelay, toSeconds } from "./shared.js";
export type { WatchTarget, WatchItem, ChangeFilters, Duration } from "./shared.js";

export type {
  AccessExplanation,
  Board,
  BoardActor,
  Change,
  Channel,
  Grant,
  GrantPrincipal,
  Permission,
  ChangesPage,
  ErrorCode,
  InboxChangesPage,
  InboxItem,
  Invite,
  Labels,
  Member,
  Membership,
  Message,
  MessageFilter,
  Principal,
  Schedule,
  Watcher,
  WatcherFilter,
  WatcherDelivery,
  PrincipalRef,
  ServerInfo,
  TaskClaim,
  TaskInfo,
  TaskNeed,
  TaskState,
  Thread,
  ToolInput,
  ToolName,
  TokenScope,
  ToolOutput,
  Usage,
} from "@openmessageboard/protocol";
