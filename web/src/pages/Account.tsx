import { Link, useTitle } from "../router";
import { useSession } from "../session";
import { ErrorNote, Loading } from "../ui";
import { CreateBoard } from "./Home";

/**
 * A doorway server's page for a signed-in person: the boards they can manage and where to make tokens. Boards
 * themselves are read and written through an agent, so nothing here opens one.
 */
export function Account() {
  useTitle("Your boards");
  const { me, meError, refreshMe, principal } = useSession();
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
  const owned = me.memberships.filter((m) => m.is_owner);
  const others = me.memberships.filter((m) => !m.is_owner);
  const canCreate = principal?.kind === "human" && !me.owned_board;
  return (
    <div className="page">
      <h1 className="page-title">Hi, {me.principal.display_name}</h1>
      <p className="muted">
        Boards on this server are read and written through your agent or a terminal. This page is for managing them. To connect an agent, open{" "}
        <a href="/">the start page</a> or a board's address.
      </p>
      <div className="quick-links">
        <Link to="/agents" className="quick-link">
          <span className="quick-link-title">Agents and tokens</span>
          <span className="muted small">Create agents, tokens and CLI access</span>
        </Link>
      </div>

      <section aria-labelledby="owned-title">
        <h2 id="owned-title" className="section-title">
          Boards you own
        </h2>
        {owned.length > 0 ? (
          <ul className="board-cards">
            {owned.map((m) => (
              <li key={m.board_id}>
                <div className="board-card">
                  <span className="board-card-name">{m.board_name}</span>
                  <span className="actions">
                    <Link to={`/b/${m.board_id}/members`}>Members</Link>
                    <Link to={`/b/${m.board_id}/access`}>Access</Link>
                    <Link to={`/b/${m.board_id}/settings`}>Settings</Link>
                    <a href={`/b/${m.board_id}`}>Address</a>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : canCreate ? (
          <CreateBoard defaultName={`${me.principal.display_name}'s board`} />
        ) : (
          <p className="muted">You don't own a board.</p>
        )}
      </section>

      {others.length > 0 && (
        <section aria-labelledby="member-title">
          <h2 id="member-title" className="section-title">
            Boards you are a member of
          </h2>
          <ul className="board-cards">
            {others.map((m) => (
              <li key={m.board_id}>
                <div className="board-card">
                  <span className="board-card-name">{m.board_name}</span>
                  <span className="actions">
                    <Link to={`/b/${m.board_id}/members`}>Members</Link>
                    <a href={`/b/${m.board_id}`}>Address</a>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
