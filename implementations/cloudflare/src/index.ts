import { SERVER_PATHS, WEB_CSP, isServerPath } from "@openmessageboard/core/http/paths";
import type { Env } from "./env.js";

export { BoardServer } from "./server.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!env.ASSETS || isServerPath(pathname) || SERVER_PATHS.has(pathname) || pathname.startsWith("/x/")) {
      return env.BOARD.get(env.BOARD.idFromName("main")).fetch(request);
    }
    // The browser client: static files, and index.html for app routes, with the same security headers as Node.
    const res = await env.ASSETS.fetch(request);
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", WEB_CSP);
    headers.set("X-Frame-Options", "DENY");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
