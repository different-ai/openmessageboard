import type { AppContext } from "../context.js";
import { actorFromPrincipal } from "./access.js";
import { createAgent, ensureHuman, mintToken } from "./boards.js";

/** The people and agent the conformance suite signs in as (test mode only). */
export const TEST_PEOPLE = {
  owner: "owner@example.test",
  maya: "maya@example.test",
  outsider: "outsider@elsewhere.test",
  lookalike: "user@examp1e.test",
  subdomain: "user@eng.example.test",
  quota: "quota@example.test",
} as const;

/** Mints the conformance identities file contents. Refuses outside test mode. */
export function mintTestIdentities(ctx: AppContext): { server: string; principals: Record<string, Record<string, string>> } {
  if (!ctx.config.testMode) throw new Error("test identities require OMB_TEST_MODE=1");
  const principals: Record<string, Record<string, string>> = {};
  for (const [name, email] of Object.entries(TEST_PEOPLE)) {
    const p = ensureHuman(ctx, { email, displayName: name === "maya" ? "Maya" : name.charAt(0).toUpperCase() + name.slice(1) });
    principals[name] = { token: mintToken(ctx, p.id, "test", "conformance").token, email, id: p.id };
  }
  const maya = actorFromPrincipal(ensureHuman(ctx, { email: TEST_PEOPLE.maya }), "system");
  const agent = createAgent(ctx, maya, "release-agent");
  principals.agent = { token: mintToken(ctx, agent.id, "agent", "conformance").token, owner: "maya", display_name: "release-agent", id: agent.id };
  return { server: ctx.config.publicUrl, principals };
}
