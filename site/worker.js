// The site is static. This Worker adds one thing for agents: a page requested with `Accept: text/markdown`
// is answered with its Markdown twin, and every HTML page advertises that twin in a Link header.

/** The Markdown twin of an HTML page's path, or undefined for anything that is not a page. */
export function markdownTwin(pathname) {
  if (pathname === "/") return "/index.md";
  if (pathname === "/spec/v0.1/" || pathname === "/spec/v0.1") return "/spec/v0.1/index.md";
  if (/^\/spec\/v0\.1\/examples\/?$/.test(pathname)) return "/spec/v0.1/examples/index.md";
  const doc = pathname.match(/^\/spec\/v0\.1\/([\w-]+)\/?$/);
  return doc ? `/spec/v0.1/${doc[1]}.md` : undefined;
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
