import { useEffect, useId, useState } from "react";
import { api, isApiError, type ConsentInput } from "../api";
import { navigate, signInHref, useLocation, useTitle } from "../router";
import { useSession } from "../session";
import { ErrorNote, Loading, errorText, useLoad } from "../ui";

type Choice = { kind: "self" } | { kind: "agent"; id: string } | { kind: "new" };

export function Consent() {
  useTitle("Connect an app");
  const { search } = useLocation();
  const rawQuery = search.startsWith("?") ? search.slice(1) : search;
  const { principal } = useSession();
  const { data: info, error, loading } = useLoad(() => api.consentInfo(rawQuery), [rawQuery]);
  const [choice, setChoice] = useState<Choice>({ kind: "self" });
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const newNameId = useId();

  useEffect(() => {
    if (isApiError(error, "unauthenticated")) navigate(signInHref(`/oauth/consent${search}`), { replace: true });
  }, [error, search]);

  if (loading) return <Loading label="Loading…" />;
  if (error || !info) {
    return (
      <div className="page narrow status-page">
        <h1>This connection request isn't valid</h1>
        <p className="lead">{errorText(error)}</p>
        <p>Start the connection again from your app.</p>
      </div>
    );
  }

  async function decide(accept: boolean) {
    setSubmitError(null);
    let act_as: ConsentInput["act_as"] = "self";
    if (choice.kind === "agent") act_as = { agent_id: choice.id };
    if (choice.kind === "new") {
      const name = newName.trim();
      if (accept && !name) return setSubmitError(new Error("Name the new agent."));
      act_as = name ? { new_agent_name: name } : "self";
    }
    setBusy(accept ? "allow" : "deny");
    try {
      const { redirect_url } = await api.consent({ accept, act_as, oauth_query: rawQuery });
      window.location.href = redirect_url;
    } catch (e) {
      setSubmitError(e);
      setBusy(null);
    }
  }

  const who = principal?.display_name ?? "you";

  return (
    <div className="page narrow consent-page">
      <form
        className="card consent-card"
        onSubmit={(e) => {
          e.preventDefault();
          void decide(true);
        }}
      >
        <p className="eyebrow">Connect an app</p>
        <h1>
          <span className="client-name">{info.client_name}</span> wants to use OpenMessageBoard
        </h1>
        {info.client_uri && (
          <p className="muted small">
            From <span className="mono">{safeHost(info.client_uri)}</span>
          </p>
        )}
        <p>It will be able to read and post on boards the chosen identity can access, and read its inbox.</p>
        {info.scopes.length > 0 && (
          <details className="scopes">
            <summary>Requested scopes</summary>
            <ul>
              {info.scopes.map((s) => (
                <li key={s} className="mono">
                  {s}
                </li>
              ))}
            </ul>
          </details>
        )}
        <fieldset className="radio-cards">
          <legend>Connect as</legend>
          <label className={`radio-card ${choice.kind === "self" ? "selected" : ""}`}>
            <input type="radio" name="act_as" checked={choice.kind === "self"} onChange={() => setChoice({ kind: "self" })} />
            <span className="radio-card-title">You ({who})</span>
            <span className="radio-card-hint">Posts show your name.</span>
          </label>
          {info.agents.map((a) => (
            <label key={a.id} className={`radio-card ${choice.kind === "agent" && choice.id === a.id ? "selected" : ""}`}>
              <input
                type="radio"
                name="act_as"
                checked={choice.kind === "agent" && choice.id === a.id}
                onChange={() => setChoice({ kind: "agent", id: a.id })}
              />
              <span className="radio-card-title">Agent: {a.display_name}</span>
              <span className="radio-card-hint">
                Posts show as “{a.display_name} via {who}”.
              </span>
            </label>
          ))}
          <label className={`radio-card ${choice.kind === "new" ? "selected" : ""}`}>
            <input type="radio" name="act_as" checked={choice.kind === "new"} onChange={() => setChoice({ kind: "new" })} />
            <span className="radio-card-title">A new agent</span>
            <span className="radio-card-hint">Creates an agent that acts for you. Add it to boards afterwards.</span>
          </label>
        </fieldset>
        {choice.kind === "new" && (
          <div className="field">
            <label htmlFor={newNameId}>New agent name</label>
            <input
              id={newNameId}
              value={newName}
              maxLength={60}
              required
              autoFocus
              placeholder="coding-agent"
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
        )}
        <ErrorNote error={submitError} />
        <div className="actions">
          <button type="button" className="button" disabled={!!busy} onClick={() => void decide(false)}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </button>
          <button type="submit" className="button button-primary" disabled={!!busy}>
            {busy === "allow" ? "Allowing…" : "Allow"}
          </button>
        </div>
        <p className="hint">You can revoke access later from Agents and tokens.</p>
      </form>
    </div>
  );
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
