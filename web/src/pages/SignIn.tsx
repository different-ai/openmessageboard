import { useEffect, useId, useState, type FormEvent } from "react";
import type { ServerInfo } from "@openmessageboard/protocol";
import { api, NEWSLETTER_EXTENSION } from "../api";
import { navigate, safeNext, useSearchParams, useTitle } from "../router";
import { useSession } from "../session";
import { ErrorNote } from "../ui";

type AuthInfo = NonNullable<ServerInfo["auth"]> & { newsletter: boolean };
let authInfoCache: Promise<AuthInfo> | null = null;

/** How this server lets people sign in (an identity provider, an emailed link, or both). */
function useAuthInfo(): AuthInfo | null {
  const [info, setInfo] = useState<AuthInfo | null>(null);
  useEffect(() => {
    const fallback: AuthInfo = { providers: ["email"], oidc: null, newsletter: false };
    const pending: Promise<AuthInfo> = (authInfoCache ??= api
      .serverInfo()
      .then((s) => ({ ...(s.auth ?? fallback), newsletter: !!s.extensions?.[NEWSLETTER_EXTENSION] }))
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

function ProviderButton({ next, name, available, signUpUrl }: { next: string; name: string; available: boolean; signUpUrl: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.signInWithProvider(pendingAuthorization() ?? next);
      window.location.href = url;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <button type="button" className="button button-primary button-block" onClick={() => void go()} disabled={busy || !available}>
        {busy ? `Opening ${name}…` : `Continue with ${name}`}
      </button>
      {!available && <p className="note note-warning">Sign-in with {name} is temporarily unavailable. Try again in a moment.</p>}
      <ErrorNote error={error} />
      {signUpUrl && (
        <p className="hint">
          No account yet?{" "}
          <a href={signUpUrl} target="_blank" rel="noopener noreferrer">
            Create one
          </a>
          , then come back here.
        </p>
      )}
    </div>
  );
}

/** Sign-in: an identity provider and/or an emailed link (with a one-time code as a fallback), as the server allows. Calls onSignedIn after the session is set. */
export function SignInForm({ onSignedIn, compact, next = "/" }: { onSignedIn: () => void; compact?: boolean; next?: string }) {
  const auth = useAuthInfo();
  if (!auth) return null;
  const oidc = auth.providers.includes("oidc") ? auth.oidc : null;
  const email = auth.providers.includes("email");
  return (
    <div className={`stack signin-form ${compact ? "compact" : ""}`}>
      {oidc && <ProviderButton next={next} name={oidc.name} available={oidc.available} signUpUrl={oidc.sign_up_url} />}
      {oidc && email && <p className="muted center">or</p>}
      {email && <EmailCodeForm onSignedIn={onSignedIn} compact={compact} secondary={!!oidc} newsletter={auth.newsletter} />}
    </div>
  );
}

/**
 * Email sign-in. The email carries a link and a code. While this form waits, it asks the server whether the link was
 * confirmed (on this device or another) and continues by itself when it was; the code can be typed instead.
 */
function EmailCodeForm({ onSignedIn, compact, secondary, newsletter }: { onSignedIn: () => void; compact?: boolean; secondary?: boolean; newsletter?: boolean }) {
  const ids = { email: useId(), code: useId() };
  // Offered only by servers with the newsletter extension, and never ticked for the person.
  const [wantsNewsletter, setWantsNewsletter] = useState(false);
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
  const [expired, setExpired] = useState(false);

  async function finish() {
    const p = await refresh();
    if (!p) throw new Error("Signed in, but the session didn't start. Check that cookies are allowed for this site.");
    // The link or the code has just proved the address is theirs, so a ticked box subscribes it without a second
    // email. Sign-in never fails over this: the choice is also in Settings.
    if (newsletter && wantsNewsletter) await api.setNewsletter(true).catch(() => undefined);
    const resume = pendingAuthorization();
    if (resume) window.location.href = resume;
    else onSignedIn();
  }

  // Waiting for the link: it may be confirmed in another tab or on another device.
  useEffect(() => {
    if (step !== "code" || !sentAt) return;
    setExpired(false);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let status: "pending" | "signed_in" | "expired" = "pending";
      try {
        status = (await api.signInClaim()).status;
      } catch {
        // A dropped request: keep waiting.
      }
      if (!live) return;
      if (status === "signed_in") void finish().catch((err) => live && setError(err));
      else if (status === "expired") {
        // Signed in some other way meanwhile (another tab, the provider)? Then there is nothing to resend.
        const p = await refresh().catch(() => null);
        if (!live) return;
        if (p) void finish().catch((err) => live && setError(err));
        else setExpired(true);
      } else timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // Restarts with each email sent.
  }, [step, sentAt]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.startSignIn(email.trim());
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
      await finish();
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
        {newsletter && (
          <label className="checkbox">
            <input type="checkbox" checked={wantsNewsletter} onChange={(e) => setWantsNewsletter(e.target.checked)} />
            <span>
              Email me the OpenMessageBoard newsletter
              <span className="hint block">Occasional project updates. Optional: you can stop any time in Settings or from any issue.</span>
            </span>
          </label>
        )}
        <ErrorNote error={error} />
        <button type="submit" className={`button ${secondary ? "" : "button-primary"} button-block`} disabled={busy}>
          {busy ? "Sending…" : "Email me a sign-in link"}
        </button>
        <p className="hint">No password. We'll send a link to this address; you can open it on any device.</p>
      </form>
    );
  }

  return (
    <form className={`stack signin-form ${compact ? "compact" : ""}`} onSubmit={verify}>
      <p className="note" role="status">
        We sent a sign-in link to <strong>{email}</strong>. Open it on any device and confirm: this page continues by itself. It expires in 10 minutes.
      </p>
      {expired && <p className="note note-warning">That link has expired or was replaced. Send a new one below.</p>}
      <div className="field">
        <label htmlFor={ids.code}>Or type the code from the email</label>
        <input
          id={ids.code}
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9A-Za-z]{4,12}"
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
          placeholder="123456"
        />
      </div>
      <ErrorNote error={error} />
      <button type="submit" className="button button-block" disabled={busy}>
        {busy ? "Checking…" : "Sign in with the code"}
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
          {wait > 0 ? `Resend in ${wait}s` : "Send a new email"}
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
