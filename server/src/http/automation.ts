/** Web API routes for filtered reads, scheduled posts and watchers (reference server, non-normative). */
import { CreateWatcherBody, MESSAGE_SOURCES, ScheduleBody } from "@openmessageboard/protocol";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import { readMessages, type FilterInput } from "../domain/filters.js";
import * as schedules from "../domain/schedules.js";
import * as watchers from "../domain/watchers.js";
import { parseBody, requireActor, type AppCtx, type AppHono } from "./util.js";

const int = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number.parseInt(v, 10));

/** Message filters from the query string: `by`, `mentions`, `label` (repeat, key=value), `text`, `source`, `re`. */
export function filterQuery(c: AppCtx): FilterInput {
  const q = c.req.query();
  const labels: Record<string, string> = {};
  for (const v of c.req.queries("label") ?? []) {
    const i = v.indexOf("=");
    if (i <= 0) throw invalid(`label must be key=value, got "${v}"`);
    labels[v.slice(0, i)] = v.slice(i + 1);
  }
  return {
    by: q.by || undefined,
    mentions: q.mentions || undefined,
    labels: Object.keys(labels).length ? labels : undefined,
    text: q.text || undefined,
    source: z.enum(MESSAGE_SOURCES).optional().parse(q.source || undefined),
    re: q.re || undefined,
  };
}

export function registerAutomationRoutes(app: AppHono, ctx: AppContext): void {
  app.get("/api/boards/:boardId/messages", (c) =>
    c.json(
      readMessages(ctx, requireActor(c), c.req.param("boardId"), {
        ...filterQuery(c),
        after: c.req.query("after") || undefined,
        before: c.req.query("before") || undefined,
        limit: int(c.req.query("limit")),
      }),
    ),
  );

  app.get("/api/boards/:boardId/schedules", (c) =>
    c.json(schedules.listSchedules(ctx, requireActor(c), { board_id: c.req.param("boardId"), all: c.req.query("all") === "true", limit: int(c.req.query("limit")) })),
  );
  app.get("/api/threads/:threadId/schedules", (c) =>
    c.json(schedules.listSchedules(ctx, requireActor(c), { thread_id: c.req.param("threadId"), all: c.req.query("all") === "true", limit: int(c.req.query("limit")) })),
  );
  app.post("/api/boards/:boardId/schedules", async (c) =>
    c.json(schedules.schedulePost(ctx, requireActor(c), { ...(await parseBody(c, ScheduleBody)), board_id: c.req.param("boardId") })),
  );
  app.post("/api/threads/:threadId/schedules", async (c) =>
    c.json(schedules.schedulePost(ctx, requireActor(c), { ...(await parseBody(c, ScheduleBody)), thread_id: c.req.param("threadId") })),
  );
  app.delete("/api/schedules/:scheduleId", (c) => c.json(schedules.cancelSchedule(ctx, requireActor(c), c.req.param("scheduleId"))));

  app.get("/api/boards/:boardId/watchers", (c) => c.json(watchers.listWatchers(ctx, requireActor(c), c.req.param("boardId"))));
  app.post("/api/boards/:boardId/watchers", async (c) =>
    c.json(await watchers.createWatcher(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, CreateWatcherBody))),
  );
  app.delete("/api/watchers/:watcherId", (c) => c.json(watchers.deleteWatcher(ctx, requireActor(c), c.req.param("watcherId"))));
}
