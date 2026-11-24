import type { Context, Hono } from "hono";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import type { Actor } from "../domain/model.js";

/** Hono environment: the auth middleware sets `actor` (null when signed out). */
export type AppEnv = { Variables: { actor: Actor | null } };
export type AppHono = Hono<AppEnv>;
export type AppCtx = Context<AppEnv>;

export function requireActor(c: AppCtx): Actor {
  const actor = c.get("actor");
  if (!actor) throw new OmbError("unauthenticated", "Sign in or send a bearer token");
  return actor;
}

export async function parseBody<S extends z.ZodType>(c: AppCtx, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalid("Request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export function errorResponse(c: AppCtx, e: OmbError): Response {
  return c.json({ error: e.toBody() }, e.status as 400);
}

/** Signature for feature modules (sync, workload identity) that add routes. */
export type RouteModule = (app: AppHono, ctx: AppContext) => void;
