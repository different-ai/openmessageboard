/** Process-wide sync settings. Tests point the platform base URLs at local fakes. */

export interface SyncEndpoints {
  /** Slack Web API base, without a trailing slash. */
  slack: string;
  /** GitHub REST API base, without a trailing slash. */
  github: string;
  /** Full Linear GraphQL endpoint. */
  linear: string;
}

export interface SyncOptions {
  /** How often the outbound worker looks for due deliveries. */
  intervalMs: number;
  /** First retry delay; each later retry doubles it. */
  retryBaseMs: number;
  /** Attempts per outbound message before it is marked failed. */
  maxAttempts: number;
  /** Timeout for sends and link creation. */
  requestTimeoutMs: number;
  /** Timeout for lookups made while answering a webhook (user names, identity), which must reply quickly. */
  lookupTimeoutMs: number;
}

const DEFAULT_ENDPOINTS: SyncEndpoints = {
  slack: "https://slack.com/api",
  github: "https://api.github.com",
  linear: "https://api.linear.app/graphql",
};

const DEFAULT_OPTIONS: SyncOptions = {
  intervalMs: 1000,
  retryBaseMs: 5000,
  maxAttempts: 5,
  requestTimeoutMs: 10_000,
  lookupTimeoutMs: 1500,
};

let endpoints: SyncEndpoints = { ...DEFAULT_ENDPOINTS };
let options: SyncOptions = { ...DEFAULT_OPTIONS };

const trim = (url: string) => url.replace(/\/+$/, "");

/** Overrides platform API base URLs. Pass `null` to restore the defaults. */
export function setSyncEndpoints(next: Partial<SyncEndpoints> | null): void {
  if (next === null) {
    endpoints = { ...DEFAULT_ENDPOINTS };
    return;
  }
  endpoints = {
    slack: trim(next.slack ?? endpoints.slack),
    github: trim(next.github ?? endpoints.github),
    linear: trim(next.linear ?? endpoints.linear),
  };
}

/** Overrides worker timing. Pass `null` to restore the defaults. */
export function setSyncOptions(next: Partial<SyncOptions> | null): void {
  options = next === null ? { ...DEFAULT_OPTIONS } : { ...options, ...next };
}

export const syncEndpoints = (): SyncEndpoints => endpoints;
export const syncOptions = (): SyncOptions => options;
