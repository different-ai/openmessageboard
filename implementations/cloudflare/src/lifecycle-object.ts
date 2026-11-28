import { DurableObject } from "cloudflare:workers";
import { parseFrom } from "./mailer.js";
import { NotSentError, composeMail, lifecycleSettings, runLifecycle, type BoardSnapshot, type LifecycleDeps, type LifecycleMail, type LifecycleState } from "./lifecycle.js";
import type { Env } from "./env.js";
import type { BoardServer } from "./server.js";

/**
 * One per board (`LIFECYCLE.idFromName(board_id)`): it owns that board's inactivity schedule, its Alarm, and the
 * record of which emails went out. It keeps no content. The server object holds the facts (last activity, the
 * owner's address) and makes the change; this object decides when, and sleeps until then.
 *
 * Its storage survives restarts and redeploys, and writes are confirmed before any outgoing call leaves the object,
 * so the "sending" mark for an email is durable before the email is handed over.
 */
export class BoardLifecycle extends DurableObject<Env> {
  /** The server object tells this board to look again: when it is first seen, kept, reactivated or deactivated. */
  async sync(snapshot: BoardSnapshot): Promise<void> {
    await this.ctx.storage.put("board_id", snapshot.board_id);
    await runLifecycle(this.deps(), snapshot.board_id, snapshot);
  }

  override async alarm(): Promise<void> {
    const boardId = await this.ctx.storage.get<string>("board_id");
    if (!boardId) return;
    try {
      await runLifecycle(this.deps(), boardId);
    } catch (e) {
      // The server object was unreachable or failed. Cloudflare retries a thrown Alarm only a few times; setting
      // the next one here keeps this board scheduled whatever happens.
      console.error(`[lifecycle] board ${boardId}: ${e instanceof Error ? e.message : "failed"}`);
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
    }
  }

  private server(): DurableObjectStub<BoardServer> {
    const ns = this.env.BOARD as unknown as DurableObjectNamespace<BoardServer>;
    return ns.get(ns.idFromName("main"));
  }

  private deps(): LifecycleDeps {
    const storage = this.ctx.storage;
    return {
      settings: lifecycleSettings(this.env),
      now: () => Date.now(),
      load: async () => (await storage.get<LifecycleState>("state")) ?? null,
      save: (state) => storage.put("state", state),
      forget: async () => {
        await storage.deleteAlarm();
        await storage.deleteAll();
      },
      setAlarm: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(Math.max(at, Date.now() + 1000))),
      snapshot: (boardId) => this.server().lifecycleSnapshot(boardId),
      deactivate: (boardId) => this.server().lifecycleDeactivate(boardId),
      send: (mail) => this.send(mail),
    };
  }

  /**
   * Cloudflare Email Service when the Worker has the `EMAIL` binding, as for sign-in codes. Without it, and always
   * in test mode, the email is written to the log instead (its link included, never the address).
   */
  private async send(mail: LifecycleMail): Promise<void> {
    const base = String(this.env.OMB_PUBLIC_URL ?? "");
    const message = await composeMail(mail, { base, secret: String(this.env.OMB_SECRET ?? ""), now: Date.now() });
    const binding = this.env.EMAIL;
    if (!binding || ["1", "true", "yes", "on"].includes(String(this.env.OMB_TEST_MODE ?? "").toLowerCase())) {
      console.log(`[lifecycle] No email sender is configured. ${mail.kind} for board ${mail.board_id}:\n${message.text}`);
      return;
    }
    try {
      await binding.send({ to: message.to, from: parseFrom(String(this.env.OMB_MAIL_FROM ?? "")), subject: message.subject, text: message.text });
    } catch (e) {
      // A refusal carries a code (sender not verified, quota): the message was not accepted and can be tried again.
      // Anything else (a timeout, a dropped connection) may have gone out, so it is not retried.
      const code = (e as { code?: unknown }).code;
      console.error(`[lifecycle] Email Service failed for board ${mail.board_id}: ${typeof code === "string" ? code : "unknown"}`);
      throw typeof code === "string" ? new NotSentError(code) : e;
    }
  }
}
