import { useEffect, useState } from "react";
import { api } from "../api";
import { Link, useTitle } from "../router";
import { useSession } from "../session";
import { ErrorNote, Loading, TimeAgo } from "../ui";

interface LinkInfo {
  email: string;
  same_browser: boolean;
  requested_at: string;
}

/**
 * The page the emailed sign-in link opens. Opening it does nothing: the person confirms with a button. Confirming
 * signs in the browser where the sign-in was started (this one, or one on another device), never the browser that
 * merely opened the link.
 */
export function SignInLink() {
  useTitle("Confirm sign-in");
  const { refresh } = useSession();
  // The token is in the fragment, which is never sent to the server; it is taken out of the address bar at once.
  const [token] = useState(() => window.location.hash.replace(/^#/, ""));
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<"here" | "elsewhere" | "cancelled" | null>(null);

  // A second link opened in this same tab changes only the fragment: start over with it.
  useEffect(() => {
    const again = () => window.location.hash.length > 1 && window.location.reload();
    window.addEventListener("hashchange", again);
    return () => window.removeEventListener("hashchange", again);
  }, []);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setLoadError(new Error("This sign-in link is incomplete. Open the link from your email again, or type the code from the email on the sign-in page."));
      return;
    }
    let live = true;
    api.signInLinkInspect(token).then(
      (i) => live && setInfo(i),
      (e) => live && setLoadError(e),
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const { same_browser } = await api.signInLinkConfirm(token);
      if (same_browser) {
        // This browser started the sign-in: collect the session here (the tab that is waiting does the same).
        await api.signInClaim();
        await refresh();
      }
      setDone(same_browser ? "here" : "elsewhere");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.signInLinkCancel(token);
      setDone("cancelled");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (done === "here") {
    body = (
      <>
        <h1>You're signed in</h1>
        <p className="muted">Go back to the tab where you started; it has continued. You can close this one.</p>
        <Link to="/" className="button button-block">
          Open OpenMessageBoard here
        </Link>
      </>
    );
  } else if (done === "elsewhere") {
    body = (
      <>
        <h1>Sign-in confirmed</h1>
        <p className="muted">The browser where you started is signing in now. You can close this page.</p>
      </>
    );
  } else if (done === "cancelled") {
    body = (
      <>
        <h1>Sign-in cancelled</h1>
        <p className="muted">Nobody was signed in, and this link no longer works.</p>
      </>
    );
  } else if (loadError) {
    body = (
      <>
        <h1>This link can't be used</h1>
        <ErrorNote error={loadError} />
        <Link to="/signin" className="button button-block">
          Go to sign in
        </Link>
      </>
    );
  } else if (!info) {
    body = <Loading />;
  } else {
    body = (
      <>
        <h1>Confirm sign-in</h1>
        <p>
          Sign in to OpenMessageBoard as <strong>{info.email}</strong>?
        </p>
        {info.same_browser ? (
          <p className="muted">
            You asked to sign in from this browser <TimeAgo iso={info.requested_at} />.
          </p>
        ) : (
          <p className="note note-warning" role="note">
            This was asked for <TimeAgo iso={info.requested_at} /> from a different browser or device. Confirming signs in <strong>that</strong> browser, not this one. Confirm only if
            you just asked to sign in yourself.
          </p>
        )}
        <ErrorNote error={error} />
        <button type="button" className="button button-primary button-block" onClick={() => void confirm()} disabled={busy}>
          {busy ? "Confirming…" : info.same_browser ? "Sign in" : "Yes, sign in my other browser"}
        </button>
        <button type="button" className="link-button" onClick={() => void cancel()} disabled={busy}>
          This wasn't me
        </button>
      </>
    );
  }

  return (
    <div className="page narrow auth-page">
      <div className="card auth-card stack">{body}</div>
    </div>
  );
}
