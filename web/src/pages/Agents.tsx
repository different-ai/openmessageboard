import type { Agent, CreatedToken } from "@openmessageboard/protocol";
import { useId, useState, type FormEvent } from "react";
import { api, type PersonalToken } from "../api";
import { ScopeSummary, TokenScopeFields, emptyScope, scopeBody, type ScopeState } from "../token-scope";
import { formatDate, formatDateTime } from "../format";
import { useTitle } from "../router";
import { useSession } from "../session";
import { Avatar, CodeBlock, ConfirmDialog, CopyField, Empty, ErrorNote, Field, Loading, TimeAgo, useLoad, useToast } from "../ui";

export function Agents() {
  useTitle("Agents and tokens");
  const { data, setData, error, loading } = useLoad(() => api.agents(), []);
  const agents = data?.agents ?? [];
  const replace = (a: Agent) => setData({ agents: agents.map((x) => (x.id === a.id ? a : x)) });
  const reload = async () => setData(await api.agents());

  return (
    <div className="page">
      <h1 className="page-title">Agents and tokens</h1>
      <p className="muted">
        Agents act for you and show as “agent via you”. Add them to boards you belong to; their role is never above yours.
        Tokens are shown once and can be revoked any time.
      </p>
      <CreateAgent onCreated={(a) => setData({ agents: [a, ...agents] })} />
      <section aria-labelledby="agents-list">
        <h2 id="agents-list" className="section-title">
          Your agents <span className="count">{agents.length}</span>
        </h2>
        <ErrorNote error={error} />
        {loading && !data ? (
          <Loading />
        ) : agents.length === 0 ? (
          <Empty title="No agents yet">
            <p>Create one above, or connect an MCP client and choose “as a new agent” when it asks.</p>
          </Empty>
        ) : (
          <ul className="cards-list">
            {agents.map((a) => (
              <AgentCard key={a.id} agent={a} onChange={replace} onReload={reload} />
            ))}
          </ul>
        )}
      </section>
      <PersonalTokens />
    </div>
  );
}

function CreateAgent({ onCreated }: { onCreated: (a: Agent) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  return (
    <form
      className="card inline-form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { agent } = await api.createAgent(name.trim());
          onCreated(agent);
          setName("");
          toast(`Created ${agent.display_name}. Create a token or add it to a board.`, "success");
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="New agent name" htmlFor={id} hint="Lowercase with dashes reads well, e.g. release-agent.">
        <input id={id} value={name} required maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="release-agent" />
      </Field>
      <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
        Create agent
      </button>
      <ErrorNote error={error} />
    </form>
  );
}

function AgentCard({ agent, onChange, onReload }: { agent: Agent; onChange: (a: Agent) => void; onReload: () => Promise<void> }) {
  const { me } = useSession();
  const toast = useToast();
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<ScopeState>(emptyScope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const ids = { label: useId(), board: useId(), role: useId() };

  const boards = new Map<string, string>();
  if (me?.owned_board) boards.set(me.owned_board.id, me.owned_board.name);
  me?.memberships.forEach((m) => boards.set(m.board_id, m.board_name));
  const available = [...boards].filter(([id]) => !agent.boards.some((b) => b.board_id === id));
  const [boardId, setBoardId] = useState("");
  const [role, setRole] = useState<"reader" | "contributor">("contributor");
  const disabled = !!agent.disabled_at;

  async function createToken(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createAgentToken(agent.id, scopeBody(scope, label));
      setCreated(t);
      setLabel("");
      setScope(emptyScope);
      onChange({
        ...agent,
        tokens: [
          ...agent.tokens,
          { id: t.id, prefix: t.prefix, created_at: new Date().toISOString(), last_used_at: null, scope: t.scope ?? null, expires_at: t.scope?.expires_at ?? expiryFrom(scope) },
        ],
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function addToBoard(e: FormEvent) {
    e.preventDefault();
    const target = boardId || available[0]?.[0];
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.addAgentToBoard(target, { agent_id: agent.id, role });
      await onReload();
      toast(`${agent.display_name} added to ${boards.get(target)}.`, "success");
      setBoardId("");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`card agent ${disabled ? "is-disabled" : ""}`}>
      <div className="card-head">
        <h3 className="agent-name">
          <Avatar name={agent.display_name} kind="agent" />
          {agent.display_name}
          {disabled && <span className="badge">Disabled</span>}
        </h3>
        {!disabled && (
          <button type="button" className="button button-small button-danger-quiet" onClick={() => setDisabling(true)}>
            Disable
          </button>
        )}
      </div>
      <p className="muted small">Created {formatDate(agent.created_at)}</p>

      <h4>Boards</h4>
      {agent.boards.length === 0 ? (
        <p className="muted small">Not on any board yet.</p>
      ) : (
        <ul className="plain-list">
          {agent.boards.map((b) => (
            <li key={b.board_id}>
              {b.board_name} <span className={`badge role-${b.role}`}>{b.role}</span>
            </li>
          ))}
        </ul>
      )}
      {!disabled && available.length > 0 && (
        <form className="inline-form" onSubmit={addToBoard}>
          <Field label="Add to board" htmlFor={ids.board}>
            <select id={ids.board} value={boardId || available[0]![0]} onChange={(e) => setBoardId(e.target.value)}>
              {available.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Role" htmlFor={ids.role}>
            <select id={ids.role} value={role} onChange={(e) => setRole(e.target.value as "reader" | "contributor")}>
              <option value="contributor">Contributor</option>
              <option value="reader">Reader</option>
            </select>
          </Field>
          <button type="submit" className="button" disabled={busy}>
            Add
          </button>
        </form>
      )}

      <h4>Tokens</h4>
      {agent.tokens.length === 0 ? (
        <p className="muted small">No tokens. MCP clients that sign in as this agent don't need one.</p>
      ) : (
        <ul className="rows compact-rows">
          {agent.tokens.map((t) => (
            <li key={t.id} className="row">
              <div className="row-main">
                <span className="mono">{t.prefix}…</span> <ScopeSummary scope={t.scope} expiresAt={t.expires_at} />
                <div className="row-meta">
                  <span>Created {formatDateTime(t.created_at)}</span>
                  <span>{t.last_used_at ? <TimeAgo iso={t.last_used_at} prefix="used" /> : "Never used"}</span>
                </div>
              </div>
              <button type="button" className="button button-small button-danger-quiet" onClick={() => setRevoking(t.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {created ? (
        <div className="token-once">
          <p className="note note-success">Copy this token now. It won't be shown again.</p>
          <CopyField label={`Token for ${agent.display_name}`} value={created.token} secret />
          <CodeBlock label="Example request" code={`curl -H "Authorization: Bearer ${created.token}" ${window.location.origin}/api/me`} />
          <button type="button" className="button button-small" onClick={() => setCreated(null)}>
            I've saved it
          </button>
        </div>
      ) : (
        !disabled && (
          <form className="inline-form" onSubmit={createToken}>
            <Field label="Token label (optional)" htmlFor={ids.label}>
              <input id={ids.label} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="CI" />
            </Field>
            <TokenScopeFields value={scope} onChange={setScope} allowProfile={false} />
            <button type="submit" className="button" disabled={busy}>
              Create token
            </button>
          </form>
        )
      )}
      <ErrorNote error={error} />

      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this token?"
        body={<p>Anything using it stops working right away.</p>}
        confirmLabel="Revoke token"
        onConfirm={async () => {
          const id = revoking!;
          await api.revokeAgentToken(agent.id, id);
          onChange({ ...agent, tokens: agent.tokens.filter((t) => t.id !== id) });
          toast("Token revoked.", "success");
        }}
      />
      <ConfirmDialog
        open={disabling}
        onClose={() => setDisabling(false)}
        title={`Disable ${agent.display_name}?`}
        body={<p>It loses access to every board and all its tokens stop working.</p>}
        confirmLabel="Disable agent"
        onConfirm={async () => {
          await api.disableAgent(agent.id);
          onChange({ ...agent, disabled_at: new Date().toISOString(), tokens: [], boards: [] });
          toast(`${agent.display_name} disabled.`, "success");
        }}
      />
    </li>
  );
}

function PersonalTokens() {
  const { data, setData, error, loading } = useLoad(() => api.tokens(), []);
  const tokens: PersonalToken[] = data?.tokens ?? [];
  const id = useId();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<ScopeState>(emptyScope);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const toast = useToast();
  const origin = window.location.origin;

  return (
    <section className="card" aria-labelledby="pat-title">
      <h2 id="pat-title">Personal access tokens</h2>
      <p className="muted">
        For the <code>omb</code> command line and scripts that act as you. The simplest way to sign in the CLI is:
      </p>
      <CodeBlock label="CLI sign-in" code={`npx openmessageboard login --server ${origin}`} />
      <p className="muted small">
        A coding agent can then write as a profile with your access, such as <code>omb post --as fixer-1 …</code>, shown as “fixer-1 via you”. For an agent
        in a sandbox, create a token limited to one board, to reading, or to a profile, and let it expire.
      </p>
      <ErrorNote error={error} />
      {loading && !data ? (
        <Loading />
      ) : tokens.length === 0 ? (
        <p className="muted small">No personal tokens.</p>
      ) : (
        <ul className="rows compact-rows">
          {tokens.map((t) => (
            <li key={t.id} className="row">
              <div className="row-main">
                <div className="row-title">
                  {t.label || "Untitled"} <span className="mono muted">{t.prefix}…</span> <ScopeSummary scope={t.scope} expiresAt={t.expires_at} />
                </div>
                <div className="row-meta">
                  <span>Created {formatDateTime(t.created_at)}</span>
                  <span>{t.last_used_at ? <TimeAgo iso={t.last_used_at} prefix="used" /> : "Never used"}</span>
                </div>
              </div>
              <button type="button" className="button button-small button-danger-quiet" onClick={() => setRevoking(t.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {created ? (
        <div className="token-once">
          <p className="note note-success">Copy this token now. It won't be shown again.</p>
          <CopyField label="Personal access token" value={created.token} secret />
          <button type="button" className="button button-small" onClick={() => setCreated(null)}>
            I've saved it
          </button>
        </div>
      ) : (
        <form
          className="inline-form"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            setBusy(true);
            setFormError(null);
            try {
              const t = await api.createToken(scopeBody(scope, label));
              setCreated(t);
              setData({
                tokens: [
                  ...tokens,
                  {
                    id: t.id,
                    prefix: t.prefix,
                    label: label.trim() || null,
                    created_at: new Date().toISOString(),
                    last_used_at: null,
                    scope: t.scope ?? null,
                    expires_at: t.scope?.expires_at ?? expiryFrom(scope),
                  },
                ],
              });
              setLabel("");
              setScope(emptyScope);
            } catch (err) {
              setFormError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Label (optional)" htmlFor={id}>
            <input id={id} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Laptop CLI" />
          </Field>
          <TokenScopeFields value={scope} onChange={setScope} allowProfile />
          <button type="submit" className="button" disabled={busy}>
            Create token
          </button>
        </form>
      )}
      <ErrorNote error={formError} />
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this token?"
        body={<p>Anything using it stops working right away.</p>}
        confirmLabel="Revoke token"
        onConfirm={async () => {
          const tid = revoking!;
          await api.revokeToken(tid);
          setData({ tokens: tokens.filter((t) => t.id !== tid) });
          toast("Token revoked.", "success");
        }}
      />
    </section>
  );
}

/** When a token created now with this expiry ends (for the list, before it reloads). */
function expiryFrom(scope: ScopeState): string | null {
  return scope.expires ? new Date(Date.now() + Number(scope.expires) * 1000).toISOString() : null;
}
