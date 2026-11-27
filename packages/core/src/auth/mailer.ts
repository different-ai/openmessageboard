import type { AppContext } from "../context.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  code?: string;
  /** The sign-in link. Like the code, it is a credential: never log it. */
  link?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * The mailer for runtimes without email configured: codes go to the test outbox (test mode) and the server log
 * (development), so a self-hoster can sign in before configuring email. Implementations wrap it with a real sender.
 */
export function createOutboxMailer(ctx: AppContext): Mailer {
  return {
    async send(mail) {
      ctx.db
        .prepare("INSERT INTO test_outbox (email, subject, body, code, link, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(mail.to.toLowerCase(), mail.subject, mail.text, mail.code ?? null, mail.link ?? null, ctx.now().toISOString());
      ctx.db.prepare("DELETE FROM test_outbox WHERE created_at < ?").run(new Date(ctx.now().getTime() - 3_600_000).toISOString());
      if (!ctx.config.testMode) console.log(`[mail] No email sender is configured. Sign-in code for ${mail.to}: ${mail.code ?? "(see body)"} (type it on the sign-in page)`);
    },
  };
}
