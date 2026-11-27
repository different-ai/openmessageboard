// Types only: the core is loaded with a dynamic import (server.ts), so nothing here may import it statically.
import type { AppContext, Mailer } from "@openmessageboard/core";
import type { Env } from "./env.js";

/** Splits `Name <address>` (the form of OMB_MAIL_FROM) into what the Email Service binding takes. */
export function parseFrom(from: string): string | { email: string; name: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+)>\s*$/);
  if (!m) return from.trim();
  const name = m[1]!.trim();
  return name ? { email: m[2]!, name } : m[2]!;
}

/**
 * Cloudflare Email Service when the Worker has an `EMAIL` binding (`send_email` in wrangler.jsonc) and the sender's
 * domain is onboarded for sending. Without the binding, and always in test mode, mail goes to the core's outbox
 * mailer (the test outbox and the log), so a new deployment can sign in before email is set up.
 */
export function createMailer(env: Env, outbox: (ctx: AppContext) => Mailer): (ctx: AppContext) => Mailer {
  return (ctx) => {
    const binding = env.EMAIL;
    if (!binding || ctx.config.testMode) return outbox(ctx);
    const from = parseFrom(ctx.config.mailFrom);
    return {
      async send(mail) {
        try {
          await binding.send({ to: mail.to, from, subject: mail.subject, text: mail.text });
        } catch (e) {
          // The address and the code stay out of the log; the error code says what to fix (sender domain, quota).
          console.error(`[mail] Email Service refused a message: ${(e as { code?: string }).code ?? "unknown"}`);
          throw new Error("The sign-in email could not be sent. Try again in a moment.");
        }
      },
    };
  };
}
