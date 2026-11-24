import { readFileSync } from "node:fs";
import { z } from "zod";

const Human = z.object({ token: z.string().min(1), email: z.string().min(3) });
const AgentIdentity = z.object({ token: z.string().min(1), owner: z.string().min(1), display_name: z.string().min(1) });

/**
 * The identities file. The reference server writes it with
 * `omb admin test-identities --out conformance/identities.json` (test mode only).
 * Every human is verified and starts with no board membership; `agent` belongs to
 * `maya` and is on no board until maya adds it outside MCP.
 */
export const IdentitiesFile = z.object({
  server: z.string().optional(),
  principals: z
    .object({
      owner: Human,
      maya: Human,
      outsider: Human,
      lookalike: Human,
      subdomain: Human,
      quota: Human,
      agent: AgentIdentity,
    })
    .catchall(z.unknown()),
});
export type Identities = z.infer<typeof IdentitiesFile>;
export type HumanName = "owner" | "maya" | "outsider" | "lookalike" | "subdomain" | "quota";
export type PrincipalName = HumanName | "agent";
export const HUMANS: HumanName[] = ["owner", "maya", "outsider", "lookalike", "subdomain", "quota"];

export function loadIdentities(path: string): Identities {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read identities file ${path}: ${(e as Error).message}`);
  }
  const parsed = IdentitiesFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`identities file ${path} is invalid: ${issues}`);
  }
  if (parsed.data.principals.agent.owner !== "maya") {
    throw new Error(`identities file ${path}: principals.agent.owner must be "maya"`);
  }
  return parsed.data;
}

export function tokenOf(ids: Identities, name: PrincipalName): string {
  return ids.principals[name].token;
}
