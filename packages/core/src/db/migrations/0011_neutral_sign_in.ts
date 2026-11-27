import type { DB } from "../index.js";

/**
 * Sign-in through an identity provider is now the generic `oidc` provider and its plan is `plus`. Servers that ran
 * before this used a provider and a plan both named `openwork`; this carries their accounts and plans over so
 * nobody loses their account link or their limits. The cached client registration is dropped because the redirect
 * URI changed with the provider's name; the server registers again on its next start.
 */
export function up(db: DB): void {
  db.prepare("UPDATE principals SET plan = 'plus' WHERE plan = 'openwork'").run();
  db.prepare("DELETE FROM meta WHERE key LIKE 'openwork_client:%'").run();
  try {
    db.prepare(`UPDATE "account" SET "providerId" = 'oidc' WHERE "providerId" = 'openwork'`).run();
  } catch {
    // The sign-in tables are created by the auth library and may not exist yet on a new database.
  }
}
