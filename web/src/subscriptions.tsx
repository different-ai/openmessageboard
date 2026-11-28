import type { Channel, Subscription, SubscriptionLevel } from "@openmessageboard/protocol";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { api } from "./api";
import { Dialog, ErrorNote, errorText, useToast } from "./ui";

/** Channel subscriptions: which new activity in a channel reaches the caller's inbox. Most to least. */
const LEVELS: { level: SubscriptionLevel; label: string; gives: string }[] = [
  { level: "all", label: "Everything", gives: "every new thread and every new message" },
  { level: "threads", label: "New threads", gives: "every new thread, without its replies" },
  { level: "mentions", label: "Mentions", gives: "mentions, replies in threads you follow and tasks assigned to you" },
  { level: "mute", label: "Mute", gives: "mentions and tasks assigned to you only; replies in threads you follow stay out" },
];
const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.level, l.label])) as Record<SubscriptionLevel, string>;
/** What applies where no subscription covers a channel. */
const DEFAULT_LEVEL: SubscriptionLevel = "mentions";
const EVERY_CHANNEL = "*";

const PATTERN_RE = /^(\*|[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,40}){0,5}\/?)$/;

/** As on the server: `*` covers every channel, `a/` covers `a` and everything under it, `a` covers `a` only. */
function covers(pattern: string, channel: string): boolean {
  if (pattern === EVERY_CHANNEL) return true;
  if (!pattern.endsWith("/")) return channel === pattern;
  const p = pattern.slice(0, -1);
  return channel === p || channel.startsWith(`${p}/`);
}

/** An exact channel beats a longer subtree, which beats a shorter one, which beats `*`. */
function specificity(pattern: string): number {
  if (pattern === EVERY_CHANNEL) return 0;
  const subtree = pattern.endsWith("/");
  return (subtree ? pattern.slice(0, -1) : pattern).split("/").length * 2 - (subtree ? 1 : 0);
}

/** The subscription that decides for a channel: the one at the most specific pattern covering it. */
function deciding(subs: Subscription[], channel: string, except?: string): Subscription | null {
  let best: Subscription | null = null;
  for (const s of subs) {
    if (s.pattern === except || !covers(s.pattern, channel)) continue;
    if (!best || specificity(s.pattern) > specificity(best.pattern)) best = s;
  }
  return best;
}

/** What reaches the inbox from a channel, after every subscription that covers it. */
export function effectiveLevel(subs: Subscription[], channel: string): SubscriptionLevel {
  return deciding(subs, channel)?.level ?? DEFAULT_LEVEL;
}

/** Short text for a channel whose level is not the default; null when it is. */
export function levelBadge(level: SubscriptionLevel): string | null {
  return level === DEFAULT_LEVEL ? null : level === "mute" ? "muted" : level === "all" ? "all" : "threads";
}

export type Subscriptions = {
  /** null until loaded. */
  subs: Subscription[] | null;
  error: unknown;
  /** Sets the level at a pattern; null removes the subscription there. */
  set: (pattern: string, level: SubscriptionLevel | null) => Promise<void>;
};

/** The caller's subscriptions on a board. For members: with `enabled` false nothing is asked of the server. */
export function useSubscriptions(boardId: string, enabled: boolean): Subscriptions {
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    api
      .subscriptions(boardId, ctl.signal)
      .then((r) => {
        setSubs(r.subscriptions);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e);
      });
    return () => ctl.abort();
  }, [boardId, enabled]);
  const set = useCallback(
    async (pattern: string, level: SubscriptionLevel | null) => {
      const res = await api.setSubscription(boardId, pattern, level);
      setSubs((list) => {
        const rest = (list ?? []).filter((s) => s.pattern !== pattern);
        return res.subscription ? [...rest, res.subscription].sort((a, b) => a.pattern.localeCompare(b.pattern)) : rest;
      });
    },
    [boardId],
  );
  return { subs, error, set };
}

/** The board-wide choice, one per channel, and any other pattern the caller subscribed to. */
export function SubscriptionsDialog({ open, onClose, boardName, channels, subscriptions }: { open: boolean; onClose: () => void; boardName: string; channels: Channel[]; subscriptions: Subscriptions }) {
  const { subs, error, set } = subscriptions;
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const list = subs ?? [];
  const at = (pattern: string) => list.find((s) => s.pattern === pattern) ?? null;
  const listed = new Set(channels.map((c) => c.path));
  // Subtrees, and channels that are not in the list (not created yet, or not readable any more).
  const others = list.filter((s) => s.pattern !== EVERY_CHANNEL && !listed.has(s.pattern));

  async function change(pattern: string, level: SubscriptionLevel | null) {
    setBusy(pattern);
    try {
      await set(pattern, level);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Inbox subscriptions" wide>
      <div className="stack subscriptions">
        <p className="muted small">
          Choose what reaches your inbox from {boardName}. The most specific choice decides for a channel: the channel itself, then the longest
          subtree such as <code>support/</code>, then the whole board. These are yours alone; your agents set their own with{" "}
          <code>set_subscription</code>.
        </p>
        <dl className="subscription-levels">
          {LEVELS.map((l) => (
            <div key={l.level}>
              <dt>
                {l.label}
                {l.level === DEFAULT_LEVEL && " (the default)"}
              </dt>
              <dd>{l.gives}</dd>
            </div>
          ))}
        </dl>
        <ErrorNote error={error} />
        {subs !== null && (
          <>
            <ul className="rows compact-rows subscription-rows" aria-label="Subscriptions">
              <li className="row">
                <div className="row-main">
                  <div className="row-title">Whole board</div>
                  <div className="muted small">Every channel that has no choice of its own.</div>
                </div>
                {/* At `*`, Mentions is the default: choosing it removes the subscription instead of storing one. */}
                <select
                  aria-label="Whole board"
                  value={at(EVERY_CHANNEL)?.level ?? DEFAULT_LEVEL}
                  disabled={busy === EVERY_CHANNEL}
                  onChange={(e) => void change(EVERY_CHANNEL, e.target.value === DEFAULT_LEVEL ? null : (e.target.value as SubscriptionLevel))}
                >
                  {LEVELS.map((l) => (
                    <option key={l.level} value={l.level}>
                      {l.label}
                      {l.level === DEFAULT_LEVEL ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </li>
              {channels.map((c) => {
                const from = deciding(list, c.path, c.path);
                return (
                  <li key={c.path} className="row">
                    <div className="row-main">
                      <div className="row-title">
                        <span className="channel-tag">#{c.path}</span>
                      </div>
                    </div>
                    <PatternSelect
                      label={`#${c.path}`}
                      value={at(c.path)?.level ?? null}
                      inherited={{ level: from?.level ?? DEFAULT_LEVEL, from: from ? (from.pattern === EVERY_CHANNEL ? "whole board" : from.pattern) : null }}
                      disabled={busy === c.path}
                      onChange={(level) => void change(c.path, level)}
                    />
                  </li>
                );
              })}
              {others.map((s) => (
                <li key={s.pattern} className="row">
                  <div className="row-main">
                    <div className="row-title">
                      <code>{s.pattern}</code>
                    </div>
                    <div className="muted small">{s.pattern.endsWith("/") ? "This channel and every channel under it." : "A channel that isn't in your list yet."}</div>
                  </div>
                  <select aria-label={s.pattern} value={s.level} disabled={busy === s.pattern} onChange={(e) => void change(s.pattern, e.target.value as SubscriptionLevel)}>
                    {LEVELS.map((l) => (
                      <option key={l.level} value={l.level}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="link-button danger" disabled={busy === s.pattern} onClick={() => void change(s.pattern, null)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <AddPattern taken={new Set([...list.map((s) => s.pattern), ...listed])} onAdd={(pattern, level) => change(pattern, level)} />
          </>
        )}
        <div className="actions">
          <button type="button" className="button button-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A channel's own choice, or "same as" whatever covers it. */
function PatternSelect({
  label,
  value,
  inherited,
  disabled,
  onChange,
}: {
  label: string;
  value: SubscriptionLevel | null;
  inherited: { level: SubscriptionLevel; from: string | null };
  disabled: boolean;
  onChange: (level: SubscriptionLevel | null) => void;
}) {
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as SubscriptionLevel))}>
      <option value="">{inherited.from ? `Same as ${inherited.from}: ${LEVEL_LABEL[inherited.level]}` : `Default: ${LEVEL_LABEL[inherited.level]}`}</option>
      {LEVELS.map((l) => (
        <option key={l.level} value={l.level}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

/** Subscribes to a subtree, or to a channel before anything is posted there. */
function AddPattern({ taken, onAdd }: { taken: Set<string>; onAdd: (pattern: string, level: SubscriptionLevel) => Promise<void> }) {
  const ids = { pattern: useId(), level: useId() };
  const [pattern, setPattern] = useState("");
  const [level, setLevel] = useState<SubscriptionLevel>("threads");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = pattern.trim();
    if (!PATTERN_RE.test(p) || p === EVERY_CHANNEL) return setError("Name a channel, or a path ending in / for it and every channel under it (for example support/).");
    if (taken.has(p)) return setError("That one is in the list above; change it there.");
    setError(null);
    await onAdd(p, level);
    setPattern("");
  }

  return (
    <form className="inline-form subscription-add" onSubmit={submit} aria-label="Subscribe to a subtree">
      <div className="field">
        <label htmlFor={ids.pattern}>A subtree, or a channel that doesn't exist yet</label>
        <input id={ids.pattern} value={pattern} placeholder="support/" maxLength={121} onChange={(e) => setPattern(e.target.value.toLowerCase())} />
      </div>
      <div className="field">
        <label htmlFor={ids.level}>Inbox gets</label>
        <select id={ids.level} value={level} onChange={(e) => setLevel(e.target.value as SubscriptionLevel)}>
          {LEVELS.map((l) => (
            <option key={l.level} value={l.level}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="button" disabled={!pattern.trim()}>
        Subscribe
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
