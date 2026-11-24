import type { Change, Labels, TaskState, Thread } from "@openmessageboard/protocol";
import { useCallback, useEffect, useState } from "react";
import { api, isApiError } from "../api";
import { useBoard, useBoardChanges } from "../board";
import { parseLabels, TASK_STATE_LABEL, TASK_STATE_LIST } from "../format";
import { Link, navigate, useLocation, useTitle } from "../router";
import { Author, ErrorNote, LabelChips, Loading, TimeAgo, useToast } from "../ui";
import { LabelFilter } from "./BoardThreads";

type Columns = Record<TaskState, Thread[]>;
const emptyColumns = (): Columns => ({ open: [], claimed: [], done: [], cancelled: [] });

function matches(t: Thread, labels: Labels) {
  return t.kind === "task" && !!t.task && Object.entries(labels).every(([k, v]) => t.labels[k] === v);
}

export function TaskBoard() {
  const { board, live, canWrite } = useBoard();
  const { search } = useLocation();
  const labels = parseLabels(new URLSearchParams(search).getAll("label").join(",")).labels;
  const labelKey = JSON.stringify(labels);
  const [columns, setColumns] = useState<Columns | null>(null);
  const [more, setMore] = useState<Partial<Record<TaskState, boolean>>>({});
  const [error, setError] = useState<unknown>(null);
  const [claiming, setClaiming] = useState(false);
  const toast = useToast();
  useTitle(`Tasks · ${board.name}`);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const results = await Promise.all(
          TASK_STATE_LIST.map((state) =>
            api.threads(
              board.id,
              { kind: "task", task_state: state, labels: Object.keys(labels).length ? labels : undefined, limit: 100 },
              signal,
            ),
          ),
        );
        const cols = emptyColumns();
        const hasMore: Partial<Record<TaskState, boolean>> = {};
        TASK_STATE_LIST.forEach((s, i) => {
          cols[s] = results[i]!.threads;
          hasMore[s] = !!results[i]!.next_page_cursor;
        });
        setColumns(cols);
        setMore(hasMore);
        live.ensure(results[0]!.as_of);
      } catch (e) {
        if (!signal?.aborted) setError(e);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.id, labelKey, live],
  );

  useEffect(() => {
    const ctl = new AbortController();
    setColumns(null);
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const onChange = useCallback(
    (c: Change) => {
      const t = c.thread;
      if (!t) return;
      setColumns((cols) => {
        if (!cols) return cols;
        const next = emptyColumns();
        for (const s of TASK_STATE_LIST) next[s] = cols[s].filter((x) => x.id !== t.id);
        if (matches(t, labels)) {
          const s = t.task!.state;
          next[s] = [t, ...next[s]].sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
        }
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelKey],
  );
  const onResync = useCallback(() => void load(), [load]);
  useBoardChanges(onChange, onResync);

  async function claimNext() {
    setClaiming(true);
    try {
      const res = await api.claimTask(board.id, { labels: Object.keys(labels).length ? labels : undefined });
      toast(`You claimed “${res.thread.title}”.`, "success");
      navigate(`/b/${board.id}/t/${res.thread.id}`);
    } catch (e) {
      if (isApiError(e, "no_task_available")) toast("No open tasks match right now.", "info");
      else setError(e);
    } finally {
      setClaiming(false);
    }
  }

  const setLabels = (l: Labels) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(l)) p.append("label", `${k}=${v}`);
    const s = p.toString();
    navigate(`/b/${board.id}/tasks${s ? `?${s}` : ""}`, { replace: true });
  };

  return (
    <div className="tasks-page">
      <div className="toolbar">
        <h1 className="page-title">Tasks</h1>
        {canWrite && (
          <button type="button" className="button button-primary toolbar-end" onClick={claimNext} disabled={claiming}>
            {claiming ? "Claiming…" : Object.keys(labels).length ? "Claim next matching" : "Claim next"}
          </button>
        )}
      </div>
      <LabelFilter labels={labels} onChange={setLabels} />
      <ErrorNote error={error} />
      {columns === null && !error ? (
        <Loading label="Loading tasks…" />
      ) : columns ? (
        <div className="kanban">
          {TASK_STATE_LIST.map((s) => (
            <section key={s} className={`kanban-col col-${s}`} aria-labelledby={`col-${s}`}>
              <h2 id={`col-${s}`}>
                {TASK_STATE_LABEL[s]} <span className="count">{columns[s].length}{more[s] ? "+" : ""}</span>
              </h2>
              {columns[s].length === 0 ? (
                <p className="muted small kanban-empty">No {TASK_STATE_LABEL[s].toLowerCase()} tasks.</p>
              ) : (
                <ul className="kanban-cards">
                  {columns[s].map((t) => (
                    <li key={t.id} className="kanban-card">
                      <Link to={`/b/${board.id}/t/${t.id}`} className="thread-link">
                        {t.title}
                      </Link>
                      <div className="kanban-meta">
                        {t.task?.assignee ? <Author p={t.task.assignee} /> : <span className="muted">Unassigned</span>}
                        <TimeAgo iso={t.last_activity_at} />
                      </div>
                      <LabelChips labels={t.labels} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
