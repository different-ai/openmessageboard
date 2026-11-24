/** tasks profile: task threads, claiming, transitions, labels. */
import { check } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import { sleep } from "../util.ts";
import { boardCursor, mayaOnOwnerBoard, quotaReaderOnOwnerBoard, readAll, startThread } from "./helpers.ts";

async function newTask(ctx: Ctx, who: "owner" | "maya", title: string, labels: Record<string, string> = {}) {
  const board = await mayaOnOwnerBoard(ctx);
  const s = await ctx.session(who);
  const r = await startThread(s, board, title, `Task: ${title}`, { task: true, labels: { run: ctx.runId, ...labels } });
  return { board, thread: r.thread, message: r.message };
}

export const taskCases: CaseDef[] = [
  {
    id: "tasks.create",
    profile: "tasks",
    title: "start_thread with task: true creates an open task with labels",
    async run(ctx) {
      const { board, thread } = await newTask(ctx, "owner", `Create task ${ctx.runId}`, { area: "ios" });
      check(thread.kind === "task", `kind is ${thread.kind}, expected task`);
      check(thread.task && thread.task.state === "open" && thread.task.assignee === null && thread.task.claimed_at === null, "a new task is open with no assignee");
      check(thread.labels.area === "ios" && thread.labels.run === ctx.runId, "labels are stored as given");
      const owner = await ctx.session("owner");
      const listed = await owner.ok("list_threads", { board_id: board, kind: "task", task_state: "open", labels: { run: ctx.runId, area: "ios" } });
      check(listed.threads.some((t) => t.id === thread.id), "list_threads filters by kind, task_state and labels");
      const d = await startThread(owner, board, `Discussion ${ctx.runId}`, "not a task");
      check(d.thread.kind === "discussion" && d.thread.task === null, "discussions have task: null");
    },
  },
  {
    id: "tasks.concurrent-claim",
    profile: "tasks",
    title: "Two principals claiming the same task at once: exactly one wins",
    async run(ctx) {
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const ids = { owner: (await ctx.me("owner")).id, maya: (await ctx.me("maya")).id };
      for (let round = 1; round <= 3; round++) {
        const { thread } = await newTask(ctx, "owner", `Race ${round} ${ctx.runId}`);
        const [a, b] = await Promise.all([maya.call("claim_task", { thread_id: thread.id }), owner.call("claim_task", { thread_id: thread.id })]);
        const wins = [a, b].filter((r) => r.ok);
        check(wins.length === 1, `round ${round}: ${wins.length} claims succeeded, expected exactly 1`);
        const winner = a.ok ? ids.maya : ids.owner;
        const loser = a.ok ? b : a;
        check(!loser.ok && loser.error.code === "task_already_claimed", `round ${round}: the losing claim returned ${loser.ok ? "success" : loser.error.code}, expected task_already_claimed`);
        if (!loser.ok) {
          const assignee = (loser.error.details as { assignee?: { id?: string } } | undefined)?.assignee;
          check(assignee?.id === winner, `round ${round}: details.assignee should name the winner`);
        }
        const view = await owner.ok("get_thread", { thread_id: thread.id });
        check(view.thread.task?.state === "claimed" && view.thread.task.assignee?.id === winner && view.thread.task.claimed_at, `round ${round}: the task is claimed by the winner`);
        const again = await (winner === ids.maya ? maya : owner).ok("claim_task", { thread_id: thread.id });
        check(again.thread.task?.assignee?.id === winner, "claiming a task you already hold succeeds unchanged");
      }
    },
  },
  {
    id: "tasks.claim-next",
    profile: "tasks",
    title: "Claim-next takes the oldest open task matching every label, then no_task_available",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const run = `cn${ctx.runId}`;
      const t1 = await newTask(ctx, "owner", `Next 1 ${ctx.runId}`, { batch: run, queue: "a" });
      await sleep(30);
      const t2 = await newTask(ctx, "owner", `Next 2 ${ctx.runId}`, { batch: run, queue: "a" });
      await sleep(30);
      const t3 = await newTask(ctx, "owner", `Next 3 ${ctx.runId}`, { batch: run, queue: "b" });
      const board = t1.board;
      const c1 = await maya.ok("claim_task", { board_id: board, labels: { batch: run, queue: "a" } });
      check(c1.thread.id === t1.thread.id, "the first claim-next returns the oldest matching task");
      const c2 = await maya.ok("claim_task", { board_id: board, labels: { batch: run, queue: "a" } });
      check(c2.thread.id === t2.thread.id, "the second claim-next returns the next oldest");
      await maya.fails("claim_task", { board_id: board, labels: { batch: run, queue: "a" } }, "no_task_available");
      const c3 = await maya.ok("claim_task", { board_id: board, labels: { batch: run } });
      check(c3.thread.id === t3.thread.id, "a broader label filter claims the remaining open task");
      await maya.fails("claim_task", { board_id: board, labels: { batch: run } }, "no_task_available");
      await maya.fails("claim_task", { board_id: board, thread_id: t1.thread.id }, "invalid_argument");
      await maya.fails("claim_task", {}, "invalid_argument");
      await maya.fails("claim_task", { labels: { batch: run } }, "invalid_argument");
    },
  },
  {
    id: "tasks.complete-with-result",
    profile: "tasks",
    title: "Completing with a result posts a reply and sets state done",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const { thread, board } = await newTask(ctx, "owner", `Complete ${ctx.runId}`);
      const mayaId = (await ctx.me("maya")).id;
      await maya.ok("claim_task", { thread_id: thread.id });
      const c0 = await boardCursor(maya, board);
      const args = { thread_id: thread.id, action: "complete" as const, result: `Done in run ${ctx.runId}.`, idempotency_key: `done-${ctx.runId}-${thread.id}` };
      const r = await maya.ok("update_task", args);
      check(r.thread.task?.state === "done" && r.thread.task.completed_at, "the task is done with completed_at");
      check(r.message && r.message.author.id === mayaId && r.message.body === args.result && r.message.thread_id === thread.id, "the result is posted as a reply by the caller");
      const again = await maya.ok("update_task", args);
      check(again.message?.id === r.message.id, "retrying with the same idempotency key returns the same reply");
      const { changes } = await readAll(maya, board, c0);
      const mine = changes.filter((c) => c.thread_id === thread.id);
      check(mine.some((c) => c.type === "thread.updated") && mine.filter((c) => c.type === "message.created").length === 1, `expected thread.updated and one message.created, got ${mine.map((c) => c.type).join(", ")}`);
      const e = await maya.fails("claim_task", { thread_id: thread.id }, "task_not_claimable");
      check((e.details as { state?: string } | undefined)?.state === "done", "task_not_claimable carries details.state");
    },
  },
  {
    id: "tasks.release",
    profile: "tasks",
    title: "The assignee or the owner can release a claimed task; releasing an open task is a conflict",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const { thread } = await newTask(ctx, "owner", `Release ${ctx.runId}`);
      await maya.ok("claim_task", { thread_id: thread.id });
      const r = await maya.ok("update_task", { thread_id: thread.id, action: "release" });
      check(r.thread.task?.state === "open" && r.thread.task.assignee === null && r.thread.task.claimed_at === null, "release returns the task to open with no assignee");
      check(r.message === null, "no result means message: null");
      await owner.fails("update_task", { thread_id: thread.id, action: "release" }, "conflict");
      await maya.ok("claim_task", { thread_id: thread.id });
      const byOwner = await owner.ok("update_task", { thread_id: thread.id, action: "release" });
      check(byOwner.thread.task?.state === "open", "the board owner can release someone else's claim");
    },
  },
  {
    id: "tasks.cancel-reopen",
    profile: "tasks",
    title: "The creator or owner can cancel and reopen; others are forbidden",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const mine = await newTask(ctx, "maya", `Cancel own ${ctx.runId}`);
      const c = await maya.ok("update_task", { thread_id: mine.thread.id, action: "cancel" });
      check(c.thread.task?.state === "cancelled", "the creator can cancel");
      const e = await owner.fails("claim_task", { thread_id: mine.thread.id }, "task_not_claimable");
      check((e.details as { state?: string } | undefined)?.state === "cancelled", "task_not_claimable carries details.state");
      const ro = await maya.ok("update_task", { thread_id: mine.thread.id, action: "reopen" });
      check(ro.thread.task?.state === "open" && ro.thread.task.assignee === null, "the creator can reopen");
      const theirs = await newTask(ctx, "owner", `Cancel other ${ctx.runId}`);
      await maya.fails("update_task", { thread_id: theirs.thread.id, action: "cancel" }, "forbidden");
      await maya.fails("update_task", { thread_id: theirs.thread.id, action: "complete" }, "forbidden");
      await owner.ok("update_task", { thread_id: theirs.thread.id, action: "cancel" });
      await owner.fails("update_task", { thread_id: theirs.thread.id, action: "cancel" }, "conflict");
      const back = await owner.ok("update_task", { thread_id: theirs.thread.id, action: "reopen" });
      check(back.thread.task?.state === "open", "the owner can reopen");
    },
  },
  {
    id: "tasks.permissions",
    profile: "tasks",
    title: "Readers cannot claim or label; task tools reject discussion threads",
    async run(ctx) {
      await quotaReaderOnOwnerBoard(ctx);
      const reader = await ctx.session("quota");
      const owner = await ctx.session("owner");
      const { thread, board } = await newTask(ctx, "owner", `Permissions ${ctx.runId}`);
      await reader.fails("claim_task", { thread_id: thread.id }, "forbidden");
      await reader.fails("set_labels", { thread_id: thread.id, set: { x: "y" } }, "forbidden");
      const d = await startThread(owner, board, `Not a task ${ctx.runId}`, "discussion");
      await owner.fails("claim_task", { thread_id: d.thread.id }, "task_not_claimable");
      await owner.fails("update_task", { thread_id: d.thread.id, action: "complete" }, "task_not_claimable");
    },
  },
  {
    id: "tasks.self-claim-no-inbox-item",
    profile: "tasks",
    title: "Claiming follows the task and creates no task_assigned item for the claimer",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const { thread } = await newTask(ctx, "owner", `Self claim ${ctx.runId}`);
      const r = await maya.ok("claim_task", { thread_id: thread.id });
      check(r.thread.following === true, "claiming makes the claimer follow the thread");
      const inbox = await maya.ok("get_inbox", {});
      check(!inbox.items.some((i) => i.kind === "task_assigned" && i.thread_id === thread.id), "a claim is self-assignment and must not create a task_assigned item for the claimer (04)");
    },
  },
  {
    id: "tasks.task-assigned-inbox",
    profile: "tasks",
    title: "Assigning a task to someone else creates a task_assigned inbox item",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const before = await maya.ok("get_inbox", { limit: 1 });
      const r = await startThread(owner, board, `Assigned ${ctx.runId}`, "Please take this one", { task: true, assignee: mayaId, labels: { run: ctx.runId } });
      check(r.thread.task?.state === "claimed", `an assigned task starts claimed, got ${r.thread.task?.state}`);
      check(r.thread.task?.assignee?.id === mayaId, "the assignee is the named member");
      const inbox = await maya.ok("get_changes", { inbox: true, cursor: before.as_of });
      const items = "items" in inbox ? inbox.items : [];
      check(items.some((i) => i.kind === "task_assigned" && i.thread_id === r.thread.id), "the assignee gets a task_assigned inbox item");
      await owner.fails("start_thread", { board_id: board, title: "Not a task", body: "x", assignee: mayaId, idempotency_key: `na-${ctx.runId}` }, "invalid_argument");
    },
  },
  {
    id: "tasks.labels",
    profile: "tasks",
    title: "set_labels sets, removes, validates and filters labels",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const owner = await ctx.session("owner");
      const run = `lb${ctx.runId}`;
      const t = await startThread(owner, board, `Labels ${ctx.runId}`, "labelled", { labels: { batch: run, area: "ios" } });
      const id = t.thread.id;
      const s1 = await owner.ok("set_labels", { thread_id: id, set: { state: "review" } });
      check(JSON.stringify(sorted(s1.thread.labels)) === JSON.stringify(sorted({ batch: run, area: "ios", state: "review" })), `labels after set: ${JSON.stringify(s1.thread.labels)}`);
      const s2 = await owner.ok("set_labels", { thread_id: id, remove: ["area", "missing"] });
      check(JSON.stringify(sorted(s2.thread.labels)) === JSON.stringify(sorted({ batch: run, state: "review" })), `labels after remove: ${JSON.stringify(s2.thread.labels)}`);
      const c0 = await boardCursor(owner, board);
      await owner.ok("set_labels", { thread_id: id, set: { state: "review" } });
      const noop = await readAll(owner, board, c0);
      check(!noop.changes.some((c) => c.thread_id === id), "a set_labels call that changes nothing emits no change");
      await owner.ok("set_labels", { thread_id: id, set: { state: "approved" } });
      const changed = await readAll(owner, board, noop.cursor);
      check(changed.changes.some((c) => c.thread_id === id && c.type === "thread.updated"), "a label change emits thread.updated");
      await owner.fails("set_labels", { thread_id: id, set: { state: "x" }, remove: ["state"] }, "invalid_argument");
      await owner.fails("set_labels", { thread_id: id, set: { Area: "ios" } }, "invalid_argument");
      await owner.fails("set_labels", { thread_id: id, set: { note: "v".repeat(65) } }, "invalid_argument");
      await owner.fails("set_labels", { thread_id: id, set: { note: "" } }, "invalid_argument");
      const many: Record<string, string> = {};
      for (let i = 0; i < 16; i++) many[`k${i}`] = "v";
      await owner.fails("set_labels", { thread_id: id, set: many }, "invalid_argument");
      const hit = await owner.ok("list_threads", { board_id: board, labels: { batch: run, state: "approved" } });
      check(hit.threads.some((x) => x.id === id), "list_threads with matching labels includes the thread");
      const miss = await owner.ok("list_threads", { board_id: board, labels: { batch: run, state: "done" } });
      check(!miss.threads.some((x) => x.id === id), "list_threads with a non-matching label excludes the thread");
    },
  },
];

function sorted(o: Record<string, string>): [string, string][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}
