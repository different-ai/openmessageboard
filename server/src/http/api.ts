import {
  AddAgentToBoardBody,
  ClaimTaskBody,
  CreateAgentBody,
  CreateBoardBody,
  CreateInviteBody,
  CreateTokenBody,
  DeleteBoardBody,
  FollowBody,
  LabelsBody,
  MarkReadBody,
  ReplyBody,
  StartThreadBody,
  UpdateBoardBody,
  UpdateMemberBody,
  UpdateTaskBody,
  TASK_STATES,
  THREAD_KINDS,
  ChannelFilter,
  type ServerInfo,
} from "@openmessageboard/protocol";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import * as boards from "../domain/boards.js";
import * as invites from "../domain/invites.js";
import * as convo from "../domain/conversation.js";
import * as changes from "../domain/changes.js";
import * as usage from "../domain/usage.js";
import * as portability from "../domain/portability.js";
import { presentBoard } from "../domain/present.js";
import { getMembership } from "../domain/access.js";
import type { Actor } from "../domain/model.js";
import { limitsFor, planOf } from "../domain/plans.js";
import { parseBody, requireActor, type AppHono } from "./util.js";
import { boardStream, inboxStream } from "./stream.js";

export function principalOf(actor: Actor, ctx?: AppContext) {
  return {
    ...(ctx ? { plan: planOf(ctx, actor.id), limits: { ...limitsFor(ctx, actor.id) } } : {}),
    id: actor.id,
    kind: actor.kind,
    display_name: actor.displayName,
    email: actor.kind === "human" ? actor.email : null,
    owner: null as null | { id: string; kind: "human"; display_name: string; via: null },
  };
}

export function whoami(ctx: AppContext, actor: Actor, server: ServerInfo, createBoard: boolean) {
  const own = boards.ensureOwnBoard(ctx, actor, { create: createBoard });
  const principal = principalOf(actor, ctx);
  if (actor.ownerId) {
    const owner = ctx.db.prepare("SELECT id, display_name FROM principals WHERE id = ?").get(actor.ownerId) as { id: string; display_name: string } | undefined;
    if (owner) principal.owner = { id: owner.id, kind: "human", display_name: owner.display_name, via: null };
  }
  const owned = actor.kind === "human" ? boards.ownedBoards(ctx, actor.id) : [];
  return {
    principal,
    owned_board: own ? presentBoard(ctx, own, getMembership(ctx, own.id, actor.id)!) : null,
    owned_boards: owned.flatMap((b) => {
      const m = getMembership(ctx, b.id, actor.id);
      return m ? [presentBoard(ctx, b, m)] : [];
    }),
    memberships: boards.listMemberships(ctx, actor),
    server,
  };
}

function labelsFromQuery(values: string[]): Record<string, string> | undefined {
  if (!values.length) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf("=");
    if (i <= 0) throw invalid(`label must be key=value, got "${v}"`);
    out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}

const int = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number.parseInt(v, 10));

export function registerApiRoutes(app: AppHono, ctx: AppContext, serverInfo: () => ServerInfo): void {
  app.get("/api/session", (c) => {
    const actor = c.get("actor");
    return c.json({ principal: actor ? principalOf(actor, ctx) : null });
  });
  app.get("/api/me", (c) => c.json(whoami(ctx, requireActor(c), serverInfo(), false)));
  app.post("/api/boards", async (c) => {
    const actor = requireActor(c);
    const body = await parseBody(c, CreateBoardBody);
    // A person's first board is their personal board (with this name, if given); later ones are named boards.
    if (body.name && actor.kind === "human" && boards.ownedBoards(ctx, actor.id).length > 0) return c.json({ board: boards.createNamedBoard(ctx, actor, body.name) });
    const row = boards.ensureOwnBoard(ctx, actor, { create: true, ...(body.name ? { name: body.name } : {}) });
    if (!row) throw invalid("Only people can own boards");
    return c.json({ board: presentBoard(ctx, row, getMembership(ctx, row.id, actor.id)!) });
  });
  app.get("/api/boards/:boardId", (c) => c.json(boards.getBoard(ctx, requireActor(c), c.req.param("boardId"))));
  app.patch("/api/boards/:boardId", async (c) => c.json(boards.updateBoard(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, UpdateBoardBody))));
  app.delete("/api/boards/:boardId", async (c) => {
    const body = await parseBody(c, DeleteBoardBody);
    boards.deleteBoard(ctx, requireActor(c), c.req.param("boardId"), body.confirm_name);
    return c.json({ deleted: true });
  });

  // threads and messages
  app.get("/api/boards/:boardId/threads", (c) => {
    const q = c.req.query();
    const filter = z.enum(["all", "following", "unread"]).optional().parse(q.filter || undefined);
    const kind = z.enum(THREAD_KINDS).optional().parse(q.kind || undefined);
    const taskState = z.enum(TASK_STATES).optional().parse(q.task_state || undefined);
    return c.json(
      convo.listThreads(ctx, requireActor(c), c.req.param("boardId"), {
        channel: ChannelFilter.optional().parse(q.channel || undefined),
        filter,
        kind,
        task_state: taskState,
        assignee: q.assignee || undefined,
        labels: labelsFromQuery(c.req.queries("label") ?? []),
        page_cursor: q.page_cursor || undefined,
        limit: int(q.limit),
      }),
    );
  });
  app.post("/api/boards/:boardId/threads", async (c) => c.json(convo.startThread(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, StartThreadBody))));
  app.get("/api/threads/:threadId", (c) =>
    c.json(convo.getThread(ctx, requireActor(c), c.req.param("threadId"), { page_cursor: c.req.query("page_cursor") || undefined, limit: int(c.req.query("limit")) })),
  );
  app.post("/api/threads/:threadId/messages", async (c) => c.json(convo.reply(ctx, requireActor(c), c.req.param("threadId"), await parseBody(c, ReplyBody))));
  app.delete("/api/messages/:messageId", (c) => c.json(convo.deleteMessage(ctx, requireActor(c), c.req.param("messageId"))));
  app.put("/api/threads/:threadId/follow", async (c) => c.json(convo.setFollow(ctx, requireActor(c), c.req.param("threadId"), (await parseBody(c, FollowBody)).following)));
  app.post("/api/threads/:threadId/labels", async (c) => c.json(convo.setLabels(ctx, requireActor(c), c.req.param("threadId"), await parseBody(c, LabelsBody))));
  app.post("/api/threads/:threadId/task", async (c) => c.json(convo.updateTask(ctx, requireActor(c), c.req.param("threadId"), await parseBody(c, UpdateTaskBody))));
  app.post("/api/boards/:boardId/tasks/claim", async (c) => {
    const body = await parseBody(c, ClaimTaskBody);
    const input = body.thread_id ? { thread_id: body.thread_id } : { board_id: c.req.param("boardId"), labels: body.labels };
    return c.json(convo.claimTask(ctx, requireActor(c), input));
  });

  // inbox and changes
  app.get("/api/inbox", (c) =>
    c.json(
      changes.getInbox(ctx, requireActor(c), {
        unread_only: c.req.query("unread_only") === "true",
        board_id: c.req.query("board_id") || undefined,
        page_cursor: c.req.query("page_cursor") || undefined,
        limit: int(c.req.query("limit")),
      }),
    ),
  );
  app.post("/api/inbox/read", async (c) => c.json(changes.markRead(ctx, requireActor(c), await parseBody(c, MarkReadBody))));
  app.get("/api/boards/:boardId/changes", (c) =>
    c.json(
      changes.boardChanges(ctx, requireActor(c), c.req.param("boardId"), c.req.query("cursor") || undefined, int(c.req.query("limit")) ?? 100, undefined, ChannelFilter.optional().parse(c.req.query("channel") || undefined)),
    ),
  );
  app.get("/api/boards/:boardId/stream", (c) => boardStream(ctx, c, requireActor(c), c.req.param("boardId")));
  app.get("/api/inbox/stream", (c) => inboxStream(ctx, c, requireActor(c)));
  app.get("/api/boards/:boardId/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(usage.searchMessages(ctx, requireActor(c), c.req.param("boardId"), q, int(c.req.query("limit")) ?? 20, ChannelFilter.optional().parse(c.req.query("channel") || undefined)));
  });

  // members, invites, agents, tokens
  app.get("/api/boards/:boardId/members", (c) => c.json({ members: boards.listMembers(ctx, requireActor(c), c.req.param("boardId")) }));
  app.patch("/api/boards/:boardId/members/:principalId", async (c) =>
    c.json({ member: boards.updateMember(ctx, requireActor(c), c.req.param("boardId"), c.req.param("principalId"), await parseBody(c, UpdateMemberBody)) }),
  );
  app.delete("/api/boards/:boardId/members/:principalId", (c) => {
    boards.removeMember(ctx, requireActor(c), c.req.param("boardId"), c.req.param("principalId"));
    return c.json({ removed: true });
  });
  app.get("/api/boards/:boardId/invites", (c) => c.json({ invites: invites.listInvites(ctx, requireActor(c), c.req.param("boardId")) }));
  app.post("/api/boards/:boardId/invites", async (c) => c.json({ invite: invites.createInvite(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, CreateInviteBody)) }));
  app.delete("/api/invites/:inviteId", (c) => c.json({ invite: invites.disableInvite(ctx, requireActor(c), c.req.param("inviteId")) }));
  app.get("/api/invite-links/:token", (c) => c.json(invites.previewInvite(ctx, c.req.param("token"))));
  app.post("/api/invite-links/:token/redeem", (c) => c.json({ board: invites.redeemInvite(ctx, requireActor(c), c.req.param("token")) }));
  app.get("/api/agents", (c) => c.json({ agents: boards.listAgents(ctx, requireActor(c)) }));
  app.post("/api/agents", async (c) => c.json({ agent: boards.createAgent(ctx, requireActor(c), (await parseBody(c, CreateAgentBody)).display_name) }));
  app.delete("/api/agents/:agentId", (c) => c.json({ agent: boards.disableAgent(ctx, requireActor(c), c.req.param("agentId")) }));
  app.post("/api/agents/:agentId/tokens", async (c) => {
    const body = await parseBody(c, CreateTokenBody).catch(() => ({ label: undefined }));
    return c.json(boards.createAgentToken(ctx, requireActor(c), c.req.param("agentId"), body.label));
  });
  app.delete("/api/agents/:agentId/tokens/:tokenId", (c) => {
    boards.revokeAgentToken(ctx, requireActor(c), c.req.param("agentId"), c.req.param("tokenId"));
    return c.json({ revoked: true });
  });
  app.post("/api/boards/:boardId/agents", async (c) => {
    const body = await parseBody(c, AddAgentToBoardBody);
    return c.json({ member: boards.addAgentToBoard(ctx, requireActor(c), c.req.param("boardId"), body.agent_id, body.role) });
  });
  app.get("/api/tokens", (c) => c.json({ tokens: boards.listPersonalTokens(ctx, requireActor(c)) }));
  app.post("/api/tokens", async (c) => {
    const body = await parseBody(c, CreateTokenBody).catch(() => ({ label: undefined }));
    return c.json(boards.createPersonalToken(ctx, requireActor(c), body.label));
  });
  app.delete("/api/tokens/:tokenId", (c) => {
    boards.revokePersonalToken(ctx, requireActor(c), c.req.param("tokenId"));
    return c.json({ revoked: true });
  });

  // usage and portability
  app.get("/api/boards/:boardId/usage", (c) => c.json(usage.getUsage(ctx, requireActor(c), c.req.param("boardId"))));
  app.get("/api/boards/:boardId/export", (c) => {
    const file = portability.exportBoard(ctx, requireActor(c), c.req.param("boardId"));
    const name = file.board.name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "board";
    c.header("Content-Disposition", `attachment; filename="${name}.omb.json"`);
    return c.json(file);
  });
  app.post("/api/import", async (c) => {
    const actor = requireActor(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw invalid("Upload an export file (JSON)");
    }
    return c.json({ board: portability.importBoard(ctx, actor, body, { name: c.req.query("name") || undefined }) });
  });

  // test mode: sign-in codes that would have been emailed
  app.get("/api/test/outbox", (c) => {
    if (!ctx.config.testMode) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    const email = (c.req.query("email") ?? "").toLowerCase();
    const rows = ctx.db.prepare("SELECT email, subject, code, created_at FROM test_outbox WHERE email = ? ORDER BY id DESC LIMIT 10").all(email);
    return c.json({ messages: rows });
  });
}
