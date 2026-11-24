import type { AllowanceUsage, Labels, PrincipalRef, TaskState } from "@openmessageboard/protocol";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "./api";
import { formatBytes, formatDateTime, formatNumber, formatRelative, TASK_STATE_LABEL } from "./format";

/* ---------- Toasts ---------- */

type Toast = { id: number; text: string; tone: "info" | "success" | "warning" | "error" };
const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ---------- Errors ---------- */

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "quota_exceeded") {
      const d = e.details as { allowance?: string; used?: number; limit?: number; resets_at?: string | null };
      const parts = [e.message];
      if (typeof d.used === "number" && typeof d.limit === "number") {
        const fmt = d.allowance === "storage" ? formatBytes : formatNumber;
        parts.push(`Used ${fmt(d.used)} of ${fmt(d.limit)}${d.allowance ? ` (${d.allowance.replace(/_/g, " ")})` : ""}.`);
      }
      if (d.resets_at) parts.push(`Resets ${formatDateTime(d.resets_at)}.`);
      return parts.join(" ");
    }
    if (e.code === "revision_conflict") {
      return "Someone changed this message since you opened it. Reload it to see the latest version, then edit again.";
    }
    if (e.code === "label_conflict") return "That label changed since you loaded it. Check the current labels and try again.";
    if (e.code === "attachment_too_large" && typeof e.details.limit === "number") {
      const size = typeof e.details.size === "number" ? `; this one is ${formatBytes(e.details.size)}` : "";
      return `Files can be up to ${formatBytes(e.details.limit)}${size}.`;
    }
    if (e.code === "rate_limited" && typeof e.details.retry_after_ms === "number") {
      return `${e.message} Try again in ${Math.ceil((e.details.retry_after_ms as number) / 1000)} s.`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p className={`note note-error ${className ?? ""}`} role="alert">
      {errorText(error)}
    </p>
  );
}

/* ---------- People, time, labels ---------- */

export function Author({ p, showKind = true }: { p: PrincipalRef; showKind?: boolean }) {
  return (
    <span className="author">
      <span className="author-name">{p.display_name}</span>
      {p.via && (
        <span className="author-via">
          {" "}
          via <span className="author-name">{p.via.display_name}</span>
        </span>
      )}
      {showKind && p.kind !== "human" && <span className={`kind-tag kind-${p.kind}`}>{p.kind === "agent" ? "agent" : "sync"}</span>}
    </span>
  );
}

export function Avatar({ name, kind }: { name: string; kind?: string }) {
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`avatar ${kind === "agent" ? "avatar-agent" : ""}`} data-hue={hash % 6} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}

export function TimeAgo({ iso, prefix }: { iso: string; prefix?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {prefix ? `${prefix} ` : ""}
      {formatRelative(iso)}
    </time>
  );
}

export function LabelChips({
  labels,
  onRemove,
  disabled,
}: {
  labels: Labels;
  onRemove?: (key: string) => void;
  disabled?: boolean;
}) {
  const entries = Object.entries(labels);
  if (!entries.length) return null;
  return (
    <ul className="chips" aria-label="Labels">
      {entries.map(([k, v]) => (
        <li key={k} className="chip">
          <span className="chip-key">{k}</span>
          <span className="chip-eq">=</span>
          <span className="chip-value">{v}</span>
          {onRemove && (
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove label ${k}=${v}`}
              disabled={disabled}
              onClick={() => onRemove(k)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TaskBadge({ state }: { state: TaskState }) {
  return <span className={`badge task-${state}`}>{TASK_STATE_LABEL[state]}</span>;
}

export function PlatformName({ platform }: { platform: string }) {
  const names: Record<string, string> = { slack: "Slack", github: "GitHub", linear: "Linear" };
  return <>{names[platform] ?? platform}</>;
}

/* ---------- Layout bits ---------- */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/* ---------- Copy ---------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyField({ label, value, multiline, secret }: { label: string; value: string; multiline?: boolean; secret?: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  async function copy() {
    const ok = await copyText(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else toast("Couldn't copy. Select the text and copy it manually.", "warning");
  }
  return (
    <div className="field copy-field">
      <label htmlFor={id}>{label}</label>
      <div className="copy-row">
        {multiline ? (
          <textarea id={id} readOnly value={value} rows={Math.min(8, value.split("\n").length)} className="mono" onFocus={(e) => e.currentTarget.select()} />
        ) : (
          <input id={id} readOnly value={value} className={`mono ${secret ? "secret" : ""}`} onFocus={(e) => e.currentTarget.select()} />
        )}
        <button type="button" className="button" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <pre aria-label={label}>
        <code>{code}</code>
      </pre>
      <button
        type="button"
        className="button button-small code-copy"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          if (await copyText(code)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ---------- Dialogs ---------- */

export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "dialog-wide" : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <header className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          <div className="dialog-body">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  danger = true,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="stack">
        <div>{body}</div>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`button ${danger ? "button-danger" : "button-primary"}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Usage ---------- */

const ALLOWANCE_LABEL: Record<string, string> = {
  posts: "Posts this month",
  storage: "Stored content",
  members: "Members, including agents",
  live_connections: "Live connections",
  webhook_subscriptions: "Webhook subscriptions",
  boards_owned: "Boards owned",
  agent_posts: "Agent posts today",
};

export function UsageMeter({ a }: { a: AllowanceUsage }) {
  const pct = a.limit > 0 ? Math.min(100, (a.used / a.limit) * 100) : 0;
  const fmt = a.unit === "bytes" ? formatBytes : formatNumber;
  const warn = a.warning || pct >= 80;
  const full = a.limit > 0 && a.used >= a.limit;
  const label = ALLOWANCE_LABEL[a.allowance] ?? a.allowance;
  return (
    <div className={`meter ${warn ? "meter-warn" : ""} ${full ? "meter-full" : ""}`}>
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {fmt(a.used)} of {fmt(a.limit)}
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={a.limit}
        aria-valuenow={a.used}
        aria-valuetext={`${fmt(a.used)} of ${fmt(a.limit)}`}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="meter-foot">
        {warn && <span className="meter-flag">{full ? "Limit reached" : `${Math.round(pct)}% used`}</span>}
        {a.resets_at && <span>Resets {formatDateTime(a.resets_at)}</span>}
      </div>
    </div>
  );
}

/* ---------- Async helper ---------- */

/** Runs a loader on mount and when deps change; exposes reload and local mutation. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    load(ctl.signal)
      .then((d) => {
        if (!ctl.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!ctl.signal.aborted) setLoading(false);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, setData, error, loading, reload };
}
