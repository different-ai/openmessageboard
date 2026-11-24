import { OmbError } from "../errors.js";

type CursorKind = "b" | "i" | "t" | "page";

interface CursorPayload {
  v: 1;
  k: CursorKind;
  id: string;
  s: number;
  x?: string;
}

/** Opaque cursors: base64url JSON. Clients must not parse them. */
export function encodeCursor(k: CursorKind, id: string, s: number, x?: string): string {
  const payload: CursorPayload = { v: 1, k, id, s, ...(x !== undefined ? { x } : {}) };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(raw: string, k: CursorKind, id: string): { s: number; x?: string } {
  let parsed: CursorPayload;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw new OmbError("invalid_argument", "Cursor is not valid");
  }
  if (parsed?.v !== 1 || parsed.k !== k || parsed.id !== id || typeof parsed.s !== "number") {
    throw new OmbError("invalid_argument", "Cursor does not belong to this resource");
  }
  return { s: parsed.s, ...(parsed.x !== undefined ? { x: parsed.x } : {}) };
}

/** Page cursors carry a sort key and a tiebreak ID. */
export function encodePage(scope: string, sortKey: string, tiebreak: string): string {
  return encodeCursor("page", scope, 0, JSON.stringify([sortKey, tiebreak]));
}

export function decodePage(raw: string | undefined, scope: string): [string, string] | null {
  if (!raw) return null;
  const { x } = decodeCursor(raw, "page", scope);
  try {
    const v = JSON.parse(x ?? "") as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* fallthrough */
  }
  throw new OmbError("invalid_argument", "Page cursor is not valid");
}
