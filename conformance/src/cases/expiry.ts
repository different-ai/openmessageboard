/**
 * One shared "access ends while subscribed" scenario, used by live.access-ends
 * (listen stream) and events.webhook-terminated (webhook subscription), so the
 * slow part (waiting for expiry and the teardown window) runs once.
 */
import { Skip } from "../errors.ts";
import type { Ctx } from "../harness.ts";
import { rpcErrorCode } from "../http.ts";
import type { Listener } from "../mcp.ts";
import { describeError, sleep } from "../util.ts";
import type { Endpoint } from "../webhook.ts";
import { boardCursor, reply, startThread } from "./helpers.ts";

export interface ExpiryFindings {
  common: string[];
  live: string[];
  events: string[];
  notes: string[];
  ranLive: boolean;
  ranEvents: boolean;
}

const SETUP_MS = 15_000;
/** 30 s expiry window from 02 §Ending access, plus 5 s for network and scheduling. */
const TEARDOWN_MS = 35_000;

function wants(ctx: Ctx, profile: "live" | "events"): boolean {
  return ctx.opts.profiles.includes(profile) && (ctx.opts.forceProfiles || ctx.claims(profile));
}

export function expiryScenario(ctx: Ctx): Promise<ExpiryFindings> {
  return ctx.fixture("expiry-scenario", async () => {
    const f: ExpiryFindings = { common: [], live: [], events: [], notes: [], ranLive: wants(ctx, "live"), ranEvents: wants(ctx, "events") };
    const mayaBoard = await ctx.boardOf("maya");
    if (await ctx.isMember("subdomain", mayaBoard)) {
      throw new Skip("the subdomain identity is still an active member of maya's board (an earlier run was interrupted); wait for its access to end or use a fresh server");
    }
    let listener: Listener | undefined;
    let endpoint: Endpoint | undefined;
    try {
      const maya = await ctx.session("maya");
      const sub = await ctx.session("subdomain");
      await maya.reserveWrites(5);
      const t = await startThread(maya, mayaBoard, `Expiry ${ctx.runId}`, "Access for the guest ends shortly.");
      const endsAt = ctx.serverNow() + SETUP_MS;
      const { invite } = await maya.ok("create_invite", {
        board_id: mayaBoard,
        audience: "email",
        value: ctx.email("subdomain"),
        role: "reader",
        access_ends_at: new Date(endsAt).toISOString(),
      });
      const joined = await sub.ok("redeem_invite", { invite: invite.url! });
      const reported = Date.parse(joined.board.my_access_ends_at ?? "");
      if (!Number.isFinite(reported) || Math.abs(reported - endsAt) > 1000) f.common.push(`the new membership's my_access_ends_at is ${joined.board.my_access_ends_at}, expected the invite's access_ends_at`);
      const base = await ctx.resourceBase();
      const boardUri = `${base}/b/${mayaBoard}`;
      const threadUri = `${base}/b/${mayaBoard}/t/${t.thread.id}`;
      const subCursor = await boardCursor(sub, mayaBoard);

      if (f.ranLive) {
        listener = await sub.listen([boardUri, threadUri]);
        if (!listener.acknowledged.includes(boardUri) || !listener.acknowledged.includes(threadUri)) f.live.push(`listen acknowledged ${JSON.stringify(listener.acknowledged)}, expected the board and thread URIs`);
      }
      if (f.ranEvents) {
        endpoint = (await ctx.receiver()).endpoint("echo");
        const r = await sub.rpc("events/subscribe", {
          name: "board.message_created",
          arguments: { board_id: mayaBoard },
          delivery: { mode: "webhook", url: endpoint.url, secret: endpoint.secret },
          cursor: null,
          ttlMs: 600_000,
        });
        if (!r.result) {
          f.events.push(`events/subscribe failed before expiry: ${JSON.stringify(r.error)}`);
          endpoint = undefined;
        }
      }

      const before = await reply(maya, t.thread.id, "Posted before access ends.");
      if (listener && !(await listener.waitForUpdate((u) => u === boardUri || u === threadUri, 5000))) f.live.push("no notifications/resources/updated arrived for a post made before access ended");
      if (endpoint && !(await endpoint.waitFor((d) => d.body?.eventId === before.message.id, 10_000))) f.events.push("no webhook delivery arrived for a post made before access ended");
      if (ctx.serverNow() > endsAt - 500) f.notes.push("setup took longer than the access window; the before-expiry checks may be inconclusive");

      while (ctx.serverNow() < endsAt + 500) await sleep(200);
      const expiredLocal = Date.now();
      const after = await reply(maya, t.thread.id, "Posted after access ended.");

      const g = await sub.call("get_thread", { thread_id: t.thread.id });
      if (g.ok || g.error.code !== "access_ended") f.common.push(`get_thread right after access ended returned ${g.ok ? "success" : g.error.code}, expected access_ended (every request checks access_ends_at)`);
      const rr = await sub.rpc("resources/read", { uri: boardUri });
      if (!rr.error || rr.error.code !== -32602 || rpcErrorCode(rr.error) !== "access_ended") f.common.push(`resources/read after access ended returned ${JSON.stringify(rr.error ?? "success").slice(0, 160)}, expected -32602 with data.code access_ended`);
      const w = await sub.call("wait_for_activity", { board_id: mayaBoard, cursor: subCursor, timeout_seconds: 2 });
      if (w.ok || w.error.code !== "access_ended") f.common.push(`wait_for_activity after access ended returned ${w.ok ? "success" : w.error.code}, expected access_ended`);
      if (f.ranEvents) {
        const p = await sub.rpc("events/poll", { name: "board.message_created", arguments: { board_id: mayaBoard }, cursor: null });
        const code = (p.error?.data as { code?: unknown } | undefined)?.code;
        if (!p.error || p.error.code !== -32024 || code !== "access_ended") f.events.push(`events/poll after access ended returned ${JSON.stringify(p.error ?? "success").slice(0, 160)}, expected -32024 with data.code access_ended`);
      }

      const remaining = () => Math.max(0, TEARDOWN_MS - (Date.now() - expiredLocal));
      if (listener) {
        const cause = await listener.waitClosed(remaining());
        if (!cause) f.live.push("the listen stream was still open 35 s after access ended (expiry window is 30 s)");
        else if (cause !== "graceful") f.live.push(`the listen stream ended (${cause}) without the graceful subscriptions/listen completion response`);
        else f.notes.push(`listen closed gracefully ${Math.round(((listener.closedAt ?? Date.now()) - expiredLocal) / 1000)} s after access ended`);
        const late = listener.updates.filter((u) => u.at > expiredLocal + 1000);
        if (late.length) f.live.push(`${late.length} update notification(s) arrived after access ended (${late.map((u) => u.uri).join(", ")})`);
      }
      if (endpoint) {
        const term = await endpoint.waitFor((d) => d.body?.type === "terminated", remaining());
        if (!term) f.events.push("no terminated envelope arrived within 35 s of access ending");
        else {
          if (term.signatureError) f.events.push(`the terminated envelope's signature is invalid: ${term.signatureError}`);
          const err = term.body?.error as { code?: unknown; data?: { reason?: unknown } } | undefined;
          if (err?.code !== -32024) f.events.push(`terminated error.code is ${String(err?.code)}, expected -32024`);
          if (err?.data?.reason !== "access_ended") f.notes.push(`terminated data.reason is ${String(err?.data?.reason)}`);
        }
        if (endpoint.deliveries.some((d) => d.body?.eventId === after.message.id)) f.events.push("the message posted after access ended was delivered to the webhook");
      }
    } catch (e) {
      if (e instanceof Skip) throw e;
      f.common.push(`scenario error: ${describeError(e)}`);
    } finally {
      await listener?.close();
    }
    return f;
  });
}
