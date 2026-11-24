import { ChannelPath, CreateChannelBody, CreateGrantBody, UpdateGrantBody } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import * as channels from "../domain/channels.js";
import { parseBody, requireActor, type AppHono } from "./util.js";

/** Web API for channels and grants (the browser client and the CLI's REST fallbacks use these). */
export function registerChannelRoutes(app: AppHono, ctx: AppContext): void {
  app.get("/api/boards/:boardId/channels", (c) => c.json(channels.listChannels(ctx, requireActor(c), c.req.param("boardId"))));
  app.post("/api/boards/:boardId/channels", async (c) => c.json(channels.createChannel(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, CreateChannelBody))));
  app.get("/api/boards/:boardId/grants", (c) => c.json(channels.listGrants(ctx, requireActor(c), c.req.param("boardId"))));
  app.post("/api/boards/:boardId/grants", async (c) => c.json(channels.createGrant(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, CreateGrantBody))));
  app.patch("/api/grants/:grantId", async (c) => c.json(channels.updateGrant(ctx, requireActor(c), c.req.param("grantId"), await parseBody(c, UpdateGrantBody))));
  app.delete("/api/grants/:grantId", (c) => c.json(channels.revokeGrant(ctx, requireActor(c), c.req.param("grantId"))));
  app.get("/api/boards/:boardId/access", (c) =>
    c.json(channels.explainAccess(ctx, requireActor(c), c.req.param("boardId"), ChannelPath.parse(c.req.query("channel") ?? ""), c.req.query("principal_id") || undefined)),
  );
}
