// Types only: the core is loaded with a dynamic import (server.ts), so nothing here may import it statically.
import type { AppContext, ExtensionModule, Mailer } from "@openmessageboard/core";

/**
 * Claimed board names (`openmessageboard.cloudflare/names`). A board's owner claims a short name that is unique on
 * this server; `<server>/<name>` then leads to the board, as an alias of its ID address. The ID stays the
 * identifier everywhere else. A name is an address and never grants access.
 *
 * A name is released after a period with no activity (a post on the board, or the owner opening the board's name
 * settings in a signed-in browser, or pressing Keep). The board, its content and its members are untouched: only
 * the alias goes. For a while after a release, and after a rename, only the same owner can take the name again.
 */
export const NAMES_EXTENSION_ID = "openmessageboard.cloudflare/names";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NAME_MIN = 3;
export const NAME_MAX = 32;
/** A letter first, then letters, digits and single hyphens between them. */
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Names nobody can claim: every first path segment the server or its web client uses or may use, and names that
 * would mislead people about who runs a board. Operators add more with OMB_NAMES_RESERVED.
 */
export const RESERVED_NAMES: readonly string[] = [
  // Server and web client paths (packages/core/src/http/paths.ts, web/src/router.tsx).
  "api", "mcp", "hooks", "healthz", "metrics", "oauth", "well-known", "signin", "agents", "assets", "favicon", "robots", "sitemap", "index", "static",
  // Likely future paths.
  "signup", "signout", "login", "logout", "register", "account", "accounts", "settings", "inbox", "invite", "invites", "board", "boards", "thread", "threads",
  "name", "names", "new", "join", "search", "explore", "public", "user", "users", "people", "member", "members", "profile", "profiles", "channel", "channels",
  "task", "tasks", "events", "webhook", "webhooks", "export", "import", "sync", "billing", "plans", "pricing", "upgrade", "dashboard", "home", "app", "apps",
  "www", "web", "cdn", "mail", "email", "smtp", "ftp", "dns", "ssl",
  // The project and its operator.
  "omb", "openmessageboard", "open-message-board", "messageboard", "spec", "specification", "docs", "documentation", "blog", "news", "newsletter", "about",
  "admin", "administrator", "root", "system", "operator", "staff", "official", "moderator", "owner", "support", "help", "contact", "feedback", "status",
  "security", "abuse", "legal", "terms", "privacy", "tos", "dmca", "trust", "safety", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply",
  // Values that read as placeholders.
  "null", "undefined", "none", "test", "example", "default", "anonymous", "unknown", "everyone", "all", "here",
];

export interface NamesOptions {
  /** A name is released after this many days with no activity. */
  inactiveDays: number;
  /** After a release or a rename, only the same owner can take the name for this many days. */
  holdDays: number;
  reserved: ReadonlySet<string>;
}

/** Reads OMB_NAMES (on or off), OMB_NAMES_INACTIVE_DAYS, OMB_NAMES_HOLD_DAYS and OMB_NAMES_RESERVED. Null when the extension is off. */
export function namesOptions(vars: Record<string, string | undefined>): NamesOptions | null {
  if (!["1", "true", "yes", "on"].includes((vars.OMB_NAMES ?? "").toLowerCase())) return null;
  const days = (name: string, fallback: number) => {
    const raw = vars[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of days`);
    return n;
  };
  const extra = (vars.OMB_NAMES_RESERVED ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { inactiveDays: days("OMB_NAMES_INACTIVE_DAYS", 180), holdDays: days("OMB_NAMES_HOLD_DAYS", 30), reserved: new Set([...RESERVED_NAMES, ...extra]) };
}

/** Tables for this extension, in the implementation's own migrations. */
export const NAMES_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS cf_board_names (
  name TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  -- The person who claimed it: the only one who can take it back while it is held or released.
  owner_id TEXT NOT NULL,
  -- active: the board's name. held: its previous name after a rename; still leads to the board until ends_at.
  -- released: let go or expired; leads nowhere, and only owner_id can claim it until ends_at.
  state TEXT NOT NULL CHECK (state IN ('active', 'held', 'released')),
  claimed_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  -- 0: no warning sent since the last activity. 1: the 30-day warning. 2: the 7-day warning.
  warned_stage INTEGER NOT NULL DEFAULT 0,
  ends_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS cf_board_names_active ON cf_board_names(board_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS cf_board_names_board ON cf_board_names(board_id);
`;

/** The part of the core's database handle this extension uses (positional parameters only). */
export interface NamesDb {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
}

interface NameRow {
  name: string;
  board_id: string;
  owner_id: string;
  state: "active" | "held" | "released";
  claimed_at: string;
  last_active_at: string;
  warned_stage: number;
  ends_at: string | null;
}

export class NameError extends Error {
  constructor(
    public readonly code: "invalid_argument" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

/** Why a name can't be used, or null. The same wording for every reserved name: the list is not a secret, but it is long. */
export function nameProblem(name: unknown, reserved: ReadonlySet<string>): string | null {
  if (typeof name !== "string") return "name must be a string";
  if (name.length < NAME_MIN || name.length > NAME_MAX) return `A name has ${NAME_MIN} to ${NAME_MAX} characters`;
  if (!NAME_RE.test(name)) return "A name starts with a letter and uses lowercase letters, digits and single hyphens between them";
  if (reserved.has(name)) return "That name is reserved";
  return null;
}

export interface BoardNameState {
  /** The board's name, or null. */
  name: string | null;
  /** When the name is released if nothing happens until then. */
  releases_at: string | null;
  /** Earlier names that still lead here after a rename, until the date. */
  held: { name: string; until: string }[];
  /** Names this board let go that its owner can still take back, until the date. */
  released: { name: string; until: string }[];
}

export interface NameNotice {
  to: string;
  subject: string;
  text: string;
}

/** The rules, over the server's own database. Synchronous, like every write in the core. */
export class BoardNames {
  constructor(
    private readonly db: NamesDb,
    private readonly opts: NamesOptions,
    private readonly publicUrl: string,
  ) {}

  private row(name: string, now: Date): NameRow | undefined {
    const row = this.db.prepare("SELECT * FROM cf_board_names WHERE name = ?").get(name) as NameRow | undefined;
    if (row && row.state !== "active" && row.ends_at !== null && row.ends_at <= now.toISOString()) {
      this.db.prepare("DELETE FROM cf_board_names WHERE name = ? AND state != 'active'").run(name);
      return undefined;
    }
    return row;
  }

  private active(boardId: string): NameRow | undefined {
    return this.db.prepare("SELECT * FROM cf_board_names WHERE board_id = ? AND state = 'active'").get(boardId) as NameRow | undefined;
  }

  private after(now: Date, days: number): string {
    return new Date(now.getTime() + days * DAY_MS).toISOString();
  }

  /** The board a name leads to: its current name, or a previous one still held after a rename. */
  resolve(name: string, now: Date): string | null {
    if (nameProblem(name, this.opts.reserved)) return null;
    const row = this.row(name, now);
    return row && row.state !== "released" ? row.board_id : null;
  }

  /** The latest activity that keeps a name: what is recorded, or a later post on the board. */
  private activity(row: NameRow): string {
    const posted = (this.db.prepare("SELECT MAX(last_activity_at) AS t FROM threads WHERE board_id = ?").get(row.board_id) as { t: string | null } | undefined)?.t;
    return posted && posted > row.last_active_at ? posted : row.last_active_at;
  }

  state(boardId: string, now: Date): BoardNameState {
    const rows = (this.db.prepare("SELECT * FROM cf_board_names WHERE board_id = ? ORDER BY name").all(boardId) as NameRow[]).filter(
      (r) => r.state === "active" || (r.ends_at !== null && r.ends_at > now.toISOString()),
    );
    const active = rows.find((r) => r.state === "active");
    return {
      name: active?.name ?? null,
      releases_at: active ? new Date(Date.parse(this.activity(active)) + this.opts.inactiveDays * DAY_MS).toISOString() : null,
      held: rows.filter((r) => r.state === "held").map((r) => ({ name: r.name, until: r.ends_at! })),
      released: rows.filter((r) => r.state === "released").map((r) => ({ name: r.name, until: r.ends_at! })),
    };
  }

  /**
   * Gives the board this name. A name another board holds, or one someone else let go recently, is refused with
   * the same words. The board's previous name is held for it: it keeps leading here, and can be taken back.
   */
  claim(boardId: string, ownerId: string, name: unknown, now: Date): void {
    const problem = nameProblem(name, this.opts.reserved);
    if (problem) throw new NameError("invalid_argument", problem);
    const wanted = name as string;
    const existing = this.row(wanted, now);
    if (existing) {
      if (existing.state === "active" && existing.board_id === boardId) return;
      const ownHeld = existing.state === "held" && existing.board_id === boardId;
      const ownReleased = existing.state === "released" && existing.owner_id === ownerId;
      if (!ownHeld && !ownReleased) throw new NameError("conflict", "That name is taken");
    }
    const at = now.toISOString();
    this.db.prepare("UPDATE cf_board_names SET state = 'held', ends_at = ?, warned_stage = 0 WHERE board_id = ? AND state = 'active'").run(this.after(now, this.opts.holdDays), boardId);
    this.db
      .prepare(
        `INSERT INTO cf_board_names (name, board_id, owner_id, state, claimed_at, last_active_at, warned_stage, ends_at) VALUES (?, ?, ?, 'active', ?, ?, 0, NULL)
         ON CONFLICT(name) DO UPDATE SET board_id = excluded.board_id, owner_id = excluded.owner_id, state = 'active', claimed_at = excluded.claimed_at,
           last_active_at = excluded.last_active_at, warned_stage = 0, ends_at = NULL`,
      )
      .run(wanted, boardId, ownerId, at, at);
  }

  /** Lets the board's name go. Its owner can take it back during the hold; nobody else can. */
  release(boardId: string, now: Date): void {
    this.db.prepare("UPDATE cf_board_names SET state = 'released', ends_at = ?, warned_stage = 0 WHERE board_id = ? AND state = 'active'").run(this.after(now, this.opts.holdDays), boardId);
  }

  /** Records activity by the owner, which restarts the clock. */
  keep(boardId: string, now: Date): void {
    this.db.prepare("UPDATE cf_board_names SET last_active_at = ?, warned_stage = 0 WHERE board_id = ? AND state = 'active'").run(now.toISOString(), boardId);
  }

  /**
   * Housekeeping: forgets holds that ended, releases names with no activity for the whole period, and returns the
   * emails to send (30 and 7 days before a release, and at the release). Only names near their release are read.
   */
  sweep(now: Date): NameNotice[] {
    const at = now.toISOString();
    const notices: NameNotice[] = [];
    this.db.prepare("DELETE FROM cf_board_names WHERE state != 'active' AND ends_at IS NOT NULL AND ends_at <= ?").run(at);
    const cutoff = new Date(now.getTime() - Math.max(0, this.opts.inactiveDays - 30) * DAY_MS).toISOString();
    const due = this.db.prepare("SELECT * FROM cf_board_names WHERE state = 'active' AND last_active_at <= ? ORDER BY last_active_at LIMIT 500").all(cutoff) as NameRow[];
    for (const row of due) {
      const board = this.db.prepare("SELECT b.id, b.name, p.email FROM boards b JOIN principals p ON p.id = b.owner_id WHERE b.id = ?").get(row.board_id) as
        | { id: string; name: string; email: string | null }
        | undefined;
      if (!board) {
        // The board was deleted: its name goes, with the usual hold for the person who had it.
        this.db.prepare("UPDATE cf_board_names SET state = 'released', ends_at = ?, warned_stage = 0 WHERE name = ?").run(this.after(now, this.opts.holdDays), row.name);
        continue;
      }
      const activity = this.activity(row);
      let stage = row.warned_stage;
      if (activity > row.last_active_at) {
        stage = 0;
        this.db.prepare("UPDATE cf_board_names SET last_active_at = ?, warned_stage = 0 WHERE name = ?").run(activity, row.name);
      }
      const releaseAt = Date.parse(activity) + this.opts.inactiveDays * DAY_MS;
      const left = releaseAt - now.getTime();
      const settings = `${this.publicUrl}/b/${board.id}/settings`;
      if (left <= 0) {
        const until = this.after(now, this.opts.holdDays);
        this.db.prepare("UPDATE cf_board_names SET state = 'released', ends_at = ?, warned_stage = 0 WHERE name = ?").run(until, row.name);
        if (board.email) notices.push(releasedNotice(board.email, row.name, this.publicUrl, settings, board.id, this.opts, until));
        continue;
      }
      const next = left <= 7 * DAY_MS && this.opts.inactiveDays > 7 ? 2 : left <= 30 * DAY_MS && this.opts.inactiveDays > 30 ? 1 : 0;
      if (next > stage) {
        this.db.prepare("UPDATE cf_board_names SET warned_stage = ? WHERE name = ?").run(next, row.name);
        if (board.email) notices.push(warningNotice(board.email, row.name, this.publicUrl, settings, new Date(releaseAt), this.opts));
      }
    }
    return notices;
  }
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const host = (publicUrl: string) => publicUrl.replace(/^https?:\/\//, "");

function warningNotice(to: string, name: string, publicUrl: string, settings: string, releaseAt: Date, opts: NamesOptions): NameNotice {
  return {
    to,
    subject: `Your board name "${name}" will be released on ${day(releaseAt)}`,
    text: [
      `${host(publicUrl)}/${name} has had no activity for a while. Names are released after ${opts.inactiveDays} days without activity, and this one will be released on ${day(releaseAt)}.`,
      "",
      "To keep it, do either of these before then:",
      `- sign in and press Keep name: ${settings}`,
      "- post on the board",
      "",
      "If the name is released, the board itself is not affected: its threads, members and its permanent address stay as they are.",
    ].join("\n"),
  };
}

function releasedNotice(to: string, name: string, publicUrl: string, settings: string, boardId: string, opts: NamesOptions, until: string): NameNotice {
  return {
    to,
    subject: `Your board name "${name}" has been released`,
    text: [
      `${host(publicUrl)}/${name} had no activity for ${opts.inactiveDays} days, so the name has been released.`,
      "",
      `The board is not affected. Its threads and members are as they were, and it is at its permanent address: ${publicUrl}/b/${boardId}`,
      "",
      `Until ${until.slice(0, 10)} only you can take the name back: ${settings}`,
      "After that, anyone can claim it.",
    ].join("\n"),
  };
}

type RouteActor = { id: string; kind: string; via: string; scope?: unknown } | null;

/** What the routes need from the core, passed in because the core is loaded dynamically. */
export interface NamesDeps {
  /** The core's member check: throws `not_found` for a non-member, `forbidden` below the role. */
  requireMember(ctx: AppContext, actor: never, boardId: string, min: "reader" | "owner"): { board: { owner_id: string } };
  /** The sender for warnings. */
  mailer(): Mailer | null;
}

export interface NamesExtension extends ExtensionModule {
  /** Runs the housekeeping and sends its emails. Called from the Durable Object's alarm. */
  sweep(ctx: AppContext): Promise<void>;
}

export function namesExtension(opts: NamesOptions, deps: NamesDeps): NamesExtension {
  let names: BoardNames | null = null;
  const of = (ctx: AppContext) => (names ??= new BoardNames(ctx.db as unknown as NamesDb, opts, ctx.config.publicUrl));
  const error = (code: string, message: string) => ({ error: { code, message } });
  return {
    id: NAMES_EXTENSION_ID,
    info: {
      version: "0.1.0",
      description: `A board's owner can claim a short name; <server>/<name> then leads to the board for its members. Names are released after ${opts.inactiveDays} days without activity.`,
    },
    register(app, ctx) {
      const board = (c: { req: { param(name: string): string } }) => c.req.param("boardId");
      /** A person who owns the board, acting with their own sign-in or an unscoped token: never an agent. */
      const owner = (actor: RouteActor, boardId: string): { ownerId: string } | Response => {
        if (!actor) return Response.json(error("unauthenticated", "Sign in or send a bearer token"), { status: 401 });
        const { board: row } = deps.requireMember(ctx, actor as never, boardId, "owner");
        if (actor.kind !== "human" || actor.scope) return Response.json(error("forbidden", "Only the board's owner can change its name, with their own sign-in"), { status: 403 });
        return { ownerId: row.owner_id };
      };
      const view = (boardId: string) => {
        const s = of(ctx).state(boardId, ctx.now());
        return { ...s, address: s.name ? `${ctx.config.publicUrl}/${s.name}` : null };
      };

      // Members see the board's name (it is the address they use). Only the owner sees dates and earlier names.
      app.get("/x/names/boards/:boardId", (c) => {
        const actor = c.get("actor") as RouteActor;
        if (!actor) return c.json(error("unauthenticated", "Sign in or send a bearer token"), 401);
        const { board: row } = deps.requireMember(ctx, actor as never, board(c), "reader");
        const isOwner = actor.kind === "human" && !actor.scope && actor.id === row.owner_id;
        // The owner looking at their board in a signed-in browser is activity; anyone else reading is not.
        if (isOwner && actor.via === "session") of(ctx).keep(board(c), ctx.now());
        const full = view(board(c));
        return c.json(isOwner ? full : { name: full.name, address: full.address });
      });
      app.put("/x/names/boards/:boardId", async (c) => {
        const who = owner(c.get("actor") as RouteActor, board(c));
        if (who instanceof Response) return who;
        const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
        try {
          of(ctx).claim(board(c), who.ownerId, body?.name, ctx.now());
        } catch (e) {
          if (e instanceof NameError) return c.json(error(e.code, e.message), e.code === "conflict" ? 409 : 400);
          throw e;
        }
        return c.json(view(board(c)));
      });
      app.delete("/x/names/boards/:boardId", (c) => {
        const who = owner(c.get("actor") as RouteActor, board(c));
        if (who instanceof Response) return who;
        of(ctx).release(board(c), ctx.now());
        return c.json(view(board(c)));
      });
      app.post("/x/names/boards/:boardId/keep", (c) => {
        const who = owner(c.get("actor") as RouteActor, board(c));
        if (who instanceof Response) return who;
        of(ctx).keep(board(c), ctx.now());
        return c.json(view(board(c)));
      });
      // Where a name leads, for members only. A name nobody holds and a board the caller can't read get the same answer.
      app.get("/x/names/resolve/:name", (c) => {
        const actor = c.get("actor") as RouteActor;
        if (!actor) return c.json(error("unauthenticated", "Sign in or send a bearer token"), 401);
        const notFound = () => c.json(error("not_found", "Board not found"), 404);
        const boardId = of(ctx).resolve(c.req.param("name"), ctx.now());
        if (!boardId) return notFound();
        try {
          deps.requireMember(ctx, actor as never, boardId, "reader");
        } catch {
          return notFound();
        }
        return c.json({ board_id: boardId });
      });
    },
    async sweep(ctx) {
      const mailer = deps.mailer();
      for (const notice of of(ctx).sweep(ctx.now())) {
        try {
          await mailer?.send(notice);
        } catch {
          // The mailer logs why. A warning that could not be sent is not retried; the release email still follows.
        }
      }
    },
  };
}
