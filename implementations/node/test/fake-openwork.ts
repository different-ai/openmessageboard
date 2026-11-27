import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface FakeOpenWork {
  issuer: string;
  registrations: number;
  close(): Promise<void>;
}

/** A tiny OpenID provider standing in for OpenWork Cloud in tests (discovery, registration, PKCE code flow, userinfo). */
export async function startFakeOpenWork(user = { sub: "ow-user-1", email: "grace@example.test", name: "Grace", email_verified: true }): Promise<FakeOpenWork> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string; nonce: string | null }>();
  const tokens = new Set<string>();
  const state = { registrations: 0 };
  let issuer = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const path = url.pathname.replace(/^\/api\/auth/, "");
      if (process.env.FAKE_OPENWORK_DEBUG) console.error("[fake-openwork]", req.method, path, raw.slice(0, 300), JSON.stringify(req.headers.authorization ?? ""));
      if (path === "/.well-known/openid-configuration") {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          userinfo_endpoint: `${issuer}/oauth2/userinfo`,
          registration_endpoint: `${issuer}/oauth2/register`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["EdDSA"],
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["openid", "profile", "email"],
          client_id_metadata_document_supported: true,
        });
      }
      if (path === "/jwks") return send(200, { keys: [jwk] });
      if (path === "/oauth2/register" && req.method === "POST") {
        state.registrations++;
        return send(201, { client_id: "omb-dev-" + randomBytes(4).toString("hex"), ...JSON.parse(raw || "{}") });
      }
      if (path === "/oauth2/authorize") {
        const code = randomBytes(12).toString("hex");
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect, clientId: url.searchParams.get("client_id") ?? "", nonce: url.searchParams.get("nonce") });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.href }).end();
        return;
      }
      if (path === "/oauth2/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        const entry = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!entry || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge || form.get("redirect_uri") !== entry.redirect) {
          return send(400, { error: "invalid_grant" });
        }
        codes.delete(form.get("code")!);
        const token = randomBytes(16).toString("hex");
        tokens.add(token);
        void new SignJWT({ email: user.email, email_verified: user.email_verified, name: user.name, ...(entry.nonce ? { nonce: entry.nonce } : {}) })
          .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
          .setIssuer(issuer)
          .setAudience(entry.clientId)
          .setSubject(user.sub)
          .setIssuedAt()
          .setExpirationTime("10m")
          .sign(privateKey)
          .then((idToken) => send(200, { access_token: token, token_type: "Bearer", expires_in: 3600, scope: "openid profile email", id_token: idToken }));
        return;
      }
      if (path === "/oauth2/userinfo") {
        const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!tokens.has(auth)) return send(401, { error: "invalid_token" });
        return send(200, user);
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/auth`;
  return {
    issuer,
    get registrations() {
      return state.registrations;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
