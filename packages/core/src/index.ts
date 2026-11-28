/**
 * @openmessageboard/core: everything an OpenMessageBoard server does that doesn't depend on the runtime. An
 * implementation opens a SQLite database (better-sqlite3 API), runs `migrate`, supplies a `Platform`, and calls
 * `bootServer`. Deeper modules are importable as `@openmessageboard/core/<path>` (for example `domain/boards`).
 */
export { bootServer, type BootOptions, type Booted, type Features } from "./boot.js";
export { loadConfig, type Config, type Env } from "./config.js";
export { createContext, tx, read, type AppContext } from "./context.js";
export { migrate, MIGRATIONS, type DB, type Migration } from "./db/index.js";
export { NO_PLATFORM, type Platform, type CallbackTransport, type CallbackPolicy, type CallbackResponse, type SchemaEngine } from "./platform.js";
export { CallbackError, isIP, isPrivateAddress, isLoopbackAddress, validateCallbackUrl } from "./mcp/webhook-http.js";
export { createOutboxMailer, type Mail, type Mailer } from "./auth/mailer.js";
export { setAttachmentStore, type AttachmentStore } from "./domain/attachments.js";
export { WEB_CSP, isServerPath, type AppOptions } from "./http/app.js";
export type { AppEnv, AppHono, ExtensionModule, ExtensionTool, RouteModule } from "./http/util.js";
export type { WorkloadVerifier } from "./auth/resolve.js";
