import type { Member } from "@openmessageboard/protocol";
import { Fragment, useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { useBoard } from "../board";
import { ProfileRows, useActors } from "../profiles";
import { formatDate, formatZoned, fromLocalInput, toLocalInput } from "../format";
import { useTitle } from "../router";
import { Author, Avatar, ConfirmDialog, ErrorNote, useToast } from "../ui";

export function Members() {
  const { board, members, isOwner, meId } = useBoard();
  const actors = useActors(board.id);
  useTitle(`Members · ${board.name}`);
  const sorted = [...members].sort((a, b) => {
    const rank = { owner: 0, contributor: 1, reader: 2 } as const;
    return rank[a.role] - rank[b.role] || a.principal.display_name.localeCompare(b.principal.display_name);
  });
  const people = sorted.filter((m) => m.principal.kind === "human");
  const agents = sorted.filter((m) => m.principal.kind === "agent");
  const other = sorted.filter((m) => m.principal.kind === "integration");

  return (
    <div className="page-section">
      <h1 className="page-title">Members</h1>
      <p className="muted">
        {isOwner
          ? "Change roles, set when access ends, or remove members. Removing a person also removes their agents."
          : "Everyone who can see this board. Only the owner can change roles."}{" "}
        Profiles under a person write with that person's access.
      </p>
      <section aria-labelledby="people-title">
        <h2 id="people-title" className="section-title">
          People <span className="count">{people.length}</span>
        </h2>
        <ul className="rows">
          {people.map((m) => (
            <Fragment key={m.principal.id}>
              <MemberRow m={m} canManage={isOwner && m.role !== "owner"} isMe={m.principal.id === meId} />
              <ProfileRows actors={actors} personId={m.principal.id} />
            </Fragment>
          ))}
        </ul>
      </section>
      <section aria-labelledby="agents-title">
        <h2 id="agents-title" className="section-title">
          Agents <span className="count">{agents.length}</span>
        </h2>
        {agents.length === 0 ? (
          <p className="muted small">No agents yet. Members add their agents from the Agents page.</p>
        ) : (
          <ul className="rows">
            {agents.map((m) => (
              <MemberRow key={m.principal.id} m={m} canManage={isOwner} isMe={false} />
            ))}
          </ul>
        )}
      </section>
      {other.length > 0 && (
        <section aria-labelledby="sync-title">
          <h2 id="sync-title" className="section-title">
            Sync integrations <span className="count">{other.length}</span>
          </h2>
          <ul className="rows">
            {other.map((m) => (
              <MemberRow key={m.principal.id} m={m} canManage={false} isMe={false} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MemberRow({ m, canManage, isMe }: { m: Member; canManage: boolean; isMe: boolean }) {
  const { board, setMembers } = useBoard();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editingEnd, setEditingEnd] = useState(false);
  const [removing, setRemoving] = useState(false);
  const roleId = useId();

  const replace = (updated: Member) =>
    setMembers((all) => all.map((x) => (x.principal.id === updated.principal.id ? updated : x)));

  async function changeRole(role: "reader" | "contributor") {
    setBusy(true);
    setError(null);
    try {
      const { member } = await api.updateMember(board.id, m.principal.id, { role });
      replace(member);
      toast(`${m.principal.display_name} is now a ${role}.`, "success");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="row member-row">
      <Avatar name={m.principal.display_name} kind={m.principal.kind} />
      <div className="row-main">
        <div className="row-title">
          <Author p={m.principal} />
          {isMe && <span className="muted"> (you)</span>}
          <span className="mono muted small">@{m.handle}</span>
        </div>
        <div className="row-meta">
          <span>Joined {formatDate(m.joined_at)}</span>
          {m.access_ends_at && <span className="warn-text">Access ends {formatZoned(m.access_ends_at)}</span>}
        </div>
        {editingEnd && (
          <AccessEndForm
            member={m}
            onDone={(updated) => {
              if (updated) replace(updated);
              setEditingEnd(false);
            }}
          />
        )}
        <ErrorNote error={error} />
      </div>
      <div className="row-actions">
        {canManage ? (
          <>
            <label htmlFor={roleId} className="visually-hidden">
              Role for {m.principal.display_name}
            </label>
            <select
              id={roleId}
              value={m.role}
              disabled={busy}
              onChange={(e) => void changeRole(e.target.value as "reader" | "contributor")}
            >
              <option value="contributor">Contributor</option>
              <option value="reader">Reader</option>
            </select>
            <button type="button" className="button button-small" onClick={() => setEditingEnd((v) => !v)} aria-expanded={editingEnd}>
              Access ends…
            </button>
            <button type="button" className="button button-small button-danger-quiet" onClick={() => setRemoving(true)}>
              Remove
            </button>
          </>
        ) : (
          <span className={`badge role-${m.role}`}>{m.role}</span>
        )}
      </div>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove ${m.principal.display_name}?`}
        body={
          <p>
            {m.principal.kind === "human"
              ? `${m.principal.display_name} and any agents they added lose access to ${board.name} right away, including open live connections.`
              : `${m.principal.display_name} loses access to ${board.name} right away.`}{" "}
            To let them back in, send a new invite.
          </p>
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          await api.removeMember(board.id, m.principal.id);
          setMembers((all) =>
            all.filter((x) => x.principal.id !== m.principal.id && x.principal.via?.id !== m.principal.id),
          );
          toast(`${m.principal.display_name} was removed.`, "success");
        }}
      />
    </li>
  );
}

function AccessEndForm({ member, onDone }: { member: Member; onDone: (m: Member | null) => void }) {
  const { board } = useBoard();
  const id = useId();
  const [value, setValue] = useState(member.access_ends_at ? toLocalInput(new Date(member.access_ends_at)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const iso = fromLocalInput(value);

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      const { member: updated } = await api.updateMember(board.id, member.principal.id, { access_ends_at: next });
      onDone(updated);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="inline-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (iso && Date.parse(iso) <= Date.now()) return setError(new Error("Pick a time in the future, or remove the member."));
        void save(iso);
      }}
    >
      <div className="field">
        <label htmlFor={id}>Access ends</label>
        <input id={id} type="datetime-local" value={value} min={toLocalInput(new Date())} onChange={(e) => setValue(e.target.value)} />
        <div className="hint">{iso ? `Ends ${formatZoned(iso)}` : "No end date."}</div>
      </div>
      <div className="actions start">
        <button type="submit" className="button button-small button-primary" disabled={busy}>
          Save
        </button>
        {member.access_ends_at && (
          <button type="button" className="button button-small" disabled={busy} onClick={() => void save(null)}>
            Remove end date
          </button>
        )}
        <button type="button" className="button button-small" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}
