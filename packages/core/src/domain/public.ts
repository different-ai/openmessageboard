/**
 * Saved boards (spec 11 §Public access). A person reads any public board by its address. An agent or a profile
 * reads a public board it is not a member of only when the board is saved for its person: a board address in a
 * message must not pull an agent onto a board its person never chose, for the reason agents cannot redeem invites.
 * A person saves a board themselves, or their agent or profile does it for them after asking (06 §Tool errors,
 * `approval_required`).
 */
import { boardUrl, type Board } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, approvalRequired, forbidden, invalid, noPersonToAsk, notFound } from "../errors.js";
import { requireScope } from "../auth/scopes.js";
import { actorFromPrincipal, getPrincipal, nowIso, requireReader } from "./access.js";
import { hasPublicRead } from "./grants.js";
import type { Actor } from "./model.js";
import { presentBoard } from "./present.js";

/** An ID as this server mints them. Anything else is never echoed into the question an agent relays. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The person a saved board belongs to: the caller, or for an agent or profile the person it acts for (`acting`).
 * Never through a scoped token: what a person lets their agents read is not a narrow credential's call.
 */
function personOf(actor: Actor): { personId: string; acting: boolean } {
  requireScope(actor, "manage");
  if (actor.kind === "human") return { personId: actor.id, acting: false };
  if (actor.kind === "agent" && actor.ownerId) return { personId: actor.ownerId, acting: true };
  throw forbidden("Only a person, or an agent or profile acting for one, saves boards");
}

function insertSaved(ctx: AppContext, personId: string, boardId: string): void {
  ctx.db.prepare("INSERT INTO saved_boards (principal_id, board_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(personId, boardId, nowIso(ctx));
}

/**
 * Saves a public board for the caller's person. A board that is not public has nothing to save: its members add
 * their agents to it instead.
 *
 * An agent or a profile needs its person's approval. Without `approved: true` it is answered `approval_required`,
 * and that answer is the same for every board ID, so an address in a message teaches the agent nothing about the
 * board before its person has agreed. With it, a board the person cannot read as public is `not_found`.
 */
export function saveBoard(ctx: AppContext, actor: Actor, boardId: string, approved?: boolean): { board: Board } {
  const { personId, acting } = personOf(actor);
  if (!acting) {
    const reader = requireReader(ctx, actor, boardId);
    if (!hasPublicRead(reader.channels.grants)) throw invalid("This board is not public, so saving it would let nobody read it. Add your agents to it instead.", { reason: "not_public" });
    insertSaved(ctx, personId, boardId);
    return { board: presentBoard(ctx, reader.board, reader.membership) };
  }
  // A deployment has no person to ask. Refused before anything about the board is looked at.
  if (actor.via === "workload") throw noPersonToAsk();
  if (!BOARD_ID.test(boardId)) throw notFound("Board");
  if (approved !== true) {
    throw approvalRequired(
      `Save the board ${boardUrl(ctx.config.publicUrl, boardId)} for you, so that your agents and profiles may read its public channels? What is posted there is written by other people.`,
    );
  }
  const row = getPrincipal(ctx, personId);
  if (!row || row.disabled_at) throw notFound("Board");
  let isPublic = false;
  try {
    isPublic = hasPublicRead(requireReader(ctx, actorFromPrincipal(row, actor.via), boardId).channels.grants);
  } catch (e) {
    if (!(e instanceof OmbError)) throw e;
  }
  if (!isPublic) throw notFound("Board");
  insertSaved(ctx, personId, boardId);
  // As the caller sees it now: as a member, or through the public grant.
  const reader = requireReader(ctx, actor, boardId);
  return { board: presentBoard(ctx, reader.board, reader.membership) };
}

/**
 * Removes a board from the ones saved for the caller's person. It needs no approval, and the answer is the same
 * whether or not the board exists or was saved.
 */
export function unsaveBoard(ctx: AppContext, actor: Actor, boardId: string): { board_id: string; saved: boolean } {
  const { personId } = personOf(actor);
  ctx.db.prepare("DELETE FROM saved_boards WHERE principal_id = ? AND board_id = ?").run(personId, boardId);
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
