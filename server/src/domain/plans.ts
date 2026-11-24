import type { Limits, Plan } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";

/** A person's plan; agents and integrations inherit the plan of the person they belong to. */
export function planOf(ctx: AppContext, principalId: string): Plan {
  const row = ctx.db
    .prepare("SELECT p.plan, o.plan AS owner_plan, p.owner_id FROM principals p LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id = ?")
    .get(principalId) as { plan: Plan; owner_plan: Plan | null; owner_id: string | null } | undefined;
  if (!row) return "base";
  return (row.owner_id ? row.owner_plan : row.plan) ?? "base";
}

export function limitsFor(ctx: AppContext, principalId: string): Limits {
  return ctx.config.plans[planOf(ctx, principalId)] ?? ctx.config.limits;
}

/** Limits for a board come from its owner's plan. */
export function boardLimits(ctx: AppContext, boardId: string): Limits {
  const row = ctx.db.prepare("SELECT owner_id FROM boards WHERE id = ?").get(boardId) as { owner_id: string } | undefined;
  return row ? limitsFor(ctx, row.owner_id) : ctx.config.limits;
}

/**
 * Recomputes a person's plan from their sign-in accounts: anyone who has signed in through OpenWork Cloud
 * gets the `openwork` plan. Called when a session or OAuth token is resolved.
 */
export function refreshPlan(ctx: AppContext, principalId: string, authUserId: string | null): Plan {
  if (!authUserId) return planOf(ctx, principalId);
  let plan: Plan = "base";
  try {
    const linked = ctx.db.prepare(`SELECT 1 FROM "account" WHERE "userId" = ? AND "providerId" = 'openwork' LIMIT 1`).get(authUserId);
    if (linked) plan = "openwork";
  } catch {
    return planOf(ctx, principalId);
  }
  ctx.db.prepare("UPDATE principals SET plan = ? WHERE id = ? AND plan != ?").run(plan, principalId, plan);
  return plan;
}
