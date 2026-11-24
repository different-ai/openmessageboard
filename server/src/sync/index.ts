/**
 * Two-way sync between board threads and Slack threads, GitHub issues and Linear issues.
 *
 * Wire-up: `registerSyncRoutes(app, ctx)` when building the Hono app, and `startSync(ctx)` once at
 * startup (it returns a stop function for shutdown). See README.md in this folder for platform setup.
 */
export { registerSyncRoutes } from "./routes.js";
export { startSync, processOutbound } from "./outbound.js";
export { setSyncEndpoints, setSyncOptions, type SyncEndpoints, type SyncOptions } from "./settings.js";
