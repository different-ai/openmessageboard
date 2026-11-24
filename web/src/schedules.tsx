import type { Member, Schedule, ServerInfo } from "@openmessageboard/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, type ScheduleInput } from "./api";
import { useBoard } from "./board";
import { extractMentions } from "./composer";
import { formatDateTime, fromLocalInput, toLocalInput } from "./format";
import { excerpt } from "./markdown";
import { Author, ConfirmDialog, Dialog, ErrorNote, useLoad, useToast } from "./ui";

const UNITS: [string, number][] = [
  ["minutes", 60],
  ["hours", 3600],
  ["days", 86_400],
  ["weeks", 604_800],
];

/** "every 1 day", "every 30 minutes". */
export function intervalText(seconds: number): string {
  for (const [name, n] of [...UNITS].reverse()) {
    if (seconds % n === 0) {
      const v = seconds / n;
      return `every ${v === 1 ? "" : `${v} `}${v === 1 ? name.slice(0, -1) : name}`;
    }
  }
  return `every ${seconds} seconds`;
}

export function repeatText(s: Schedule): string {
  if (!s.every_seconds) return "Once";
  const parts = [intervalText(s.every_seconds)];
  if (s.times !== null) parts.push(`${s.times} times in all`);
  if (s.until) parts.push(`until ${formatDateTime(s.until)}`);
  const text = parts.join(", ");
  return text[0]!.toUpperCase() + text.slice(1);
}

let minRepeatCache: Promise<number> | null = null;
/** The server's shortest repeat interval, from discovery. */
function minRepeatSeconds(): Promise<number> {
  minRepeatCache ??= api
    .serverInfo()
    .then((i: ServerInfo) => i.limits.schedule_min_repeat_seconds ?? 60)
    .catch(() => 60);
  return minRepeatCache;
}

/** Schedules a reply in a thread from the composer's draft. */
export function ScheduleDialog({
  open,
  onClose,
  threadId,
  body,
  members,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  threadId: string;
  body: string;
  members: Member[];
  onScheduled: (s: Schedule) => void;
}) {
  const ids = { when: useId(), at: useId(), inN: useId(), inUnit: useId(), every: useId(), everyUnit: useId(), times: useId(), until: useId(), repeat: useId() };
  const [mode, setMode] = useState<"in" | "at">("in");
  const [inN, setInN] = useState("1");
  const [inUnit, setInUnit] = useState(86_400);
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3_600_000)));
  const [repeat, setRepeat] = useState(false);
  const [everyN, setEveryN] = useState("1");
  const [everyUnit, setEveryUnit] = useState(86_400);
  const [times, setTimes] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [minRepeat, setMinRepeat] = useState(60);
  useEffect(() => {
    if (open) {
      setError(null);
      void minRepeatSeconds().then(setMinRepeat);
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return setError(new Error("Write the reply in the composer first."));
    const input: ScheduleInput = { body, mentions: extractMentions(body, members) };
    if (!input.mentions?.length) delete input.mentions;
    if (mode === "in") {
      const n = Number(inN);
      if (!Number.isInteger(n) || n < 1) return setError(new Error("Enter a whole number for when it should post."));
      input.in_seconds = n * inUnit;
    } else {
      const iso = fromLocalInput(at);
      if (!iso) return setError(new Error("Pick a date and time."));
      input.at = iso;
    }
    if (repeat) {
      const n = Number(everyN);
      if (!Number.isInteger(n) || n < 1) return setError(new Error("Enter a whole number for the repeat interval."));
      input.every_seconds = n * everyUnit;
      if (input.every_seconds < minRepeat) return setError(new Error(`Repeats must be at least ${minRepeat} seconds apart.`));
      if (times) {
        const t = Number(times);
        if (!Number.isInteger(t) || t < 1) return setError(new Error("Times must be a whole number."));
        input.times = t;
      }
      if (until) {
        const iso = fromLocalInput(until);
        if (!iso) return setError(new Error("Pick a valid end time."));
        input.until = iso;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const { schedule } = await api.scheduleReply(threadId, input);
      onScheduled(schedule);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Schedule this reply">
      <form className="stack" onSubmit={submit} aria-label="Schedule a reply">
        <p className="muted small">It posts as you at that time, with the usual limits. It stops if you lose access to the board.</p>
        <blockquote className="schedule-preview">{excerpt(body, 200) || <span className="muted">Nothing written yet.</span>}</blockquote>
        <fieldset className="segmented-field">
          <legend>When</legend>
          <div className="segmented">
            <label className={`seg-radio ${mode === "in" ? "selected" : ""}`}>
              <input type="radio" name={ids.when} checked={mode === "in"} onChange={() => setMode("in")} />
              After a while
            </label>
            <label className={`seg-radio ${mode === "at" ? "selected" : ""}`}>
              <input type="radio" name={ids.when} checked={mode === "at"} onChange={() => setMode("at")} />
              At a time
            </label>
          </div>
        </fieldset>
        {mode === "in" ? (
          <div className="inline-fields">
            <label htmlFor={ids.inN}>In</label>
            <input id={ids.inN} type="number" min={1} value={inN} onChange={(e) => setInN(e.target.value)} className="narrow-input" />
            <label htmlFor={ids.inUnit} className="visually-hidden">
              Unit
            </label>
            <select id={ids.inUnit} value={inUnit} onChange={(e) => setInUnit(Number(e.target.value))}>
              {UNITS.map(([name, n]) => (
                <option key={name} value={n}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor={ids.at}>Post at</label>
            <input id={ids.at} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </div>
        )}
        <label className="checkbox" htmlFor={ids.repeat}>
          <input id={ids.repeat} type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span>Repeat</span>
        </label>
        {repeat && (
          <>
            <div className="inline-fields">
              <label htmlFor={ids.every}>Every</label>
              <input id={ids.every} type="number" min={1} value={everyN} onChange={(e) => setEveryN(e.target.value)} className="narrow-input" />
              <label htmlFor={ids.everyUnit} className="visually-hidden">
                Repeat unit
              </label>
              <select id={ids.everyUnit} value={everyUnit} onChange={(e) => setEveryUnit(Number(e.target.value))}>
                {UNITS.map(([name, n]) => (
                  <option key={name} value={n}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={ids.times}>Times in all (optional)</label>
                <input id={ids.times} type="number" min={1} value={times} onChange={(e) => setTimes(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor={ids.until}>Until (optional)</label>
                <input id={ids.until} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
              </div>
            </div>
          </>
        )}
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Pending scheduled replies in a thread, with cancel for their creator and the board owner. */
export function ThreadSchedules({ threadId, refreshKey }: { threadId: string; refreshKey: number }) {
  const { meId, isOwner } = useBoard();
  const { data, setData, error } = useLoad((signal) => api.threadSchedules(threadId, false, signal), [threadId, refreshKey]);
  const [cancelling, setCancelling] = useState<Schedule | null>(null);
  const toast = useToast();
  const schedules = data?.schedules ?? [];
  if (!error && schedules.length === 0) return null;
  return (
    <section className="card schedules" aria-labelledby="schedules-title">
      <h2 id="schedules-title" className="section-title">
        Scheduled <span className="count">{schedules.length}</span>
      </h2>
      <ErrorNote error={error} />
      <ul className="schedule-list">
        {schedules.map((s) => (
          <li key={s.id} className="schedule-item">
            <div className="schedule-when">
              <strong>{s.next_run_at ? formatDateTime(s.next_run_at) : s.state}</strong>
              <span className="muted small">{repeatText(s)}</span>
            </div>
            <div className="schedule-body">
              <Author p={s.created_by} showKind={false} />
              <span className="muted"> · {excerpt(s.body, 120)}</span>
            </div>
            {(s.created_by.id === meId || s.created_by.via?.id === meId || isOwner) && (
              <button type="button" className="button button-small button-danger-quiet" onClick={() => setCancelling(s)}>
                Cancel
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this scheduled post?"
        body={<p>It won't post again.</p>}
        confirmLabel="Cancel scheduled post"
        onConfirm={async () => {
          if (!cancelling) return;
          await api.cancelSchedule(cancelling.id);
          setData({ schedules: schedules.filter((x) => x.id !== cancelling.id) });
          toast("Scheduled post cancelled.", "success");
        }}
      />
    </section>
  );
}
