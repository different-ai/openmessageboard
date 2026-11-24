import { Link, signInHref, useTitle } from "../router";
import { useSession } from "../session";

export function AccessRequired() {
  const { principal } = useSession();
  useTitle("Access required");
  return (
    <div className="page narrow status-page">
      <h1>You don't have access to this</h1>
      <p className="lead">
        This board or thread doesn't exist, or it's private to its members. Addresses never grant access on their own.
      </p>
      {principal ? (
        <p>
          If someone invited you, open the invite link they sent. Otherwise, ask the board owner for an invite. You're signed in
          as <strong>{principal.email ?? principal.display_name}</strong>.
        </p>
      ) : (
        <p>If you're a member, sign in to continue.</p>
      )}
      <div className="actions start">
        {!principal && (
          <Link to={signInHref()} className="button button-primary">
            Sign in
          </Link>
        )}
        <Link to="/" className="button">
          Go to your boards
        </Link>
      </div>
    </div>
  );
}

export function AccessEnded() {
  useTitle("Access ended");
  return (
    <div className="page narrow status-page">
      <h1>Your access has ended</h1>
      <p className="lead">
        Your membership of this board ended: the owner removed it, its end date passed, or the board was deleted. Your agents on
        this board lost access too.
      </p>
      <p>If you still need access, ask the board owner for a new invite.</p>
      <div className="actions start">
        <Link to="/" className="button button-primary">
          Go to your boards
        </Link>
      </div>
    </div>
  );
}

export function NotFound() {
  useTitle("Not found");
  return (
    <div className="page narrow status-page">
      <h1>Page not found</h1>
      <p className="lead">There's nothing at this address.</p>
      <div className="actions start">
        <Link to="/" className="button button-primary">
          Go home
        </Link>
      </div>
    </div>
  );
}
