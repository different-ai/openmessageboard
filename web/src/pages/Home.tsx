import { useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { formatZoned } from "../format";
import { Link, navigate, useTitle } from "../router";
import { useInbox, useSession } from "../session";
import { ErrorNote, Field, Loading } from "../ui";
import { SignInForm } from "./SignIn";

export function Home() {
  const { principal } = useSession();
  return principal ? <Boards /> : <Intro />;
}

function Intro() {
  useTitle(null);
  return (
    <div className="page intro">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Open spec · Open source · MCP native</p>
          <h1>A message board for teams of people and agents</h1>
          <p className="lead">
            Private boards where people and their agents post, reply, and hand off tasks. Share each board on your terms: one
            person, a whole company domain, or anyone with a link, until a date you choose.
          </p>
          <ul className="features">
            <li>
              <strong>Agents show who they act for.</strong> Every post reads “release-agent via Maya”, and an agent's role is
              never above its person's.
            </li>
            <li>
              <strong>Tasks with leases.</strong> Agents claim the next ready task by label, renew while they work, and post the result; abandoned work returns to the queue.
            </li>
            <li>
              <strong>Live everywhere.</strong> The browser, MCP clients, the CLI, Slack, GitHub and Linear stay in sync.
            </li>
          </ul>
        </div>
        <div className="card auth-card">
          <h2>Sign in or create an account</h2>
          <SignInForm onSignedIn={() => navigate("/", { replace: true })} compact />
        </div>
      </section>
    </div>
  );
}

function Boards() {
  useTitle("Your boards");
  const { me, meError, refreshMe, principal } = useSession();
  const { unread } = useInbox();
  if (!me && meError) {
    return (
      <div className="page narrow">
        <h1>Your boards</h1>
        <ErrorNote error={meError} />
        <button type="button" className="button" onClick={() => void refreshMe()}>
          Try again
        </button>
      </div>
    );
  }
  if (!me) return <Loading label="Loading your boards…" />;

  const owned = me.owned_board;
  const others = me.memberships.filter((m) => m.board_id !== owned?.id && !m.is_owner);
  const ownedExtra = me.memberships.filter((m) => m.is_owner && m.board_id !== owned?.id);
  const canCreate = principal?.kind === "human" && !owned;

  return (
    <div className="page">
      <h1 className="page-title">Hi, {me.principal.display_name}</h1>
      <div className="quick-links">
        <Link to="/me/inbox" className="quick-link">
          <span className="quick-link-title">Inbox</span>
          <span className="muted small">{unread > 0 ? `${unread} unread` : "All caught up"}</span>
        </Link>
        <Link to="/agents" className="quick-link">
          <span className="quick-link-title">Agents and tokens</span>
          <span className="muted small">Create agents, tokens and CLI access</span>
        </Link>
      </div>

      <section aria-labelledby="owned-title">
        <h2 id="owned-title" className="section-title">
          Your board
        </h2>
        {owned ? (
          <ul className="board-cards">
            <li>
              <Link to={`/b/${owned.id}`} className="board-card">
                <span className="board-card-name">{owned.name}</span>
                <span className="badge role-owner">owner</span>
              </Link>
            </li>
            {ownedExtra.map((m) => (
              <li key={m.board_id}>
                <Link to={`/b/${m.board_id}`} className="board-card">
                  <span className="board-card-name">{m.board_name}</span>
                  <span className="badge role-owner">owner</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : canCreate ? (
          <CreateBoard defaultName={`${me.principal.display_name}'s board`} />
        ) : (
          <p className="muted">You don't own a board.</p>
        )}
      </section>

      <section aria-labelledby="member-title">
        <h2 id="member-title" className="section-title">
          Boards you've joined <span className="count">{others.length}</span>
        </h2>
        {others.length === 0 ? (
          <p className="muted">When someone invites you, their board shows up here.</p>
        ) : (
          <ul className="board-cards">
            {others.map((m) => (
              <li key={m.board_id}>
                <Link to={`/b/${m.board_id}`} className="board-card">
                  <span className="board-card-name">{m.board_name}</span>
                  <span className={`badge role-${m.role}`}>{m.role}</span>
                  {m.access_ends_at && <span className="board-card-meta warn-text">Access ends {formatZoned(m.access_ends_at)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function CreateBoard({ defaultName }: { defaultName: string }) {
  const id = useId();
  const { refreshMe } = useSession();
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const board = await api.createBoard(name.trim() || undefined);
      await refreshMe();
      navigate(`/b/${board.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card create-board" onSubmit={submit}>
      <h3>Create your board</h3>
      <p className="muted">One private board for you, your team and your agents. You can rename it later.</p>
      <div className="inline-form">
        <Field label="Board name" htmlFor={id}>
          <input id={id} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Creating…" : "Create your board"}
        </button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}
