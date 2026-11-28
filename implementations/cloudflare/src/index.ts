import { SERVER_PATHS, WEB_CSP, isServerPath } from "@openmessageboard/core/http/paths";
import { doorwayEnabled, doorwayRoute, doorwayTarget } from "./doorway.js";
import { stringVars, type Env } from "./env.js";

export { BoardServer } from "./server.js";
export { BoardLifecycle } from "./lifecycle-object.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    // The doorway extension: board and invite addresses get a "connect your agent" page from the server.
    if ((request.method === "GET" || request.method === "HEAD") && doorwayEnabled(stringVars(env))) {
      const target = doorwayTarget(pathname, url.search);
      if (target) return env.BOARD.get(env.BOARD.idFromName("main")).fetch(new Request(new URL(doorwayRoute(target), url), request));
    }
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
