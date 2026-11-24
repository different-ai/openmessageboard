import { useEffect, useId, useState, type FormEvent } from "react";
import type { ServerInfo } from "@openmessageboard/protocol";
import { api } from "../api";
import { navigate, safeNext, useSearchParams, useTitle } from "../router";
import { useSession } from "../session";
import { ErrorNote } from "../ui";

type AuthInfo = NonNullable<ServerInfo["auth"]>;
let authInfoCache: Promise<AuthInfo> | null = null;

/** How this server lets people sign in (OpenWork Cloud, email code, or both). */
function useAuthInfo(): AuthInfo | null {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  useEffect(() => {
    const fallback: AuthInfo = { providers: ["email"], openwork: null };
    const pending: Promise<AuthInfo> = (authInfoCache ??= api
      .serverInfo()
      .then((s) => s.auth ?? fallback)
      .catch(() => fallback));
    let live = true;
    void pending.then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/**
 * When an MCP client sent the person here to authorize, the sign-in page URL carries the signed authorization
 * request. After signing in, the browser goes back to the authorization endpoint to continue (consent comes next).
 */
export function pendingAuthorization(): string | null {
  const q = new URLSearchParams(window.location.search);
  return q.has("client_id") && q.has("response_type") && q.has("sig") ? `/api/auth/oauth2/authorize${window.location.search}` : null;
}

function OpenWorkButton({ next, available, signUpUrl }: { next: string; available: boolean; signUpUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.signInWithOpenWork(pendingAuthorization() ?? next);
      window.location.href = url;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <button type="button" className="button button-primary button-block" onClick={() => void go()} disabled={busy || !available}>
        {busy ? "Opening OpenWork…" : "Continue with OpenWork"}
      </button>
      {!available && <p className="note note-warning">OpenWork sign-in is temporarily unavailable. Try again in a moment.</p>}
      <ErrorNote error={error} />
      <p className="hint">
        Use your OpenWork Cloud account. New to OpenWork?{" "}
        <a href={signUpUrl} target="_blank" rel="noopener noreferrer">
          Create a free account
        </a>
        , then come back here.
      </p>
    </div>
  );
}

/** Sign-in: OpenWork Cloud and/or an email one-time code, as the server allows. Calls onSignedIn after the session is set. */
export function SignInForm({ onSignedIn, compact, next = "/" }: { onSignedIn: () => void; compact?: boolean; next?: string }) {
  const auth = useAuthInfo();
  if (!auth) return null;
  const openwork = auth.providers.includes("openwork") && auth.openwork;
  const email = auth.providers.includes("email");
  return (
    <div className={`stack signin-form ${compact ? "compact" : ""}`}>
      {openwork && <OpenWorkButton next={next} available={auth.openwork!.available} signUpUrl={auth.openwork!.sign_up_url} />}
      {openwork && email && <p className="muted center">or</p>}
      {email && <EmailCodeForm onSignedIn={onSignedIn} compact={compact} secondary={!!openwork} />}
    </div>
  );
}

/** Email one-time code sign-in. */
function EmailCodeForm({ onSignedIn, compact, secondary }: { onSignedIn: () => void; compact?: boolean; secondary?: boolean }) {
  const ids = { email: useId(), code: useId() };
  const { refresh } = useSession();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!sentAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sentAt]);
  const wait = sentAt ? Math.max(0, 30 - Math.floor((now - sentAt) / 1000)) : 0;

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.sendSignInCode(email.trim());
      setStep("code");
      setSentAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(email.trim(), code.trim());
      const p = await refresh();
      if (!p) throw new Error("Signed in, but the session didn't start. Check that cookies are allowed for this site.");
      const resume = pendingAuthorization();
      if (resume) window.location.href = resume;
      else onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (step === "email") {
    return (
      <form className={`stack signin-form ${compact ? "compact" : ""}`} onSubmit={send}>
        <div className="field">
          <label htmlFor={ids.email}>Email</label>
          <input
            id={ids.email}
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <ErrorNote error={error} />
        <button type="submit" className={`button ${secondary ? "" : "button-primary"} button-block`} disabled={busy}>
          {busy ? "Sending…" : "Email me a sign-in code"}
        </button>
        <p className="hint">No password. We'll send a one-time code to this address.</p>
      </form>
    );
  }

  return (
    <form className={`stack signin-form ${compact ? "compact" : ""}`} onSubmit={verify}>
      <p className="note" role="status">
        We sent a code to <strong>{email}</strong>. It expires in a few minutes.
      </p>
      <div className="field">
        <label htmlFor={ids.code}>Sign-in code</label>
        <input
          id={ids.code}
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9A-Za-z]{4,12}"
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
          placeholder="123456"
        />
      </div>
      <ErrorNote error={error} />
      <button type="submit" className="button button-primary button-block" disabled={busy}>
        {busy ? "Checking…" : "Sign in"}
      </button>
      <div className="actions between">
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setStep("email");
            setCode("");
            setError(null);
          }}
        >
          Use a different email
        </button>
        <button type="button" className="link-button" disabled={wait > 0 || busy} onClick={() => void send()}>
          {wait > 0 ? `Resend in ${wait}s` : "Resend code"}
        </button>
      </div>
    </form>
  );
}

export function SignIn() {
  useTitle("Sign in");
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { principal } = useSession();

  useEffect(() => {
    if (!principal) return;
    const resume = pendingAuthorization();
    if (resume) window.location.href = resume;
    else navigate(next, { replace: true });
  }, [principal, next]);

  return (
    <div className="page narrow auth-page">
      <div className="card auth-card">
        <h1>Sign in</h1>
        <p className="muted">
          {next.startsWith("/i/")
            ? "Sign in to accept your invite."
            : next.startsWith("/oauth/") || pendingAuthorization()
              ? "Sign in to connect your app."
              : "Sign in to OpenMessageBoard."}
        </p>
        <SignInForm next={next} onSignedIn={() => navigate(next, { replace: true })} />
      </div>
    </div>
  );
}
