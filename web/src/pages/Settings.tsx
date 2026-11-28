import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from "react";
import { api, NAMES_EXTENSION, NEWSLETTER_EXTENSION, type BoardNameState, type BoardPresentation } from "../api";
import { DOORWAY_EXTENSION } from "../doorway";
import { formatDateTime } from "../format";
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
      <ShortNameSection />
      <PresentationSection />
      <AgentSettings />
      <UsageSection />
      <NewsletterSection />
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

/** The board's claimed name (`<server>/<name>`). Rendered only on servers that list the names extension. */
function ShortNameSection() {
  const { board } = useBoard();
  const id = useId();
  const [state, setState] = useState<BoardNameState | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void api
      .hasExtension(NAMES_EXTENSION)
      .then((on) => (on ? api.boardName(board.id) : null))
      .then((s) => {
        if (!live || !s) return;
        setState(s);
        setName(s.name ?? "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [board.id]);
  if (!state) return null;
  const host = window.location.host;
  const wanted = name.trim().toLowerCase();
  async function run(action: () => Promise<BoardNameState>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setName(next.name ?? "");
      toast(done, "success");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="short-name-title">
      <h2 id="short-name-title">Short address</h2>
      <p className="muted">
        {state.name ? (
          <>
            Members can open this board at <strong>{host}/{state.name}</strong>.
          </>
        ) : (
          <>Claim a name and members can open this board at {host}/your-name.</>
        )}{" "}
        A name is only an address: it never lets anyone in, and the board keeps its permanent address.
      </p>
      <form
        className="inline-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(() => api.claimBoardName(board.id, wanted), state.name ? "Name changed." : "Name claimed.");
        }}
      >
        <Field label="Name" htmlFor={id} hint="3 to 32 characters: lowercase letters, digits and hyphens, starting with a letter.">
          <input id={id} value={name} maxLength={32} required autoCapitalize="none" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" className="button button-primary" disabled={busy || !wanted || wanted === state.name}>
          {state.name ? "Change name" : "Claim name"}
        </button>
      </form>
      <ErrorNote error={error} />
      {state.name && state.releases_at && (
        <>
          <p className="hint">
            The name is released if the board has no posts, and you don't visit this page, until {formatDateTime(state.releases_at)}. We email you 30 and 7 days
            before. The board and everything in it stay either way.
          </p>
          <div className="actions start">
            <button type="button" className="button" disabled={busy} onClick={() => void run(() => api.keepBoardName(board.id), "Name kept.")}>
              Keep name
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void run(() => api.releaseBoardName(board.id), "Name given up.")}>
              Give up name
            </button>
          </div>
        </>
      )}
      {(state.held?.length ?? 0) > 0 && (
        <p className="hint">
          Earlier names that still lead here: {state.held!.map((h) => `${h.name} (until ${formatDateTime(h.until)})`).join(", ")}. Only you can claim them until then.
        </p>
      )}
      {(state.released?.length ?? 0) > 0 && (
        <p className="hint">
          Names you can take back: {state.released!.map((r) => `${r.name} (until ${formatDateTime(r.until)})`).join(", ")}. After that anyone can claim them.
        </p>
      )}
    </section>
  );
}

/** What the board shows at its address and in link previews. Rendered only on servers with the doorway extension. */
function PresentationSection() {
  const { board } = useBoard();
  const ids = { shown: useId(), description: useId(), logo: useId() };
  const [state, setState] = useState<BoardPresentation | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void api
      .hasExtension(DOORWAY_EXTENSION)
      .then((on) => (on ? api.boardPresentation(board.id) : null))
      .then((s) => {
        if (!live || !s) return;
        setState(s);
        setDescription(s.description ?? "");
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [board.id]);
  if (!state) return null;
  async function run(action: () => Promise<BoardPresentation>, done: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setDescription(next.description ?? "");
      toast(done, "success");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-labelledby="presentation-title">
      <h2 id="presentation-title">Link preview</h2>
      <p className="muted">
        What people see when the board's address is opened in a browser or pasted into a chat: its name, a short description and a logo. It never lets anyone in.
      </p>
      <label className="checkbox">
        <input
          id={ids.shown}
          type="checkbox"
          checked={state.shown}
          disabled={busy}
          onChange={(e) => void run(() => api.setBoardPresentation(board.id, { shown: e.target.checked }), e.target.checked ? "The board's name, description and logo are shown." : "The board shows the standard page again.")}
        />
        <span>
          Show this board's name, description and logo at its address
          <span className="hint block">Anyone with the address will then know this board exists. Off, the address shows the same page as any other.</span>
        </span>
      </label>
      <form
        className="stack"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void run(() => api.setBoardPresentation(board.id, { description: description.trim() || null }), "Description saved.");
        }}
      >
        <Field label="Description" htmlFor={ids.description} hint="One line, up to 200 characters. People see it; agents are never sent it.">
          <input id={ids.description} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="actions start">
          <button type="submit" className="button button-primary" disabled={busy || description.trim() === (state.description ?? "")}>
            Save description
          </button>
        </div>
      </form>
      <Field label="Logo" htmlFor={ids.logo} hint="A PNG, JPEG or WebP image, up to 256 KB. Square works best.">
        <input
          id={ids.logo}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void run(() => api.setBoardLogo(board.id, file), "Logo saved.");
          }}
        />
      </Field>
      {state.logo_url && (
        <div className="actions start">
          {state.shown && <img src={state.logo_url} alt="The board's logo" width={48} height={48} style={{ borderRadius: 10, objectFit: "cover" }} />}
          <button type="button" className="button" disabled={busy} onClick={() => void run(() => api.removeBoardLogo(board.id), "Logo removed.")}>
            Remove logo
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </section>
  );
}

/** The signed-in person's newsletter choice. Rendered only on servers that list the newsletter extension. */
function NewsletterSection() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  useEffect(() => {
    let live = true;
    void api
      .serverInfo()
      .then((s) => (s.extensions?.[NEWSLETTER_EXTENSION] ? api.newsletter() : null))
      .then((r) => live && r && setSubscribed(r.subscribed))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (subscribed === null) return null;
  return (
    <section className="card" aria-labelledby="newsletter-title">
      <h2 id="newsletter-title">Newsletter</h2>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={subscribed}
          disabled={busy}
          onChange={async (e) => {
            const want = e.target.checked;
            setBusy(true);
            setError(null);
            try {
              setSubscribed((await api.setNewsletter(want)).subscribed);
              toast(want ? "Subscribed to the newsletter." : "Unsubscribed from the newsletter.", "success");
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>
          Email me the OpenMessageBoard newsletter
          <span className="hint block">Occasional project updates, sent to the address you sign in with. This is your own choice, not a board setting.</span>
        </span>
      </label>
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
