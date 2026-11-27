/** Content security policy for the browser client's HTML. */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Paths the server owns; everything else may be the browser client. Dependency-free, so a runtime's edge can import it cheaply. */
export function isServerPath(p: string): boolean {
  return p.startsWith("/api/") || p === "/mcp" || p.startsWith("/.well-known/") || p.startsWith("/hooks/");
}

/** Server paths outside the prefixes above. */
export const SERVER_PATHS: ReadonlySet<string> = new Set(["/healthz", "/metrics", "/oauth/oidc-client.json"]);
