/**
 * `pnpm bench`: what the key binding costs per request. Sends the same MCP request N times straight to the
 * reference server with a bearer token, and N times through the gateway with a delegated token and a fresh
 * proof. The gateway figure includes an extra HTTP hop that a server implementing the proposal would not have,
 * so the last two lines (making and checking one proof) are the cost to expect in-server.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { EmbeddedJWK, jwtVerify } from "jose";
import { loadConfig } from "@openmessageboard/server-node/src/config.ts";
import { startServer } from "@openmessageboard/server-node/src/main.ts";
import { ensureHuman, mintToken } from "@openmessageboard/core/domain/boards";
import { dpopProof, exchange, newAgentKey } from "../src/agent.ts";
import { createGateway } from "../src/gateway.ts";

const N = Number(process.env.N ?? 300);
const [boardPort, gwPort] = [18787, 18799];
const config = loadConfig({ OMB_DATA_DIR: mkdtempSync(join(tmpdir(), "omb-bench-")), OMB_PORT: String(boardPort), OMB_HOST: "127.0.0.1", OMB_TEST_MODE: "1", OMB_AUTH_PROVIDERS: "email", OMB_PUBLIC_URL: `http://127.0.0.1:${boardPort}` });
const board = await startServer(config, { features: {} });
const person = mintToken(board.ctx, ensureHuman(board.ctx, { email: "maya@example.test", displayName: "Maya" }).id, "test").token;
const gw = `http://127.0.0.1:${gwPort}`;
const gateway = await createGateway({ upstream: config.publicUrl, publicUrl: gw });
const server = serve({ fetch: gateway.fetch, port: gwPort, hostname: "127.0.0.1" });
const key = await newAgentKey();
const { access_token: token } = await exchange(`${gw}/token`, { personToken: person, actor: key, name: "bench", access: { actions: ["read"] } });

const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function time(fn: () => Promise<unknown>, n = N): Promise<{ p50: number; p95: number }> {
  const ms: number[] = [];
  for (let i = 0; i < n + 20; i++) {
    const t = performance.now();
    await fn();
    if (i >= 20) ms.push(performance.now() - t); // the first 20 warm up
  }
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.floor(n * 0.5)]!, p95: ms[Math.floor(n * 0.95)]! };
}
const ok = async (res: Response) => {
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  await res.arrayBuffer();
};

const direct = await time(async () => ok(await fetch(`${config.publicUrl}/mcp`, { method: "POST", headers: { ...base, authorization: `Bearer ${person}` }, body })));
const viaGateway = await time(async () => ok(await fetch(`${gw}/mcp`, { method: "POST", headers: { ...base, authorization: `DPoP ${token}`, dpop: await dpopProof(key, { method: "POST", url: `${gw}/mcp`, accessToken: token }) }, body })));
const sign = await time(() => dpopProof(key, { method: "POST", url: `${gw}/mcp`, accessToken: token }));
const proof = await dpopProof(key, { method: "POST", url: `${gw}/mcp`, accessToken: token });
const verify = await time(() => jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ["ES256"] }));

const row = (label: string, r: { p50: number; p95: number }) => console.log(`${label.padEnd(44)} p50 ${r.p50.toFixed(2)} ms   p95 ${r.p95.toFixed(2)} ms`);
console.log(`${N} requests each, Node ${process.version}, ${process.platform}/${process.arch}`);
row("tools/list, bearer token, direct", direct);
row("tools/list, delegated token + proof, gateway", viaGateway);
row("agent: make one proof (ES256 sign)", sign);
row("server: check one proof (ES256 verify)", verify);
server.close();
await board.stop();
process.exit(0);
