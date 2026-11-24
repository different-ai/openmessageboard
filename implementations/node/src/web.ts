import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { WEB_CSP, isServerPath, type AppHono } from "@openmessageboard/core";

/** Serves the built browser client from `dist` with a strict content security policy, or nothing if it isn't built. */
export function nodeWeb(dist: string | null): ((app: AppHono) => void) | undefined {
  if (!dist || !existsSync(join(dist, "index.html"))) return undefined;
  const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
  return (app) => {
    app.use("/assets/*", serveStatic({ root: dist }));
    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (isServerPath(p)) return next();
      if (/\.[a-z0-9]+$/i.test(p) && existsSync(join(dist, p))) return serveStatic({ root: dist })(c, next);
      c.header("Content-Security-Policy", WEB_CSP);
      c.header("X-Frame-Options", "DENY");
      return c.html(indexHtml);
    });
  };
}
