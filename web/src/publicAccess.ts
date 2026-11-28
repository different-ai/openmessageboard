import type { Grant, GrantPrincipal, Permission } from "@openmessageboard/protocol";

/**
 * Which channels public grants open, worked out in the browser so the owner sees what a grant would do before
 * making it. It mirrors the server's rule (`publicDecision` in packages/core/src/domain/grants.ts); the server
 * decides, and each channel's `public` flag is its answer once the grant exists.
 */
export type GrantLike = { principals: GrantPrincipal[]; can: Record<string, Permission[]> };

export const isPublicGrant = (g: Pick<Grant, "principals">): boolean => g.principals.some((p) => p.kind === "public");

/** `*` covers every channel, `a/` covers `a` and everything under it, `a` covers `a` only. */
export function covers(pattern: string, channel: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.endsWith("/")) return channel === pattern;
  const p = pattern.slice(0, -1);
  return channel === p || channel.startsWith(`${p}/`);
}

/** An exact channel beats a longer subtree, which beats a shorter one, which beats `*`. */
function specificity(pattern: string): number {
  if (pattern === "*") return 0;
  const subtree = pattern.endsWith("/");
  return (subtree ? pattern.slice(0, -1) : pattern).split("/").length * 2 - (subtree ? 1 : 0);
}

/**
 * Whether people who are not members could read `channel` under `grants`.
 * - Among the public grants' patterns that cover it, the most specific decides; ties add up.
 * - A grant that closes the channel to plain readers at a more specific pattern keeps it closed: a private channel
 *   is closed at its own subtree, so `*` for the public leaves it private, and naming it opens it.
 */
export function publicCanRead(grants: GrantLike[], channel: string): boolean {
  let best = -1;
  let read = false;
  for (const g of grants) {
    if (!isPublicGrant(g)) continue;
    for (const [pattern, perms] of Object.entries(g.can)) {
      if (!covers(pattern, channel)) continue;
      const spec = specificity(pattern);
      if (spec > best) {
        best = spec;
        read = perms.includes("read");
      } else if (spec === best && perms.includes("read")) read = true;
    }
  }
  if (!read) return false;
  // What a member with the reader role and no grant of their own gets: the readers' group beats everyone.
  let memberSpec = -1;
  let memberRank = 0;
  let memberRead = true;
  for (const g of grants) {
    const rank = g.principals.some((p) => p.kind === "readers") ? 2 : g.principals.some((p) => p.kind === "everyone") ? 1 : 0;
    if (!rank) continue;
    for (const [pattern, perms] of Object.entries(g.can)) {
      if (!covers(pattern, channel)) continue;
      const spec = specificity(pattern);
      if (spec > memberSpec || (spec === memberSpec && rank > memberRank)) {
        memberSpec = spec;
        memberRank = rank;
        memberRead = perms.includes("read");
      } else if (spec === memberSpec && rank === memberRank && perms.includes("read")) memberRead = true;
    }
  }
  return !(memberSpec > best && !memberRead);
}
