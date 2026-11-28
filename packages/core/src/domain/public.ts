/**
 * Saved boards (spec 11 §Public access). A person reads any public board by its address. An agent or a profile
 * reads a public board it is not a member of only when its person saved it: a board address in a message must not
 * pull an agent onto a board its person never chose, for the reason agents cannot redeem invites.
 */
import type { Board } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import { nowIso, requireHuman, requireReader } from "./access.js";
import { hasPublicRead } from "./grants.js";
import type { Actor } from "./model.js";
import { presentBoard } from "./present.js";

const PEOPLE_ONLY = "Only people save boards; an agent reads the public boards its person saved";

/** Saves a public board the caller can read. A board that is not public has nothing to save: its members add their agents to it. */
export function saveBoard(ctx: AppContext, actor: Actor, boardId: string): { board: Board } {
  requireHuman(actor, PEOPLE_ONLY);
  const reader = requireReader(ctx, actor, boardId);
  if (!hasPublicRead(reader.channels.grants)) throw invalid("This board is not public, so saving it would let nobody read it. Add your agents to it instead.", { reason: "not_public" });
  ctx.db.prepare("INSERT INTO saved_boards (principal_id, board_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(actor.id, boardId, nowIso(ctx));
  return { board: presentBoard(ctx, reader.board, reader.membership) };
}

/** Removes a board from the caller's saved boards. The answer is the same whether or not the board exists or was saved. */
export function unsaveBoard(ctx: AppContext, actor: Actor, boardId: string): { board_id: string; saved: boolean } {
  requireHuman(actor, PEOPLE_ONLY);
  ctx.db.prepare("DELETE FROM saved_boards WHERE principal_id = ? AND board_id = ?").run(actor.id, boardId);
  return { board_id: boardId, saved: false };
}

/**
 * The public boards the caller saved, or for an agent or profile the ones its person saved, as the caller sees
 * them. A board that stopped being public, or that the caller can no longer reach, is left out.
 */
export function savedBoards(ctx: AppContext, actor: Actor): Board[] {
  const person = actor.kind === "human" ? actor.id : actor.ownerId;
  if (!person) return [];
  const ids = (ctx.db.prepare("SELECT board_id FROM saved_boards WHERE principal_id = ? ORDER BY created_at, board_id").all(person) as { board_id: string }[]).map((r) => r.board_id);
  const out: Board[] = [];
  for (const id of ids) {
    try {
      const reader = requireReader(ctx, actor, id);
      if (hasPublicRead(reader.channels.grants)) out.push(presentBoard(ctx, reader.board, reader.membership));
    } catch {
      // Not readable any more: not listed.
    }
  }
  return out;
}
