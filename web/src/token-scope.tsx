import type { TokenScope } from "@openmessageboard/protocol";
import { useId } from "react";
import type { CreateTokenInput } from "./api";
import { formatDateTime } from "./format";
import { useSession } from "./session";
import { Field } from "./ui";

/** What the token form collects: which boards, read only, a profile (personal tokens), and how long it lives. */
export interface ScopeState {
  board: string;
  readOnly: boolean;
  profile: string;
  expires: string;
}

export const emptyScope: ScopeState = { board: "", readOnly: false, profile: "", expires: "" };

const EXPIRY: [string, string][] = [
  ["", "Never"],
  ["3600", "1 hour"],
  ["86400", "1 day"],
  ["604800", "7 days"],
  ["2592000", "30 days"],
  ["7776000", "90 days"],
];

/** The request body for `POST /api/tokens` or `POST /api/agents/:id/tokens`. */
export function scopeBody(s: ScopeState, label: string): CreateTokenInput {
  return {
    ...(label.trim() ? { label: label.trim() } : {}),
    ...(s.board ? { boards: [s.board] } : {}),
    ...(s.readOnly ? { can: ["read"] } : {}),
    ...(s.profile.trim() ? { profile: s.profile.trim() } : {}),
    ...(s.expires ? { expires_in_seconds: Number(s.expires) } : {}),
  };
}

/** Board, permission, profile and expiry fields for a new token. */
export function TokenScopeFields({ value, onChange, allowProfile }: { value: ScopeState; onChange: (s: ScopeState) => void; allowProfile: boolean }) {
  const { me } = useSession();
  const ids = { board: useId(), readOnly: useId(), profile: useId(), expires: useId() };
  const boards = new Map<string, string>();
  if (me?.owned_board) boards.set(me.owned_board.id, me.owned_board.name);
  me?.memberships.forEach((m) => boards.set(m.board_id, m.board_name));
  return (
    <>
      <Field label="Boards" htmlFor={ids.board}>
        <select id={ids.board} value={value.board} onChange={(e) => onChange({ ...value, board: e.target.value })}>
          <option value="">Every board</option>
          {[...boards].map(([id, name]) => (
            <option key={id} value={id}>
              Only {name}
            </option>
          ))}
        </select>
      </Field>
      {allowProfile && (
        <Field label="Write as profile (optional)" htmlFor={ids.profile} hint="Shown as “name via you”.">
          <input
            id={ids.profile}
            value={value.profile}
            maxLength={32}
            pattern="[A-Za-z][A-Za-z0-9\-]{0,31}"
            placeholder="fixer-1"
            onChange={(e) => onChange({ ...value, profile: e.target.value })}
          />
        </Field>
      )}
      <Field label="Expires" htmlFor={ids.expires}>
        <select id={ids.expires} value={value.expires} onChange={(e) => onChange({ ...value, expires: e.target.value })}>
          {EXPIRY.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="field checkbox-field">
        <label className="checkbox">
          <input id={ids.readOnly} type="checkbox" checked={value.readOnly} onChange={(e) => onChange({ ...value, readOnly: e.target.checked })} />
          <span>
            Read only
            <span className="hint block">It can read and follow, never post.</span>
          </span>
        </label>
      </div>
    </>
  );
}

/** Badges for a token's scope and expiry, for token lists. */
export function ScopeSummary({ scope, expiresAt }: { scope: TokenScope | null | undefined; expiresAt: string | null | undefined }) {
  const { me } = useSession();
  const names = new Map<string, string>();
  me?.memberships.forEach((m) => names.set(m.board_id, m.board_name));
  const parts: string[] = [];
  if (scope) {
    parts.push(scope.can.length === 1 ? "Read only" : "Read and post");
    parts.push(scope.boards ? scope.boards.map((b) => names.get(b) ?? b).join(", ") : "Every board");
  }
  if (!scope && !expiresAt) return null;
  return (
    <span className="token-scope">
      {parts.map((p) => (
        <span key={p} className="badge">
          {p}
        </span>
      ))}
      {scope?.profile && (
        <span className="badge badge-plain" title="Writes as this profile">
          as {scope.profile}
        </span>
      )}
      {expiresAt && <span className="muted">Expires {formatDateTime(expiresAt)}</span>}
    </span>
  );
}
