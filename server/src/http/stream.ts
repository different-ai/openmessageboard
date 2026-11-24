import { streamSSE } from "hono/streaming";
import type { AppContext } from "../context.js";
import { OmbError } from "../errors.js";
import { requireMember } from "../domain/access.js";
import { boardChanges, inboxChanges } from "../domain/changes.js";
import { encodeCursor } from "../domain/cursors.js";
import { cursorAfter, hasFilterInput, resolveFilter } from "../domain/filters.js";
import { filterQuery } from "./automation.js";
import type { Actor } from "../domain/model.js";
import type { CloseReason } from "../live/connections.js";
import type { AppCtx } from "./util.js";

const KEEPALIVE_MS = 15_000;

/**
 * Board change stream for the browser (Server-Sent Events). Subscribes to the hub before catching up,
 * so a change that commits during catch-up is never missed; every frame is re-read from the event log.
 * Message filters in the query string (see `filterQuery`) limit the frames to matching changes.
 */
export function boardStream(ctx: AppContext, c: AppCtx, actor: Actor, boardId: string): Response | Promise<Response> {
  requireMember(ctx, actor, boardId);
  ctx.rate.hit(`s:p:${actor.id}`, ctx.config.rateLimits.streams_per_minute_principal, 60_000);
  const input = filterQuery(c);
  const filter = hasFilterInput(input) ? resolveFilter(ctx, actor, boardId, input) : undefined;
  const after = c.req.query("after");
  let cursor =
    c.req.query("cursor") || c.req.header("last-event-id") || (after ? cursorAfter(ctx, boardId, after) : undefined) || boardChanges(ctx, actor, boardId, undefined).cursor;
  let closeReason: CloseReason | null = null;
  let wake: () => void = () => {};
  const conn = ctx.connections.register({
    principalId: actor.id,
    kind: "sse",
    boards: new Set([boardId]),
    close: (reason) => {
      closeReason = reason;
      wake();
    },
  });
  return streamSSE(c, async (stream) => {
    let dirty = true;
    const unsub = ctx.hub.subscribe((e) => {
      if (e.kind === "board" && e.boardId === boardId) dirty = true;
      else if (e.kind === "access" && e.boardId === boardId && e.principalId === actor.id && e.reason !== "role_changed") closeReason = e.reason === "expired" ? "expired" : "removed";
      else if (e.kind === "board_deleted" && e.boardId === boardId) closeReason = "board_deleted";
      else return;
      wake();
    });
    stream.onAbort(() => {
      closeReason = closeReason ?? "shutdown";
      wake();
    });
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor }) });
      let lastBeat = Date.now();
      while (!stream.aborted && !stream.closed) {
        if (closeReason && closeReason !== "role_changed") {
          if (closeReason !== "shutdown") await stream.writeSSE({ event: "access_ended", data: JSON.stringify({ reason: closeReason }) });
          break;
        }
        if (dirty) {
          dirty = false;
          try {
            for (;;) {
              const page = boardChanges(ctx, actor, boardId, cursor, 100, undefined, filter);
              for (const ch of page.changes) {
                await stream.writeSSE({ event: "change", id: encodeCursor("b", boardId, ch.seq), data: JSON.stringify(ch) });
              }
              cursor = page.cursor;
              if (!page.has_more) break;
            }
          } catch (e) {
            if (e instanceof OmbError && e.code === "cursor_expired") {
              await stream.writeSSE({ event: "resync", data: JSON.stringify({ reason: "cursor_expired" }) });
              break;
            }
            if (e instanceof OmbError && (e.code === "access_ended" || e.code === "not_found")) {
              await stream.writeSSE({ event: "access_ended", data: JSON.stringify({ reason: e.code === "access_ended" ? "expired" : "removed" }) });
              break;
            }
            throw e;
          }
        }
        if (Date.now() - lastBeat >= KEEPALIVE_MS) {
          await stream.write(": keepalive\n\n");
          lastBeat = Date.now();
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, KEEPALIVE_MS);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
          if (dirty || closeReason) wake();
        });
      }
    } finally {
      unsub();
      ctx.connections.unregister(conn);
    }
  });
}

export function inboxStream(ctx: AppContext, c: AppCtx, actor: Actor): Response | Promise<Response> {
  ctx.rate.hit(`s:p:${actor.id}`, ctx.config.rateLimits.streams_per_minute_principal, 60_000);
  let cursor = c.req.query("cursor") || c.req.header("last-event-id") || inboxChanges(ctx, actor, undefined).cursor;
  return streamSSE(c, async (stream) => {
    let dirty = true;
    let wake: () => void = () => {};
    const unsub = ctx.hub.subscribe((e) => {
      if (e.kind === "inbox" && e.principalId === actor.id) {
        dirty = true;
        wake();
      }
    });
    stream.onAbort(() => wake());
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ cursor }) });
      while (!stream.aborted && !stream.closed) {
        if (dirty) {
          dirty = false;
          for (;;) {
            const page = inboxChanges(ctx, actor, cursor, 100);
            for (const item of page.items) await stream.writeSSE({ event: "inbox", data: JSON.stringify(item) });
            cursor = page.cursor;
            if (page.items.length) await stream.writeSSE({ event: "cursor", id: cursor, data: JSON.stringify({ cursor }) });
            if (!page.has_more) break;
          }
        } else {
          await stream.write(": keepalive\n\n");
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, KEEPALIVE_MS);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
          if (dirty) wake();
        });
      }
    } finally {
      unsub();
    }
  });
}
