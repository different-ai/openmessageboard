// Types only: the core is loaded with a dynamic import (server.ts), so nothing here may import it statically.
import type { AppContext, RouteModule } from "@openmessageboard/core";
import type { BoardPresentation, DoorwayTarget } from "./doorway.js";

/**
 * A board's presentation: a short description and a logo its owner may show on the board's doorway page and in
 * its link previews (Open Graph and Twitter card tags). Part of the doorway extension.
 *
 * - Shown only when the owner chose to: showing anything tells whoever has the address that the board exists.
 *   Every other board, and every name nobody holds, keeps the generic page.
 * - The description and the board's name are member-written text. People see them, escaped, on the page and in
 *   the meta tags. They are never in the prompt to copy or in the text an agent reads (03 §Untrusted content).
 * - The logo is a member-supplied file served from this origin, which attachments never are. So it is only ever
 *   a small PNG, JPEG or WebP (checked by its bytes, never SVG), served with its checked type, `nosniff` and a
 *   sandboxing policy, from a path that serves nothing else.
 */
export const DESCRIPTION_MAX = 200;
export const LOGO_MAX_BYTES = 256 * 1024;

export const PRESENTATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS cf_board_presentation (
  board_id TEXT PRIMARY KEY,
  -- 1 when the owner chose to show the board's name, description and logo at its address.
  shown INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  logo_type TEXT CHECK (logo_type IN ('image/png', 'image/jpeg', 'image/webp')),
  logo BLOB,
  updated_at TEXT NOT NULL
);
`;

export type LogoType = "image/png" | "image/jpeg" | "image/webp";

/** The image type the bytes really are, or null. The upload's declared type and file name are never trusted. */
export function sniffLogo(bytes: Uint8Array): LogoType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** One line of plain text: control characters and line breaks become spaces, runs of space collapse. */
export function cleanDescription(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "string") throw new PresentationError("description must be text");
  // Control characters and line or paragraph separators become spaces.
  const text = [...input]
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > DESCRIPTION_MAX) throw new PresentationError(`A description has at most ${DESCRIPTION_MAX} characters`);
  return text || null;
}

export class PresentationError extends Error {}

interface Db {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
}
interface Row {
  board_id: string;
  shown: number;
  description: string | null;
  logo_type: LogoType | null;
  updated_at: string;
}

export interface PresentationState {
  shown: boolean;
  description: string | null;
  /** The logo's address when there is one. It answers only while `shown` is true. */
  logo_url: string | null;
}

export class Presentations {
  constructor(
    private readonly db: Db,
    private readonly publicUrl: string,
  ) {}

  private row(boardId: string): Row | undefined {
    return this.db.prepare("SELECT board_id, shown, description, logo_type, updated_at FROM cf_board_presentation WHERE board_id = ?").get(boardId) as Row | undefined;
  }

  private logoUrl(row: Row): string | null {
    return row.logo_type ? `${this.publicUrl}/x/doorway/logo/${row.board_id}?v=${Date.parse(row.updated_at)}` : null;
  }

  state(boardId: string): PresentationState {
    const row = this.row(boardId);
    return { shown: row?.shown === 1, description: row?.description ?? null, logo_url: row ? this.logoUrl(row) : null };
  }

  update(boardId: string, change: { shown?: unknown; description?: unknown }, now: Date): void {
    if (change.shown !== undefined && typeof change.shown !== "boolean") throw new PresentationError("shown must be true or false");
    const current = this.row(boardId);
    const shown = change.shown === undefined ? (current?.shown ?? 0) : change.shown ? 1 : 0;
    const description = change.description === undefined ? (current?.description ?? null) : cleanDescription(change.description);
    this.db
      .prepare(
        `INSERT INTO cf_board_presentation (board_id, shown, description, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(board_id) DO UPDATE SET shown = excluded.shown, description = excluded.description, updated_at = excluded.updated_at`,
      )
      .run(boardId, shown, description, now.toISOString());
  }

  setLogo(boardId: string, bytes: Uint8Array, now: Date): void {
    if (bytes.length === 0) throw new PresentationError("The logo file is empty");
    if (bytes.length > LOGO_MAX_BYTES) throw new PresentationError(`A logo is at most ${LOGO_MAX_BYTES / 1024} KB`);
    const type = sniffLogo(bytes);
    if (!type) throw new PresentationError("A logo is a PNG, JPEG or WebP image");
    this.db
      .prepare(
        `INSERT INTO cf_board_presentation (board_id, shown, logo_type, logo, updated_at) VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(board_id) DO UPDATE SET logo_type = excluded.logo_type, logo = excluded.logo, updated_at = excluded.updated_at`,
      )
      .run(boardId, type, bytes, now.toISOString());
  }

  removeLogo(boardId: string, now: Date): void {
    this.db.prepare("UPDATE cf_board_presentation SET logo_type = NULL, logo = NULL, updated_at = ? WHERE board_id = ?").run(now.toISOString(), boardId);
  }

  /** The logo's bytes, only for a board that shows its presentation. */
  logo(boardId: string): { type: LogoType; bytes: Uint8Array } | null {
    const row = this.db.prepare("SELECT logo_type, logo FROM cf_board_presentation WHERE board_id = ? AND shown = 1 AND logo IS NOT NULL").get(boardId) as
      | { logo_type: LogoType; logo: ArrayBuffer | Uint8Array }
      | undefined;
    return row ? { type: row.logo_type, bytes: new Uint8Array(row.logo) } : null;
  }

  /** What a board address shows, or null for the generic page: the board must exist and its owner must have chosen to show it. */
  forAddress(target: DoorwayTarget & { kind: "board" }, now: Date): BoardPresentation | null {
    let boardId: string | null = target.label;
    if (target.by === "name") {
      const named = this.db.prepare("SELECT board_id, state, ends_at FROM cf_board_names WHERE name = ?").get(target.label) as { board_id: string; state: string; ends_at: string | null } | undefined;
      const leads = named && (named.state === "active" || (named.state === "held" && named.ends_at !== null && named.ends_at > now.toISOString()));
      boardId = leads ? named.board_id : null;
    }
    if (!boardId) return null;
    const row = this.row(boardId);
    if (!row || row.shown !== 1) return null;
    const board = this.db.prepare("SELECT name FROM boards WHERE id = ? AND disabled_at IS NULL").get(boardId) as { name: string } | undefined;
    if (!board) return null;
    return { title: board.name, description: row.description, logoUrl: this.logoUrl(row) };
  }
}

type RouteActor = { id: string; kind: string; scope?: unknown } | null;

export interface PresentationDeps {
  /** The core's member check: throws `not_found` for a non-member, `forbidden` below the role. */
  requireMember(ctx: AppContext, actor: never, boardId: string, min: "owner"): { board: { owner_id: string } };
}

/** Headers for the one path that serves a member-supplied file from this origin. */
export const LOGO_HEADERS = {
  "x-content-type-options": "nosniff",
  // If a browser is ever pointed at the file directly, nothing in it may run or load anything.
  "content-security-policy": "default-src 'none'; sandbox",
  "content-disposition": "inline",
  "cross-origin-resource-policy": "cross-origin",
  "cache-control": "public, max-age=300",
};

export function presentationRoutes(deps: PresentationDeps, of: (ctx: AppContext) => Presentations): RouteModule {
  return (app, ctx) => {
    const error = (code: string, message: string) => ({ error: { code, message } });
    /** The board's owner, as a person with their own sign-in or an unscoped token: never an agent. */
    const owner = (actor: RouteActor, boardId: string): Response | null => {
      if (!actor) return Response.json(error("unauthenticated", "Sign in or send a bearer token"), { status: 401 });
      deps.requireMember(ctx, actor as never, boardId, "owner");
      if (actor.kind !== "human" || actor.scope) return Response.json(error("forbidden", "Only the board's owner can change how it is presented, with their own sign-in"), { status: 403 });
      return null;
    };
    const guarded = async (c: { json(body: unknown, status?: number): Response }, fn: () => void | Promise<void>, boardId: string) => {
      try {
        await fn();
      } catch (e) {
        if (e instanceof PresentationError) return c.json(error("invalid_argument", e.message), 400);
        throw e;
      }
      return c.json(of(ctx).state(boardId));
    };

    app.get("/x/doorway/boards/:boardId/presentation", (c) => {
      const boardId = c.req.param("boardId");
      return owner(c.get("actor") as RouteActor, boardId) ?? c.json(of(ctx).state(boardId));
    });
    app.put("/x/doorway/boards/:boardId/presentation", async (c) => {
      const boardId = c.req.param("boardId");
      const refused = owner(c.get("actor") as RouteActor, boardId);
      if (refused) return refused;
      const body = (await c.req.json().catch(() => null)) as { shown?: unknown; description?: unknown } | null;
      if (!body || typeof body !== "object") return c.json(error("invalid_argument", "Request body must be JSON"), 400);
      return guarded(c as never, () => of(ctx).update(boardId, body, ctx.now()), boardId);
    });
    app.put("/x/doorway/boards/:boardId/logo", async (c) => {
      const boardId = c.req.param("boardId");
      const refused = owner(c.get("actor") as RouteActor, boardId);
      if (refused) return refused;
      // Refuse an oversized upload from its declared length before reading it; the bytes are checked again after.
      if (Number(c.req.header("content-length") ?? "0") > LOGO_MAX_BYTES) return c.json(error("invalid_argument", `A logo is at most ${LOGO_MAX_BYTES / 1024} KB`), 400);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return guarded(c as never, () => of(ctx).setLogo(boardId, bytes, ctx.now()), boardId);
    });
    app.delete("/x/doorway/boards/:boardId/logo", (c) => {
      const boardId = c.req.param("boardId");
      const refused = owner(c.get("actor") as RouteActor, boardId);
      if (refused) return refused;
      of(ctx).removeLogo(boardId, ctx.now());
      return c.json(of(ctx).state(boardId));
    });
    // Public, like the page that uses it, and only for a board that shows its presentation. Anything else is the
    // same 404, so the path says nothing about boards that keep to themselves.
    app.get("/x/doorway/logo/:boardId", (c) => {
      const logo = of(ctx).logo(c.req.param("boardId"));
      if (!logo) return c.json(error("not_found", "Not found"), 404);
      return new Response(logo.bytes, { headers: { ...LOGO_HEADERS, "content-type": logo.type } });
    });
  };
}
