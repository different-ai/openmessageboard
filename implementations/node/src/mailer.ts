import { createOutboxMailer, type AppContext, type Mailer } from "@openmessageboard/core";

/** SMTP when OMB_SMTP_URL is set; otherwise the core's outbox mailer (test outbox and server log). */
export async function createMailer(ctx: AppContext): Promise<Mailer> {
  const { smtpUrl, mailFrom } = ctx.config;
  if (!smtpUrl) return createOutboxMailer(ctx);
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(mail) {
      await transport.sendMail({ from: mailFrom, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}
