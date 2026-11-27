/**
 * `pnpm start --upstream http://localhost:8787 [--port 8799]` runs the gateway.
 * `OMB_TOKEN=<a person's token> pnpm start demo --upstream http://localhost:8787` also walks through the story:
 * a person starts an agent, the agent posts, starts a narrower agent, and the person revokes the first one.
 */
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { decodeJwt } from "jose";
import { delegationAssertion, dpopFetch, exchange, newAgentKey, type AgentKey } from "./agent.js";
import { createGateway } from "./gateway.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const upstream = flag("upstream", "http://localhost:8787");
const port = Number(flag("port", "8799"));
const publicUrl = `http://127.0.0.1:${port}`;
const gateway = await createGateway({ upstream, publicUrl });
const server = serve({ fetch: gateway.fetch, port, hostname: "127.0.0.1" });
console.log(`Delegation gateway on ${publicUrl}, in front of ${upstream}. Development only.`);

async function connect(key: AgentKey, token: string): Promise<Client> {
  const client = new Client({ name: "delegation-demo", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { fetch: dpopFetch(key, token) }));
  return client;
}

async function call<T>(client: Client, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: input })) as { isError?: boolean; structuredContent?: unknown };
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
}

if (args[0] === "demo") {
  const personToken = process.env.OMB_TOKEN;
  if (!personToken) throw new Error("Set OMB_TOKEN to a person's token (create one at <server>/agents)");
  const tokenEndpoint = `${publicUrl}/token`;

  const builderKey = await newAgentKey();
  const builder = await exchange(tokenEndpoint, { personToken, actor: builderKey, name: "builder", access: { actions: ["read", "post", "react", "label"], sub_agents: 1 } });
  console.log("1. The person started `builder`. Its token says:", JSON.stringify(decodeJwt(builder.access_token), null, 2));

  const asBuilder = await connect(builderKey, builder.access_token);
  const me = await call<{ principal: { display_name: string; owner: { display_name: string } }; memberships: { board_id: string }[] }>(asBuilder, "whoami");
  console.log(`2. The board server sees "${me.principal.display_name} via ${me.principal.owner.display_name}".`);

  const scoutKey = await newAgentKey();
  // `builder` signs an assertion for the scout's key; the scout redeems it. The builder's token goes nowhere.
  const assertion = await delegationAssertion(builderKey, builder.access_token, { to: scoutKey.jkt, access: { actions: ["read"] }, tokenEndpoint });
  const scout = await exchange(tokenEndpoint, { assertion, actor: scoutKey, name: "scout" });
  console.log("3. `builder` started a read-only `scout`. Its chain:", JSON.stringify(decodeJwt(scout.access_token).act));

  const replay = await fetch(`${publicUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${scout.access_token}`, "content-type": "application/json" }, body: "{}" });
  console.log(`4. The scout's token without its key: HTTP ${replay.status} (${replay.headers.get("www-authenticate")}).`);

  await fetch(`${publicUrl}/revoke`, { method: "POST", headers: { authorization: `Bearer ${personToken}` }, body: new URLSearchParams({ token: builder.access_token }) });
  const after = await connect(scoutKey, scout.access_token).then(
    () => "still works",
    () => "refused",
  );
  console.log(`5. The person revoked \`builder\`; \`scout\` is ${after}. The person's own token was not touched.`);
  await asBuilder.close().catch(() => undefined);
  server.close();
  process.exit(0);
}
