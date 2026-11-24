import type { Member } from "@openmessageboard/protocol";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MAX_MENTIONS, newIdempotencyKey } from "./format";
import { Markdown } from "./markdown";
import { Avatar } from "./ui";

type MentionQuery = { start: number; text: string };

const MENTION_BEFORE_CARET = /(?:^|[\s(])@([A-Za-z0-9_.-]{0,32})$/;

/** Maps @handles in a body to member principal IDs (at most 10, in order). */
export function extractMentions(body: string, members: Member[]): string[] {
  const byHandle = new Map(members.map((m) => [m.handle.toLowerCase(), m.principal.id]));
  const ids: string[] = [];
  for (const match of body.matchAll(/(?:^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]+)/g)) {
    const handle = match[1]!.replace(/[.]+$/, "").toLowerCase();
    const id = byHandle.get(handle);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_MENTIONS);
}

type Props = {
  id: string;
  value: string;
  onChange: (v: string) => void;
  members: Member[];
  placeholder?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  describedBy?: string;
  onSubmitShortcut?: () => void;
  autoFocus?: boolean;
};

/** Textarea with @mention autocomplete from board members (combobox pattern). */
export function MentionTextarea({
  id,
  value,
  onChange,
  members,
  placeholder,
  rows = 4,
  required,
  disabled,
  describedBy,
  onSubmitShortcut,
  autoFocus,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);

  const options = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return members
      .filter((m) => m.handle.toLowerCase().startsWith(q) || m.principal.display_name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, members]);
  const open = query !== null && options.length > 0;

  function updateQuery(el: HTMLTextAreaElement) {
    const caret = el.selectionStart ?? el.value.length;
    if (caret !== el.selectionEnd) return setQuery(null);
    const m = MENTION_BEFORE_CARET.exec(el.value.slice(0, caret));
    setQuery(m ? { start: caret - m[1]!.length - 1, text: m[1]! } : null);
    setActive(0);
  }

  function pick(member: Member) {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const insert = `@${member.handle} `;
    const next = value.slice(0, query.start) + insert + value.slice(caret);
    onChange(next);
    setQuery(null);
    const pos = query.start + insert.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmitShortcut) {
      e.preventDefault();
      onSubmitShortcut();
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref}
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        role="combobox"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          onChange(e.target.value);
          updateQuery(e.target);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => updateQuery(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
      />
      <ul id={listId} role="listbox" className="mention-list" hidden={!open} aria-label="Mention a member">
        {open &&
          options.map((m, i) => (
            <li
              key={m.principal.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar name={m.principal.display_name} kind={m.principal.kind} />
              <span className="mention-name">{m.principal.display_name}</span>
              <span className="mention-handle">@{m.handle}</span>
              {m.principal.via && <span className="mention-via">via {m.principal.via.display_name}</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Write / Preview tabs around a mention textarea. */
export function MarkdownEditor(props: Props & { label: string; hint?: string }) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const hintId = useId();
  const { label, hint, ...rest } = props;
  return (
    <div className="field md-editor">
      <div className="md-editor-head">
        <label htmlFor={props.id}>{label}</label>
        <div className="tabs-mini" role="group" aria-label="Editor mode">
          <button type="button" aria-pressed={tab === "write"} onClick={() => setTab("write")}>
            Write
          </button>
          <button type="button" aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>
            Preview
          </button>
        </div>
      </div>
      <div hidden={tab !== "write"}>
        <MentionTextarea {...rest} describedBy={hintId} />
      </div>
      {tab === "preview" && (
        <div className="md-preview" aria-live="polite">
          {props.value.trim() ? <Markdown source={props.value} /> : <p className="muted">Nothing to preview yet.</p>}
        </div>
      )}
      <div id={hintId} className="hint">
        {hint ?? "Markdown supported. Type @ to mention a member. Ctrl+Enter or ⌘+Enter to send."}
      </div>
    </div>
  );
}

/**
 * One idempotency key per distinct payload: retrying the same content reuses
 * the key (so a lost response never posts twice); changing it starts fresh.
 */
export function useIdempotencyKey() {
  const ref = useRef<{ key: string; payload: string } | null>(null);
  return {
    keyFor(payload: unknown): string {
      const json = JSON.stringify(payload);
      if (!ref.current || ref.current.payload !== json) ref.current = { key: newIdempotencyKey(), payload: json };
      return ref.current.key;
    },
    reset() {
      ref.current = null;
    },
  };
}
