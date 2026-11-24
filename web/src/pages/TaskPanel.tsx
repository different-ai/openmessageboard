import type { Message, TaskClaim, Thread } from "@openmessageboard/protocol";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api, isApiError } from "../api";
import { useBoard } from "../board";
import { forgetClaim, loadClaim, saveClaim } from "../claims";
import { FINISHED_TASK_STATES, MAX_TASK_REASON, formatCountdown, formatDateTime, newIdempotencyKey, principalName } from "../format";
import { Markdown } from "../markdown";
import { Link } from "../router";
import { Author, ErrorNote, TaskBadge, TimeAgo, useToast } from "../ui";

type Form = "complete" | "fail" | "block" | "cancel" | "assign" | null;
type Result = { thread: Thread; message?: Message | null; claim?: TaskClaim };

/** Ticks every second while `on`, for the lease countdown. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function TaskPanel({ thread, onThread, onMessage }: { thread: Thread; onThread: (t: Thread) => void; onMessage: (m: Message) => void }) {
  const { board, meId, isOwner, canWrite, members } = useBoard();
  const task = thread.task!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<Form>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [claim, setClaim] = useState<TaskClaim | null>(() => loadClaim(thread.id, meId));
  const textId = useId();
  const kindId = useId();
  const assignId = useId();
  const toast = useToast();
  const now = useNow(task.state === "claimed");

  const holder = task.state === "claimed" ? task.assignee : null;
  const iHold = holder?.id === meId;
  const myClaim = iHold && claim && task.lease_until ? claim : null;
  const finished = FINISHED_TASK_STATES.includes(task.state);
  // The task's owner (its creator, or the person an agent creator acts for) or the board owner manages it.
  const manages = isOwner || thread.created_by.id === meId || thread.created_by.via?.id === meId;
  const canClaim = task.state === "ready" && (!task.for || task.for.id === meId);
  const leaseLeft = task.lease_until ? Date.parse(task.lease_until) - now : 0;

  useEffect(() => {
    // A claim that is over (released, blocked, canceled, expired or claimed by someone else) is forgotten.
    if (claim && !(task.state === "claimed" && task.assignee?.id === meId)) {
      forgetClaim(thread.id);
      setClaim(null);
    }
  }, [claim, task.state, task.assignee?.id, meId, thread.id]);

  function open(f: Form) {
    setForm(f);
    setText("");
    setKind("");
    setAssignTo(task.for?.id ?? "");
    setError(null);
  }

  async function run(label: string, fn: () => Promise<Result>, done: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fn();
      onThread(res.thread);
      if (res.message) onMessage(res.message);
      if (res.claim) {
        saveClaim(thread.id, meId, res.claim);
        setClaim(res.claim);
      }
      toast(done, "success");
      setForm(null);
    } catch (e) {
      if (isApiError(e, "claim_lost")) {
        forgetClaim(thread.id);
        setClaim(null);
      }
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const settle = (body: Parameters<typeof api.updateTask>[1]) => api.updateTask(thread.id, body);
  const withClaim = (action: "complete" | "fail" | "release" | "block", extra: Omit<Parameters<typeof api.updateTask>[1], "action" | "token"> = {}) =>
    settle({ action, token: myClaim!.token, ...extra });

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    switch (form) {
      case "complete":
        return void run("complete", () => withClaim("complete", t ? { result: t, idempotency_key: newIdempotencyKey() } : {}), "Task completed.");
      case "fail":
        return void run("fail", () => withClaim("fail", { reason: t }), "Task marked failed.");
      case "block":
        return void run(
          "block",
          () => (myClaim ? withClaim("block", { reason: t, ...(kind.trim() ? { kind: kind.trim() } : {}) }) : settle({ action: "block", reason: t, ...(kind.trim() ? { kind: kind.trim() } : {}) })),
          "Task blocked.",
        );
      case "cancel":
        return void run("cancel", () => settle({ action: "cancel", reason: t }), "Task canceled.");
      case "assign":
        return void run("assign", () => settle({ action: "assign", for: assignTo || null }), assignTo ? "Task assigned." : "Anyone can claim this task now.");
    }
  }

  const claimants = members.filter((m) => m.role !== "reader" && m.principal.kind !== "integration");
  const needsReason = form === "fail" || form === "block" || form === "cancel";

  return (
    <section className="card panel" aria-labelledby="task-title">
      <h2 id="task-title">Task</h2>
      <dl className="facts">
        <div>
          <dt>State</dt>
          <dd>
            <TaskBadge state={task.state} />
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>
            <Author p={task.owner} />
          </dd>
        </div>
        {task.for && (
          <div>
            <dt>Kept for</dt>
            <dd>
              <Author p={task.for} />
            </dd>
          </div>
        )}
        <div>
          <dt>{task.state === "claimed" ? "Claimed by" : task.state === "completed" ? "Done by" : task.state === "failed" ? "Tried by" : "Worker"}</dt>
          <dd>{task.assignee ? <Author p={task.assignee} /> : <span className="muted">Nobody yet</span>}</dd>
        </div>
        {task.state === "claimed" && task.lease_until && (
          <div>
            <dt>Lease</dt>
            <dd title={formatDateTime(task.lease_until)} className={leaseLeft <= 0 ? "lease-over" : leaseLeft < 60_000 ? "lease-low" : undefined}>
              {leaseLeft > 0 ? `${formatCountdown(task.lease_until, now)} left` : "Ran out; back in the queue shortly"}
            </dd>
          </div>
        )}
        {task.completed_at && (
          <div>
            <dt>{task.state === "canceled" ? "Canceled" : task.state === "failed" ? "Failed" : "Completed"}</dt>
            <dd>
              <TimeAgo iso={task.completed_at} />
            </dd>
          </div>
        )}
      </dl>

      {task.needs.length > 0 && (
        <div className="task-needs">
          <h3>Waits for</h3>
          <ul>
            {task.needs.map((n) => (
              <li key={n.thread_id}>
                <TaskBadge state={n.state} />
                <Link to={`/b/${board.id}/t/${n.thread_id}`}>{n.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {task.blocked_reason && (
        <p className="note task-reason">
          <strong>Held{task.blocked_kind ? ` (${task.blocked_kind.replace(/_/g, " ")})` : ""}:</strong> {task.blocked_reason}
        </p>
      )}
      {task.failure_reason && (
        <p className="note task-reason">
          <strong>Gave up:</strong> {task.failure_reason}
        </p>
      )}
      {task.canceled_reason && (
        <p className="note task-reason">
          <strong>Called off:</strong> {task.canceled_reason}
        </p>
      )}
      {task.result && (
        <div className="task-result">
          <h3>Result</h3>
          <Markdown source={task.result} />
        </div>
      )}

      {canWrite && (
        <div className="task-actions">
          {(canClaim || (iHold && !myClaim)) && (
            <button
              type="button"
              className="button button-primary"
              disabled={!!busy}
              onClick={() => run("claim", () => api.claimTask(board.id, { thread_id: thread.id }), "You claimed this task.")}
            >
              {busy === "claim" ? "Claiming…" : iHold ? "Resume claim" : "Claim"}
            </button>
          )}
          {task.state === "ready" && task.for && task.for.id !== meId && <span className="muted small">Kept for {principalName(task.for)}.</span>}
          {myClaim && (
            <>
              <button type="button" className="button button-primary" disabled={!!busy} onClick={() => open("complete")}>
                Complete…
              </button>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => run("renew", () => api.renewTask(thread.id, { token: myClaim.token }), "Lease renewed.")}
              >
                {busy === "renew" ? "Renewing…" : "Renew lease"}
              </button>
              <button type="button" className="button" disabled={!!busy} onClick={() => open("fail")}>
                Fail…
              </button>
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => run("release", () => withClaim("release"), "Task released. It's back in the queue.")}
              >
                {busy === "release" ? "Releasing…" : "Release"}
              </button>
            </>
          )}
          {(myClaim || (manages && !finished && task.state !== "blocked")) && (
            <button type="button" className="button" disabled={!!busy} onClick={() => open("block")}>
              Block…
            </button>
          )}
          {manages && task.state === "blocked" && (
            <button type="button" className="button button-primary" disabled={!!busy} onClick={() => run("unblock", () => settle({ action: "unblock" }), "Task unblocked.")}>
              {busy === "unblock" ? "Unblocking…" : "Unblock"}
            </button>
          )}
          {manages && task.state === "failed" && (
            <button type="button" className="button button-primary" disabled={!!busy} onClick={() => run("reopen", () => settle({ action: "reopen" }), "Task reopened.")}>
              {busy === "reopen" ? "Reopening…" : "Reopen"}
            </button>
          )}
          {manages && !finished && (
            <>
              <button type="button" className="button" disabled={!!busy} onClick={() => open("assign")}>
                Assign…
              </button>
              <button type="button" className="button" disabled={!!busy} onClick={() => open("cancel")}>
                Cancel task…
              </button>
            </>
          )}
        </div>
      )}

      {form && (
        <form className="stack complete-form" onSubmit={submit}>
          {form === "assign" ? (
            <div className="field">
              <label htmlFor={assignId}>Who can claim it</label>
              <select id={assignId} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="">Anyone on the board</option>
                {claimants.map((m) => (
                  <option key={m.principal.id} value={m.principal.id}>
                    {principalName(m.principal)}
                    {m.principal.id === meId ? " (you)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={textId}>
                {form === "complete" ? "Result (optional)" : form === "fail" ? "Why did it fail?" : form === "block" ? "What does it need?" : "Why cancel it?"}
              </label>
              <textarea
                id={textId}
                rows={form === "complete" ? 4 : 2}
                value={text}
                maxLength={needsReason ? MAX_TASK_REASON : undefined}
                required={needsReason}
                onChange={(e) => setText(e.target.value)}
                placeholder={form === "complete" ? "What was done? Posted as a reply. Markdown supported." : undefined}
              />
            </div>
          )}
          {form === "block" && (
            <div className="field">
              <label htmlFor={kindId}>Kind (optional)</label>
              <input id={kindId} value={kind} onChange={(e) => setKind(e.target.value)} placeholder="needs_input, awaiting_approval" pattern="[a-z0-9][a-z0-9_.\-]{0,31}" />
            </div>
          )}
          <div className="actions">
            <button type="button" className="button" onClick={() => setForm(null)}>
              Back
            </button>
            <button type="submit" className="button button-primary" disabled={!!busy || (needsReason && !text.trim())}>
              {busy
                ? "Saving…"
                : form === "complete"
                  ? "Mark completed"
                  : form === "fail"
                    ? "Mark failed"
                    : form === "block"
                      ? "Block"
                      : form === "cancel"
                        ? "Cancel task"
                        : "Assign"}
            </button>
          </div>
        </form>
      )}
      <ErrorNote error={error} />
    </section>
  );
}
