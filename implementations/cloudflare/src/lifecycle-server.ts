// The server object's half of the board lifecycle: the facts about a board (lifecycle.ts asks for them), the one
// transaction that deactivates or reactivates it, and the extension's routes.
// Types only: the core is loaded with a dynamic import (server.ts), so nothing here may import it statically.
import type { AppContext, ExtensionModule, Migration } from "@openmessageboard/core";
import { LIFECYCLE_EXTENSION_ID, checkLinkToken, type BoardSnapshot, type LifecycleSettings, type LinkAction } from "./lifecycle.js";

export const LIFECYCLE_MIGRATION: Migration = {
  name: "cf_0005_board_lifecycle",
  sql: `CREATE TABLE IF NOT EXISTS cf_board_lifecycle (
  board_id TEXT PRIMARY KEY,
  -- The settings this board's lifecycle object was last told about. NULL: it needs a nudge.
  synced_with TEXT,
  -- The owner asked to keep the board active, or reactivated it.
  kept_at TEXT,
  -- Set while the board is deactivated for inactivity (boards.disabled_at carries the effect).
  deactivated_at TEXT
);
CREATE TABLE IF NOT EXISTS cf_owner_seen (principal_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL);`,
};

/** What this module needs from the core, passed in because the core is loaded dynamically. */
export interface LifecycleCore {
  exportBoard(ctx: AppContext, actor: never, boardId: string): unknown;
  limitsFor(ctx: AppContext, principalId: string): { boards_owned: number };
  /** The core's error for a tool to throw (`OmbError`). */
  error(code: "not_found" | "forbidden" | "quota_exceeded", message: string): Error;
}

interface BoardFacts {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  disabled_at: string | null;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const latest = (...times: (string | null)[]): string => times.filter((t): t is string => !!t).sort().at(-1)!;

/**
 * When the board's owner last signed in: the newest session, and what earlier sessions left in `cf_owner_seen`.
 * Sessions are matched by verified address, as the core does when it resolves one (`ensureHuman`).
 */
function ownerSeenAt(ctx: AppContext, ownerId: string): string | null {
  const seen = (ctx.db.prepare("SELECT seen_at FROM cf_owner_seen WHERE principal_id = ?").get(ownerId) as { seen_at: string } | undefined)?.seen_at ?? null;
  let session: string | null = null;
  try {
    const row = ctx.db.prepare(`SELECT MAX(s."createdAt") AS t FROM "session" s JOIN "user" u ON u."id" = s."userId" JOIN principals p ON p.email = lower(u."email") AND p.kind = 'human' WHERE p.id = ?`).get(ownerId) as { t: unknown } | undefined;
    session = iso(row?.t);
  } catch {
    /* no sign-in tables yet */
  }
  return seen || session ? latest(seen, session) : null;
}

/**
 * Remembers the sign-ins of the last few minutes, so one still counts after its session row is gone (signing out
 * deletes it). The server object calls this after a sign-in request.
 */
export function recordSignIns(ctx: AppContext, windowMs = 10 * 60_000): void {
  try {
    const rows = ctx.db.prepare(`SELECT p.id AS id, s."createdAt" AS t FROM "session" s JOIN "user" u ON u."id" = s."userId" JOIN principals p ON p.email = lower(u."email") AND p.kind = 'human' ORDER BY s."createdAt" DESC LIMIT 20`).all() as { id: string; t: unknown }[];
    const since = ctx.now().getTime() - windowMs;
    for (const r of rows) {
      const at = iso(r.t);
      if (!at || Date.parse(at) < since) continue;
      ctx.db.prepare("INSERT INTO cf_owner_seen (principal_id, seen_at) VALUES (?, ?) ON CONFLICT(principal_id) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)").run(r.id, at);
    }
  } catch {
    /* no sign-in tables yet */
  }
}

/** Activity is a post on the board or its owner signing in (or asking to keep it). Reads by others don't count. */
export function boardSnapshot(ctx: AppContext, boardId: string): BoardSnapshot {
  const board = ctx.db.prepare("SELECT id, name, owner_id, created_at, disabled_at FROM boards WHERE id = ?").get(boardId) as BoardFacts | undefined;
  if (!board) {
    ctx.db.prepare("DELETE FROM cf_board_lifecycle WHERE board_id = ?").run(boardId);
    return { board_id: boardId, exists: false, name: "", owner_email: null, active_at: new Date(0).toISOString(), deactivated_at: null, disabled: false };
  }
  const life = ctx.db.prepare("SELECT kept_at, deactivated_at FROM cf_board_lifecycle WHERE board_id = ?").get(boardId) as { kept_at: string | null; deactivated_at: string | null } | undefined;
  const owner = ctx.db.prepare("SELECT email, disabled_at FROM principals WHERE id = ?").get(board.owner_id) as { email: string | null; disabled_at: string | null } | undefined;
  const post = (ctx.db.prepare("SELECT MAX(last_activity_at) AS t FROM threads WHERE board_id = ?").get(boardId) as { t: string | null } | undefined)?.t ?? null;
  const deactivated = board.disabled_at && life?.deactivated_at ? life.deactivated_at : null;
  return {
    board_id: boardId,
    exists: true,
    name: board.name,
    owner_email: owner && !owner.disabled_at ? owner.email : null,
    active_at: latest(board.created_at, post, life?.kept_at ?? null, ownerSeenAt(ctx, board.owner_id)),
    deactivated_at: deactivated,
    disabled: !!board.disabled_at && !deactivated,
  };
}

/**
 * Deactivates a board that is still inactive, in one transaction with the check. Deactivated is the core's disabled
 * state (`boards.disabled_at`): the board answers `not_found` to everyone, leaves every list, takes no posts, its
 * live channels close, and its watchers stop with `board_disabled`. Nothing is deleted.
 */
export function deactivateIfInactive(ctx: AppContext, settings: LifecycleSettings, boardId: string): BoardSnapshot {
  const done = ctx.db.transaction(() => {
    const snap = boardSnapshot(ctx, boardId);
    if (!snap.exists || snap.disabled || snap.deactivated_at) return false;
    const now = ctx.now();
    if (now.getTime() < Date.parse(snap.active_at) + settings.inactiveMs) return false;
    const at = now.toISOString();
    ctx.db.prepare("UPDATE boards SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(at, boardId);
    ctx.db.prepare("INSERT INTO cf_board_lifecycle (board_id, deactivated_at) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET deactivated_at = excluded.deactivated_at").run(boardId, at);
    return true;
  })();
  if (done) ctx.connections.closeFor(boardId, null, "disabled");
  return boardSnapshot(ctx, boardId);
}

export type Outcome = { ok: true } | { ok: false; code: "not_found" | "quota_exceeded"; message: string };

/** Records that the owner wants the board kept. Its lifecycle object is marked for a nudge. */
export function keepBoard(ctx: AppContext, boardId: string): Outcome {
  const snap = boardSnapshot(ctx, boardId);
  if (!snap.exists || snap.disabled) return { ok: false, code: "not_found", message: "Board not found" };
  if (snap.deactivated_at) return { ok: false, code: "not_found", message: "This board is deactivated. Reactivate it first." };
  ctx.db
    .prepare("INSERT INTO cf_board_lifecycle (board_id, kept_at, synced_with) VALUES (?, ?, NULL) ON CONFLICT(board_id) DO UPDATE SET kept_at = excluded.kept_at, synced_with = NULL")
    .run(boardId, ctx.now().toISOString());
  return { ok: true };
}

/** Brings back a board that was deactivated for inactivity, if its owner's plan still has room for it. */
export function reactivateBoard(ctx: AppContext, core: LifecycleCore, boardId: string): Outcome {
  return ctx.db.transaction((): Outcome => {
    const snap = boardSnapshot(ctx, boardId);
    if (!snap.exists || snap.disabled) return { ok: false, code: "not_found", message: "Board not found" };
    if (!snap.deactivated_at) return { ok: true };
    const { owner_id } = ctx.db.prepare("SELECT owner_id FROM boards WHERE id = ?").get(boardId) as { owner_id: string };
    const owned = (ctx.db.prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_id = ? AND disabled_at IS NULL").get(owner_id) as { n: number }).n;
    const limit = core.limitsFor(ctx, owner_id).boards_owned;
    if (owned >= limit) return { ok: false, code: "quota_exceeded", message: `You own ${owned} of the ${limit} board(s) your plan allows. Delete one to reactivate this board.` };
    ctx.db.prepare("UPDATE boards SET disabled_at = NULL WHERE id = ?").run(boardId);
    ctx.db.prepare("UPDATE cf_board_lifecycle SET deactivated_at = NULL, kept_at = ?, synced_with = NULL WHERE board_id = ?").run(ctx.now().toISOString(), boardId);
    return { ok: true };
  })();
}

/** Boards whose lifecycle object hasn't been told about the current settings (new boards, a nudge that failed). */
export function unsyncedBoards(ctx: AppContext, fingerprint: string, limit: number): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT b.id FROM boards b LEFT JOIN cf_board_lifecycle l ON l.board_id = b.id
       WHERE (b.disabled_at IS NULL OR l.deactivated_at IS NOT NULL) AND (l.board_id IS NULL OR l.synced_with IS NOT ?) LIMIT ?`,
    )
    .all(fingerprint, limit) as { id: string }[];
  return rows.map((r) => r.id);
}

export function isSynced(ctx: AppContext, boardId: string, fingerprint: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM cf_board_lifecycle WHERE board_id = ? AND synced_with = ?").get(boardId, fingerprint);
}

export function markSynced(ctx: AppContext, boardId: string, fingerprint: string): void {
  ctx.db.prepare("INSERT INTO cf_board_lifecycle (board_id, synced_with) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET synced_with = excluded.synced_with").run(boardId, fingerprint);
}

// ---------- routes ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a1a1a;background:#fff}button{font:inherit;padding:.6rem 1.1rem;border:0;border-radius:.4rem;background:#1a1a1a;color:#fff;cursor:pointer}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

type Caller = { id: string; kind: string; ownerId?: string | null; profile?: string | null; scope?: unknown };
type Refusal = "unauthenticated" | "forbidden" | "not_found";
const REFUSALS: Record<Refusal, string> = {
  unauthenticated: "Sign in or send a bearer token",
  forbidden: "Only the board's owner, or a profile acting for them, can do this",
  not_found: "Board not found",
};

/**
 * The person a caller speaks for in lifecycle matters: themselves, or for a profile its person (a profile acts with
 * its person's access). An agent of its own is a separate member and a scoped token is limited on purpose: neither
 * has a say over whether a board exists.
 */
function personOf(actor: Caller): string | null {
  if (actor.scope) return null;
  if (actor.profile) return actor.ownerId ?? null;
  return actor.kind === "human" ? actor.id : null;
}

/** Why this caller may not act on this board, or null. Anyone but the owner gets `not_found`, as for any board they can't see. */
function whyNot(ctx: AppContext, actor: Caller | null, boardId: string): Refusal | null {
  if (!actor) return "unauthenticated";
  const person = personOf(actor);
  if (!person) return "forbidden";
  const row = ctx.db.prepare("SELECT owner_id FROM boards WHERE id = ?").get(boardId) as { owner_id: string } | undefined;
  return row && row.owner_id === person && !boardSnapshot(ctx, boardId).disabled ? null : "not_found";
}

const inDays = (ms: number) => Math.round((ms / 86_400_000) * 1000) / 1000;

function boardView(ctx: AppContext, settings: LifecycleSettings, boardId: string) {
  const s = boardSnapshot(ctx, boardId);
  return {
    id: s.board_id,
    name: s.name,
    state: s.deactivated_at ? "deactivated" : "active",
    active_at: s.active_at,
    // The earliest it can happen: a board always gets its reminders first, which can move this later.
    deactivates_at: s.deactivated_at ? null : new Date(Date.parse(s.active_at) + settings.inactiveMs).toISOString(),
    deactivated_at: s.deactivated_at,
  };
}

/** A person's own boards, the deactivated ones included. Board names are member content, returned as data. */
function ownBoards(ctx: AppContext, settings: LifecycleSettings, person: string) {
  const rows = ctx.db
    .prepare("SELECT b.id FROM boards b LEFT JOIN cf_board_lifecycle l ON l.board_id = b.id WHERE b.owner_id = ? AND (b.disabled_at IS NULL OR l.deactivated_at IS NOT NULL) ORDER BY b.created_at")
    .all(person) as { id: string }[];
  return { inactive_days: inDays(settings.inactiveMs), reminder_days: settings.reminderMs.map(inDays), boards: rows.map((r) => boardView(ctx, settings, r.id)) };
}

export interface LifecycleExtensionOptions {
  settings: LifecycleSettings;
  core: LifecycleCore;
  /** Tells a board's lifecycle object to look again now. Failures are retried by the server object. */
  nudge(boardId: string): Promise<void>;
}

/**
 * `openmessageboard.cloudflare/lifecycle`: boards with no activity are deactivated after reminders to their owner.
 * The links in those emails open a page with one button; the button is a POST, so a mail scanner that follows
 * links changes nothing. A link is a signed token for one action on one board and gives no access to content.
 */
export function lifecycleExtension(opts: LifecycleExtensionOptions): ExtensionModule {
  const { settings, core, nudge } = opts;
  const days = inDays;
  return {
    id: LIFECYCLE_EXTENSION_ID,
    info: {
      version: "0.1.0",
      description: `Boards with no post and no owner sign-in for ${days(settings.inactiveMs)} days are deactivated, after reminder emails to the owner. Nothing is deleted, and the owner can reactivate the board.`,
    },
    // For agents and the CLI (`omb call`): the same three actions as the routes, under the same rule. They need
    // `manage`, which no scoped token has. Descriptions are fixed server text; results carry the caller's own boards.
    tools: (z) => {
      const boardId = z.object({ board_id: z.string().describe("The board's ID, as lifecycle_boards lists it") });
      const mine = (ctx: AppContext, actor: Caller, id: string) => {
        const why = whyNot(ctx, actor, id);
        if (why) throw core.error(why === "unauthenticated" ? "forbidden" : why, REFUSALS[why]);
      };
      const act = async (ctx: AppContext, actor: Caller, action: LinkAction, id: string) => {
        mine(ctx, actor, id);
        const out = action === "keep" ? keepBoard(ctx, id) : reactivateBoard(ctx, core, id);
        if (!out.ok) throw core.error(out.code, out.message);
        await nudge(id).catch(() => {});
        return { board: boardView(ctx, settings, id) };
      };
      return [
        {
          name: "lifecycle_boards",
          description:
            "List the boards your person owns with their inactivity state: active or deactivated, the last activity, and when an active board would be deactivated. Deactivated boards appear only here: the other tools answer not_found for them until they are reactivated. Only the owner, or a profile acting for them, may call this.",
          input: z.object({}),
          scope: "manage",
          readOnly: true,
          handler(ctx, actor) {
            const person = personOf(actor as Caller);
            if (!person) throw core.error("forbidden", REFUSALS.forbidden);
            return ownBoards(ctx, settings, person);
          },
        },
        {
          name: "lifecycle_keep",
          description: "Keep an active board from being deactivated for inactivity: the inactivity period starts again now. Only the board's owner, or a profile acting for them, may call this. Call it when the owner asks for it.",
          input: boardId,
          scope: "manage",
          readOnly: false,
          handler: (ctx, actor, args) => act(ctx, actor as Caller, "keep", String(args.board_id)),
        },
        {
          name: "lifecycle_reactivate",
          description:
            "Reactivate a board that was deactivated for inactivity. Its messages and members were kept and are available again at once. Fails with quota_exceeded if the owner's plan has no room for the board. Only the board's owner, or a profile acting for them, may call this. Call it when the owner asks for it.",
          input: boardId,
          scope: "manage",
          readOnly: false,
          handler: (ctx, actor, args) => act(ctx, actor as Caller, "reactivate", String(args.board_id)),
        },
      ];
    },
    register(app, ctx) {
      const base = ctx.config.publicUrl.replace(/\/$/, "");
      const run = async (action: LinkAction, boardId: string): Promise<Outcome> => {
        const out = action === "keep" ? keepBoard(ctx, boardId) : reactivateBoard(ctx, core, boardId);
        if (out.ok) await nudge(boardId).catch(() => {});
        return out;
      };

      // The links in the emails. GET shows the button and changes nothing; POST does it.
      for (const action of ["keep", "reactivate"] as const) {
        const verb = action === "keep" ? "Keep this board active" : "Reactivate this board";
        const expired = () => page("This link no longer works", `<p>Sign in at <a href="${esc(base)}/">${esc(base)}</a> to manage your board.</p>`, 400);
        app.get(`/x/lifecycle/${action}`, async (c) => {
          const boardId = c.req.query("board") ?? "";
          const token = c.req.query("t") ?? "";
          if (!(await checkLinkToken(ctx.config.secret, action, boardId, token, ctx.now().getTime()))) return expired();
          const snap = boardSnapshot(ctx, boardId);
          if (!snap.exists || snap.disabled) return expired();
          return page(
            verb,
            `<p>${esc(snap.name)}</p><form method="post" action="/x/lifecycle/${action}"><input type="hidden" name="board" value="${esc(boardId)}"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">${esc(verb)}</button></form>`,
          );
        });
        app.post(`/x/lifecycle/${action}`, async (c) => {
          const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
          const boardId = typeof form.board === "string" ? form.board : "";
          const token = typeof form.t === "string" ? form.t : "";
          if (!(await checkLinkToken(ctx.config.secret, action, boardId, token, ctx.now().getTime()))) return expired();
          const out = await run(action, boardId);
          if (!out.ok) return page(out.code === "quota_exceeded" ? "This board can't be reactivated yet" : "This link no longer works", `<p>${esc(out.message)}</p>`, out.code === "quota_exceeded" ? 409 : 400);
          return page(action === "keep" ? "Your board stays active" : "Your board is active again", `<p>${esc(boardSnapshot(ctx, boardId).name)}</p><p><a href="${esc(base)}/">Open ${esc(base)}</a></p>`);
        });
      }

      const ownerOf = (c: { get(key: "actor"): Caller | null }, boardId: string) => whyNot(ctx, c.get("actor"), boardId);
      const refuse = (c: { json(body: unknown, status: 401 | 403 | 404): Response }, why: Refusal) => c.json({ error: { code: why, message: REFUSALS[why] } }, why === "unauthenticated" ? 401 : why === "forbidden" ? 403 : 404);
      const view = (boardId: string) => boardView(ctx, settings, boardId);

      app.get("/x/lifecycle/boards", (c) => {
        const actor = c.get("actor");
        if (!actor) return refuse(c, "unauthenticated");
        const person = personOf(actor);
        if (!person) return refuse(c, "forbidden");
        return c.json(ownBoards(ctx, settings, person));
      });
      for (const action of ["keep", "reactivate"] as const) {
        app.post(`/x/lifecycle/boards/:boardId/${action}`, async (c) => {
          const boardId = c.req.param("boardId");
          const why = ownerOf(c, boardId);
          if (why) return refuse(c, why);
          const out = await run(action, boardId);
          if (!out.ok) return c.json({ error: { code: out.code, message: out.message } }, out.code === "quota_exceeded" ? 429 : 404);
          return c.json({ board: view(boardId) });
        });
      }
      // The export a deactivated board still offers its owner: the core's export, read while the board stays
      // deactivated for everyone else (the transaction is rolled back, and nothing else runs inside it).
      app.get("/x/lifecycle/boards/:boardId/export", (c) => {
        const boardId = c.req.param("boardId");
        const why = ownerOf(c, boardId);
        if (why) return refuse(c, why);
        const actor = c.get("actor")!;
        let file: unknown;
        const rollback = new Error("rollback");
        try {
          ctx.db.transaction(() => {
            ctx.db.prepare("UPDATE boards SET disabled_at = NULL WHERE id = ?").run(boardId);
            file = core.exportBoard(ctx, actor as never, boardId);
            throw rollback;
          })();
        } catch (e) {
          if (e !== rollback) throw e;
        }
        c.header("Content-Disposition", `attachment; filename="board-${boardId}.json"`);
        return c.json(file as Record<string, unknown>);
      });
    },
  };
}
