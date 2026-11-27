import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import { api } from "../api";
import { useBoard } from "../board";
import { navigate, useTitle } from "../router";
import { useSession } from "../session";
import { ConfirmDialog, ErrorNote, Field, Loading, UsageMeter, useLoad, useToast } from "../ui";
import { OwnerOnly } from "./OwnerOnly";

export function Settings() {
  const { board, isOwner } = useBoard();
  useTitle(`Settings · ${board.name}`);
  if (!isOwner) return <OwnerOnly what="board settings" />;
  return (
    <div className="page-section settings">
      <h1 className="page-title">Settings</h1>
      <RenameForm />
      <AgentSettings />
      <UsageSection />
      <ExportImport />
      <DangerZone />
    </div>
  );
}

function RenameForm() {
  const { board, setBoard } = useBoard();
  const { refreshMe } = useSession();
  const id = useId();
  const [name, setName] = useState(board.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  return (
    <section className="card" aria-labelledby="rename-title">
      <h2 id="rename-title">Name</h2>
      <form
        className="inline-form"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setBoard(await api.updateBoard(board.id, { name: name.trim() }));
            void refreshMe();
            toast("Board renamed.", "success");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Board name" htmlFor={id}>
          <input id={id} value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" className="button button-primary" disabled={busy || !name.trim() || name.trim() === board.name}>
          Save
        </button>
      </form>
      <ErrorNote error={error} />
    </section>
  );
}

function AgentSettings() {
  const { board, setBoard } = useBoard();
  const ids = { add: useId(), posts: useId(), loop: useId() };
  const [s, setS] = useState(board.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const changed = JSON.stringify(s) !== JSON.stringify(board.settings);
  return (
    <section className="card" aria-labelledby="agents-settings-title">
      <h2 id="agents-settings-title">Agents</h2>
      <form
        className="stack"
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const updated = await api.updateBoard(board.id, { settings: s });
            setBoard(updated);
            setS(updated.settings);
            toast("Agent settings saved.", "success");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="checkbox">
          <input
            id={ids.add}
            type="checkbox"
            checked={s.members_can_add_agents}
            onChange={(e) => setS({ ...s, members_can_add_agents: e.target.checked })}
          />
          <span>
            Members can add their agents
            <span className="hint block">An agent's role is never above the person it acts for, and it takes a seat.</span>
          </span>
        </label>
        <div className="grid-2">
          <Field label="Agent posts per day" htmlFor={ids.posts} hint="Per agent, within the host's limit.">
            <input
              id={ids.posts}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={s.agent_posts_per_day}
              onChange={(e) => setS({ ...s, agent_posts_per_day: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Consecutive agent messages per thread"
            htmlFor={ids.loop}
            hint="Further agent posts wait until a person posts. Stops agent loops."
          >
            <input
              id={ids.loop}
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={s.agent_consecutive_limit}
              onChange={(e) => setS({ ...s, agent_consecutive_limit: Number(e.target.value) })}
            />
          </Field>
        </div>
        <ErrorNote error={error} />
        <div className="actions start">
          <button type="submit" className="button button-primary" disabled={busy || !changed}>
            Save agent settings
          </button>
        </div>
      </form>
    </section>
  );
}

function UsageSection() {
  const { board } = useBoard();
  const { data, error, loading, reload } = useLoad(() => api.usage(board.id), [board.id]);
  return (
    <section className="card" aria-labelledby="usage-title">
      <div className="card-head">
        <h2 id="usage-title">Usage</h2>
        <button type="button" className="button button-small" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : data ? (
        <>
          {data.plan && (
            <p className="muted">
              Plan: <strong>{data.plan === "plus" ? "Plus" : "Base"}</strong>
              {data.plan === "plus" ? " — higher limits for accounts signed in through this server's identity provider." : ""}
            </p>
          )}
          {data.allowances.some((a) => a.warning) && (
            <p className="note note-warning">One or more allowances are at 80% or more. Reading and export keep working at the limit.</p>
          )}
          <div className="meters">
            {data.allowances.map((a) => (
              <UsageMeter key={a.allowance} a={a} />
            ))}
          </div>
          <p className="hint">Stored content: {data.storage_formula}</p>
        </>
      ) : null}
    </section>
  );
}

function ExportImport() {
  const { board } = useBoard();
  const { refreshMe } = useSession();
  const fileId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return setError(new Error("That file isn't valid JSON. Choose a board export file."));
    }
    const format = (parsed as { format?: unknown })?.format;
    if (typeof format !== "string" || !format.startsWith("openmessageboard.export/")) {
      return setError(new Error("That file isn't an OpenMessageBoard export."));
    }
    setBusy(true);
    try {
      const created = await api.importBoard(parsed);
      await refreshMe();
      toast(`Imported “${created.name}”.`, "success");
      navigate(`/b/${created.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="export-title">
      <h2 id="export-title">Export and import</h2>
      <p className="muted">
        An export has every thread and message with author names. It never includes emails, tokens, invites, follows or read
        state.
      </p>
      <div className="actions start">
        <a className="button" href={api.exportUrl(board.id)} download>
          Download export
        </a>
        <label htmlFor={fileId} className={`button ${busy ? "disabled" : ""}`}>
          {busy ? "Importing…" : "Import an export…"}
        </label>
        <input id={fileId} type="file" accept="application/json,.json" className="visually-hidden" onChange={onFile} disabled={busy} />
      </div>
      <p className="hint">Importing creates a new board that you own; it doesn't change this one.</p>
      <ErrorNote error={error} />
    </section>
  );
}

function DangerZone() {
  const { board } = useBoard();
  const { refreshMe } = useSession();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <section className="card danger-zone" aria-labelledby="danger-title">
      <h2 id="danger-title">Delete board</h2>
      <p>
        Deleting removes every thread, message, invite and membership, and ends everyone's access right away. Download an export
        first if you might need it.
      </p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed === board.name) setOpen(true);
        }}
      >
        <Field label={<>Type <strong>{board.name}</strong> to confirm</>} htmlFor={id}>
          <input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
        <button type="submit" className="button button-danger" disabled={typed !== board.name}>
          Delete board
        </button>
      </form>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${board.name}?`}
        body={<p>This can't be undone.</p>}
        confirmLabel="Delete forever"
        onConfirm={async () => {
          await api.deleteBoard(board.id, typed);
          await refreshMe();
          toast("Board deleted.", "success");
          navigate("/");
        }}
      />
    </section>
  );
}
