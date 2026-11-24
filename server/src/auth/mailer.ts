import type { AppContext } from "../context.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  code?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * SMTP when OMB_SMTP_URL is set. Otherwise codes go to the test outbox (test mode) and the server log (development),
 * so a self-hoster can sign in before configuring email.
 */
export async function createMailer(ctx: AppContext): Promise<Mailer> {
  const { smtpUrl, mailFrom, testMode } = ctx.config;
  if (smtpUrl) {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(smtpUrl);
    return {
      async send(mail) {
        await transport.sendMail({ from: mailFrom, to: mail.to, subject: mail.subject, text: mail.text });
      },
    };
  }
  return {
    async send(mail) {
      ctx.db
        .prepare("INSERT INTO test_outbox (email, subject, body, code, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(mail.to.toLowerCase(), mail.subject, mail.text, mail.code ?? null, ctx.now().toISOString());
      ctx.db.prepare("DELETE FROM test_outbox WHERE created_at < ?").run(new Date(ctx.now().getTime() - 3_600_000).toISOString());
      if (!testMode) console.log(`[mail] OMB_SMTP_URL is not set. Sign-in code for ${mail.to}: ${mail.code ?? "(see body)"}`);
    },
  };
}
