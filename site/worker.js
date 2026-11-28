// The site is static. This Worker adds three things. For agents: a page requested with `Accept: text/markdown`
// is answered with its Markdown twin, and every HTML page advertises that twin in a Link header. For people:
// the newsletter signup (newsletter.js). For old links: addresses of specification version 0.1 redirect to 0.2.
import { handleNewsletter } from "./newsletter.js";

/** The Markdown twin of an HTML page's path, or undefined for anything that is not a page. */
export function markdownTwin(pathname) {
  if (pathname === "/") return "/index.md";
  if (pathname === "/spec/v0.2/" || pathname === "/spec/v0.2") return "/spec/v0.2/index.md";
  if (/^\/spec\/v0\.2\/examples\/?$/.test(pathname)) return "/spec/v0.2/examples/index.md";
  const doc = pathname.match(/^\/spec\/v0\.2\/([\w-]+)\/?$/);
  return doc ? `/spec/v0.2/${doc[1]}.md` : undefined;
}

/**
 * Version 0.1 of the specification was replaced by 0.2. An address of a 0.1 page or schema leads to the same
 * page or schema of the current version; anything else is undefined.
 */
export function movedFrom01(pathname) {
  const m = pathname.match(/^\/(spec|schemas)\/v0\.1(\/.*)?$/);
  return m ? `/${m[1]}/v0.2${m[2] ?? "/"}` : undefined;
}

/** True when the client ranks Markdown at least as high as HTML. Browsers never list text/markdown. */
export function prefersMarkdown(accept) {
  const q = (type) => {
    const part = (accept || "").split(",").find((p) => p.trim().toLowerCase().startsWith(type));
    if (!part) return -1;
    const m = part.match(/;\s*q=([0-9.]+)/);
    return m ? Number(m[1]) : 1;
  };
  const markdown = q("text/markdown");
  return markdown > 0 && markdown >= q("text/html");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const newsletter = await handleNewsletter(request, env, url);
    if (newsletter) return newsletter;
    const moved = movedFrom01(url.pathname);
    if (moved) return Response.redirect(new URL(moved + url.search, url).toString(), 301);
    const twin = request.method === "GET" || request.method === "HEAD" ? markdownTwin(url.pathname) : undefined;

    if (twin && prefersMarkdown(request.headers.get("accept"))) {
      const found = await env.ASSETS.fetch(new Request(new URL(twin, url), request));
      if (found.ok) {
        const headers = new Headers(found.headers);
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set("vary", "Accept");
        headers.set("link", `<${url.origin}${url.pathname}>; rel="canonical"`);
        return new Response(found.body, { status: found.status, headers });
      }
    }

    const response = await env.ASSETS.fetch(request);
    if (!twin || !(response.headers.get("content-type") || "").includes("text/html")) return response;
    const headers = new Headers(response.headers);
    headers.set("vary", "Accept");
    headers.append("link", `<${twin}>; rel="alternate"; type="text/markdown"`);
    headers.append("link", `</llms.txt>; rel="describedby"; type="text/plain"`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
