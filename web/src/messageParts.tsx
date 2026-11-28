import type { Attachment, Block, Member, Message } from "@openmessageboard/protocol";
import { COMMON_REACTIONS, emojiChar } from "@openmessageboard/protocol/emoji";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, isApiError } from "./api";
import { MarkdownEditor } from "./composer";
import { formatBytes, formatDateTime, labelError, MAX_LABELS } from "./format";
import { ErrorNote, LabelChips, errorText, useToast } from "./ui";

/** Replaces a message with a new snapshot, or derives the next one from the current state. */
export type MessageUpdate = (next: Message | ((current: Message) => Message)) => void;

/** Authors may edit their own messages, and people may edit what their agents wrote. */
export function canEditMessage(m: Message, meId: string, canWrite: boolean): boolean {
  return canWrite && !m.deleted && !m.source && (m.author.id === meId || m.author.via?.id === meId);
}

/* ---------- Edited marker ---------- */

export function EditedMark({ m }: { m: Message }) {
  if (!m.edited_at || m.deleted) return null;
  const when = formatDateTime(m.edited_at);
  return (
    <span className="message-edited" title={`Edited ${when}`}>
      edited<span className="visually-hidden"> {when}</span>
    </span>
  );
}

/* ---------- Inline editor ---------- */

/** Finds the current copy of a message by reading the thread page by page. */
async function latestMessage(threadId: string, messageId: string): Promise<Message | null> {
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await api.thread(threadId, cursor);
    const found = page.messages.find((x) => x.id === messageId);
    if (found) return found;
    if (!page.next_page_cursor) return null;
    cursor = page.next_page_cursor;
  }
  return null;
}

export function MessageEditor({
  m,
  members,
  onUpdate,
  onClose,
}: {
  m: Message;
  members: Member[];
  onUpdate: MessageUpdate;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(m.body ?? "");
  // The revision the draft started from; saving fails with revision_conflict if the message moved on.
  const [base, setBase] = useState(m.revision);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const conflict = isApiError(error, "revision_conflict");
  // Your own save can come back on the live stream before its response; don't flag that.
  const changedLive = !conflict && !busy && m.revision !== base;

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !draft.trim()) return;
    if (draft === m.body) return onClose();
    setBusy(true);
    setError(null);
    try {
      const res = await api.editMessage(m.id, { body: draft, revision: base });
      onUpdate(res.message);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadLatest() {
    setReloading(true);
    setError(null);
    try {
      // A live update may already have brought the newer copy.
      const latest = m.revision !== base ? m : await latestMessage(m.thread_id, m.id);
      if (!latest) throw new Error("This message is no longer in the thread.");
      onUpdate(latest);
      if (latest.deleted) return onClose();
      setDraft(latest.body ?? "");
      setBase(latest.revision);
    } catch (err) {
      setError(err);
    } finally {
      setReloading(false);
    }
  }

  const stale = conflict || changedLive;
  return (
    <form className="message-editor" onSubmit={save} aria-label="Edit message">
      <MarkdownEditor
        id={`edit-${m.id}`}
        label="Edit message"
        value={draft}
        onChange={setDraft}
        members={members}
        rows={4}
        autoFocus
        hint="Markdown supported. Type @ to mention a member. Ctrl+Enter or ⌘+Enter to save."
        onSubmitShortcut={() => void save()}
      />
      {stale ? (
        <div className="note note-warning edit-conflict" role="alert">
          <p>
            {conflict
              ? "Someone changed this message since you opened it. Reload it to see the latest version, then edit again."
              : "This message changed while you were editing it. Load the latest version before you save."}{" "}
            Loading it replaces your draft.
          </p>
          <button type="button" className="button button-small" onClick={loadLatest} disabled={reloading}>
            {reloading ? "Loading…" : "Load latest version"}
          </button>
        </div>
      ) : (
        <ErrorNote error={error} />
      )}
      <div className="actions">
        <button type="button" className="button button-small" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button button-small button-primary" disabled={busy || !draft.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ---------- Reactions ---------- */

const emojiText = (name: string) => emojiChar(name) ?? `:${name}:`;
const emojiName = (name: string) => name.replace(/_/g, " ");

/** The message with the viewer's reaction added or removed, for an optimistic update. */
function withReaction(m: Message, emoji: string, add: boolean): Message {
  const list = m.reactions.slice();
  const i = list.findIndex((r) => r.emoji === emoji);
  const r = i === -1 ? null : list[i]!;
  if (add) {
    if (!r) list.push({ emoji, count: 1, me: true });
    else if (!r.me) list[i] = { ...r, count: r.count + 1, me: true };
  } else if (r?.me) {
    if (r.count <= 1) list.splice(i, 1);
    else list[i] = { ...r, count: r.count - 1, me: false };
  }
  return { ...m, reactions: list };
}

/** Toggles the viewer's reaction: updates at once, then settles on the server's copy. */
export function useReactionToggle(m: Message, onUpdate: MessageUpdate) {
  const toast = useToast();
  const pending = useRef(new Set<string>());
  return async (emoji: string) => {
    if (pending.current.has(emoji)) return;
    const mine = m.reactions.some((r) => r.emoji === emoji && r.me);
    pending.current.add(emoji);
    onUpdate((cur) => withReaction(cur, emoji, !mine));
    try {
      const res = await api.react(m.id, { emoji, remove: mine || undefined });
      onUpdate(res.message);
    } catch (e) {
      onUpdate((cur) => withReaction(cur, emoji, mine));
      toast(errorText(e), "error");
    } finally {
      pending.current.delete(emoji);
    }
  };
}

/** `readOnly` shows the counts to someone who can't react (reading through a public grant). */
export function ReactionChips({ m, onToggle, readOnly = false }: { m: Message; onToggle: (emoji: string) => void; readOnly?: boolean }) {
  if (!m.reactions.length) return null;
  return (
    <ul className="reactions" aria-label="Reactions">
      {m.reactions.map((r) => {
        const label = `${emojiName(r.emoji)}: ${r.count} ${r.count === 1 ? "reaction" : "reactions"}${r.me ? ", including yours" : ""}`;
        return (
          <li key={r.emoji}>
            <button
              type="button"
              className="reaction"
              aria-pressed={r.me}
              aria-label={label}
              disabled={readOnly}
              title={readOnly ? label : r.me ? `${label}. Click to remove yours.` : `${label}. Click to add yours.`}
              onClick={() => onToggle(r.emoji)}
            >
              <span className="reaction-emoji" aria-hidden="true">
                {emojiText(r.emoji)}
              </span>
              <span className="reaction-count" aria-hidden="true">
                {r.count}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** "Add reaction" button with a small popover of common emoji. Escape closes it and returns focus. */
export function ReactionPicker({ m, onToggle }: { m: Message; onToggle: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const buttons = Array.from(popRef.current?.querySelectorAll("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % buttons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = buttons.length - 1;
    if (to >= 0) {
      e.preventDefault();
      buttons[to]?.focus();
    }
  }

  return (
    <div
      ref={wrapRef}
      className="reaction-picker"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Tabbing out closes it; clicks outside are handled by the pointerdown listener.
        if (e.relatedTarget && !wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="link-button"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Add reaction
      </button>
      {open && (
        <div id={popId} ref={popRef} className="reaction-popover" role="group" aria-label="Pick a reaction">
          {COMMON_REACTIONS.map((name) => {
            const mine = m.reactions.some((r) => r.emoji === name && r.me);
            return (
              <button
                key={name}
                type="button"
                className="reaction-option"
                aria-pressed={mine}
                aria-label={emojiName(name)}
                title={emojiName(name)}
                onClick={() => {
                  onToggle(name);
                  close();
                }}
              >
                <span aria-hidden="true">{emojiText(name)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- Per-message labels ---------- */

export function MessageLabels({
  m,
  canEdit,
  adding,
  onCloseAdd,
  onUpdate,
}: {
  m: Message;
  canEdit: boolean;
  adding: boolean;
  onCloseAdd: () => void;
  onUpdate: MessageUpdate;
}) {
  const keyId = useId();
  const valueId = useId();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const count = Object.keys(m.labels).length;

  useEffect(() => {
    if (!adding) setError(null);
  }, [adding]);

  async function apply(body: { set?: Record<string, string>; unset?: string[]; if: Record<string, string | null> }) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.labelMessage(m.id, body);
      onUpdate(res.message);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const k = key.trim().toLowerCase();
    const v = value.trim();
    const err = labelError(k, v);
    if (err) return setError(new Error(err));
    if (!(k in m.labels) && count >= MAX_LABELS) return setError(new Error(`At most ${MAX_LABELS} labels.`));
    // Only change it while it still has the value shown here.
    if (await apply({ set: { [k]: v }, if: { [k]: m.labels[k] ?? null } })) {
      setKey("");
      setValue("");
      onCloseAdd();
    }
  }

  if (!count && !adding && !error) return null;
  return (
    <div className="message-labels">
      <LabelChips
        labels={m.labels}
        onRemove={canEdit ? (k) => void apply({ unset: [k], if: { [k]: m.labels[k] ?? null } }) : undefined}
        disabled={busy}
      />
      {adding && canEdit && (
        <form
          className="label-add label-add-inline"
          onSubmit={add}
          aria-label="Add a label to this message"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCloseAdd();
            }
          }}
        >
          <div className="field">
            <label htmlFor={keyId}>Key</label>
            <input id={keyId} value={key} onChange={(e) => setKey(e.target.value)} placeholder="state" autoCapitalize="none" autoFocus />
          </div>
          <div className="field">
            <label htmlFor={valueId}>Value</label>
            <input id={valueId} value={value} onChange={(e) => setValue(e.target.value)} placeholder="review" />
          </div>
          <div className="label-add-actions">
            <button type="submit" className="button button-small" disabled={busy || !key || !value}>
              Set
            </button>
            <button type="button" className="button button-small" onClick={onCloseAdd}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ErrorNote error={error} className="compact" />
    </div>
  );
}

/* ---------- Structured data ---------- */

function BlockValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="muted mono">null</span>;
  if (typeof v === "string") return <span className="block-text">{v}</span>;
  if (typeof v === "number" || typeof v === "boolean") return <span className="mono">{String(v)}</span>;
  return <pre className="block-json">{JSON.stringify(v, null, 2)}</pre>;
}

/** Shows data as plain text rows; never as HTML or Markdown. */
export function BlockList({ blocks }: { blocks: Block[] }) {
  if (!blocks.length) return null;
  return (
    <div className="blocks">
      {blocks.map((b, i) => {
        const id = `${b.schema}@${b.version}`;
        const entries = Object.entries(b.data);
        return (
          <div key={`${id}-${i}`} className="block-card" role="group" aria-label={`Structured data ${id}`}>
            <div className="block-head mono">{id}</div>
            {entries.length ? (
              <dl className="block-rows">
                {entries.map(([k, v]) => (
                  <div key={k}>
                    <dt className="mono">{k}</dt>
                    <dd>
                      <BlockValue v={v} />
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="muted small block-empty">No fields.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Attachments ---------- */

/** File chips that download; images are never shown inline. */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <ul className="attachments" aria-label="Attachments">
      {attachments.map((a) => (
        <li key={a.id}>
          <AttachmentLink a={a} />
        </li>
      ))}
    </ul>
  );
}

function AttachmentLink({ a }: { a: Attachment }) {
  const size = formatBytes(a.size);
  return (
    <a
      href={api.attachmentUrl(a.id)}
      download
      className="attachment"
      title={`${a.name} (${a.type || "file"}, ${size})`}
      aria-label={`Download ${a.name}, ${size}`}
    >
      <span className="attachment-icon" aria-hidden="true">
        📎
      </span>
      <span className="attachment-name">{a.name}</span>
      <span className="attachment-size">{size}</span>
    </a>
  );
}
