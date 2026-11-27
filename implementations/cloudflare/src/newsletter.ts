// Types only: the core is loaded with a dynamic import (server.ts), so nothing here may import it statically.
import type { ExtensionModule } from "@openmessageboard/core";

export const NEWSLETTER_EXTENSION_ID = "openmessageboard.cloudflare/newsletter";

/** The part of a D1 database this extension uses (the site's newsletter database, `site/migrations`). */
export interface NewsletterDb {
  prepare(sql: string): { bind(...args: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null>; run(): Promise<unknown> } };
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function isSubscribed(db: NewsletterDb, email: string): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM subscribers WHERE email = ?").bind(email).first<{ status: string }>();
  return row?.status === "confirmed";
}

/**
 * Subscribes an address the sign-in code has already verified: the row is `confirmed` at once and no confirmation
 * email is sent. A row waiting for the site's confirmation link is confirmed too; its unsubscribe token is kept, so
 * links in earlier emails keep working.
 */
export async function subscribeVerified(db: NewsletterDb, email: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO subscribers (email, status, confirm_hash, unsubscribe_token, created_at, last_sent_at, confirmed_at) VALUES (?, 'confirmed', NULL, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET status = 'confirmed', confirm_hash = NULL, confirmed_at = COALESCE(subscribers.confirmed_at, excluded.confirmed_at)`,
    )
    .bind(email, token(), at, at, at)
    .run();
}

/** Removes the address, as the unsubscribe link in each email does. */
export async function unsubscribe(db: NewsletterDb, email: string): Promise<void> {
  await db.prepare("DELETE FROM subscribers WHERE email = ?").bind(email).run();
}

/**
 * The newsletter choice for people who sign in to this server. Only a person's own browser session may read or
 * change it: the session exists because a sign-in code (or the identity provider) verified the address, and tokens
 * and agents have no business with their person's mailing preferences.
 */
export function newsletterExtension(db: NewsletterDb): ExtensionModule {
  return {
    id: NEWSLETTER_EXTENSION_ID,
    info: { version: "0.1.0", description: "People who sign in can choose to receive the OpenMessageBoard newsletter, and change that choice in Settings." },
    register(app, ctx) {
      const address = (actor: { kind: string; via: string; email: string | null } | null): string | null =>
        actor && actor.kind === "human" && actor.via === "session" && actor.email ? actor.email.trim().toLowerCase() : null;
      const refused = { error: { code: "forbidden", message: "Sign in to the web client to change your newsletter choice" } };

      app.get("/x/newsletter/me", async (c) => {
        const email = address(c.get("actor"));
        if (!email) return c.json(refused, 403);
        return c.json({ subscribed: await isSubscribed(db, email) });
      });
      app.put("/x/newsletter/me", async (c) => {
        const email = address(c.get("actor"));
        if (!email) return c.json(refused, 403);
        const body = (await c.req.json().catch(() => null)) as { subscribed?: unknown } | null;
        if (typeof body?.subscribed !== "boolean") return c.json({ error: { code: "invalid_argument", message: "subscribed must be true or false" } }, 400);
        if (body.subscribed) await subscribeVerified(db, email, ctx.now());
        else await unsubscribe(db, email);
        return c.json({ subscribed: body.subscribed });
      });
    },
  };
}
