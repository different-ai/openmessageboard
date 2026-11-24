/** tasks profile: states, claim leases, dependencies, tasks kept for one principal, plans, claim-next and labels. */
import type { TaskClaim, Thread, ToolOutput } from "@openmessageboard/protocol";
import { check } from "../errors.ts";
import type { CaseDef, Ctx } from "../harness.ts";
import type { McpSession } from "../mcp.ts";
import { newKey, sleep, until } from "../util.ts";
import { boardCursor, mayaOnOwnerBoard, quotaReaderOnOwnerBoard, readAll, startThread } from "./helpers.ts";

async function newTask(ctx: Ctx, who: "owner" | "maya", title: string, extra: { labels?: Record<string, string>; needs?: string[]; for?: string } = {}) {
  const board = await mayaOnOwnerBoard(ctx);
  const s = await ctx.session(who);
  const r = await startThread(s, board, title, `Task: ${title}`, { task: true, ...extra, labels: { run: ctx.runId, ...(extra.labels ?? {}) } });
  return { board, thread: r.thread, message: r.message };
}

function checkClaim(c: TaskClaim, where: string): void {
  check(Number.isInteger(c.epoch) && c.epoch >= 1, `${where}: claim.epoch is a positive integer`);
  check(typeof c.token === "string" && c.token.length > 0, `${where}: claim.token is a non-empty string`);
  check(Number.isFinite(Date.parse(c.until)), `${where}: claim.until is a time`);
}

async function claim(s: McpSession, threadId: string, lease?: number): Promise<ToolOutput<"claim_task">> {
  const r = await s.ok("claim_task", { thread_id: threadId, ...(lease ? { lease_seconds: lease } : {}) });
  checkClaim(r.claim, "claim_task");
  return r;
}

const stateOf = async (s: McpSession, threadId: string) => (await s.ok("get_thread", { thread_id: threadId, limit: 1 })).thread.task?.state;

export const taskCases: CaseDef[] = [
  {
    id: "tasks.create",
    profile: "tasks",
    title: "start_thread with task: true creates a ready task owned by its creator",
    async run(ctx) {
      const { board, thread } = await newTask(ctx, "maya", `Create task ${ctx.runId}`, { labels: { area: "ios" } });
      const mayaId = (await ctx.me("maya")).id;
      check(thread.kind === "task", `kind is ${thread.kind}, expected task`);
      const t = thread.task;
      check(t && t.state === "ready" && t.assignee === null && t.claimed_at === null && t.lease_until === null, "a new task is ready with no assignee or lease (04)");
      check(t?.owner.id === mayaId, "task.owner is the creator (04 §Ownership)");
      check(t?.for === null && Array.isArray(t?.needs) && t.needs.length === 0, "a task with no for or needs has for: null and needs: []");
      check(t?.result === null && t.failure_reason === null && t.blocked_reason === null && t.blocked_kind === null && t.canceled_reason === null, "a new task carries no result or reasons");
      check(thread.labels.area === "ios" && thread.labels.run === ctx.runId, "labels are stored as given");
      const owner = await ctx.session("owner");
      const filters: { task_state?: "ready" | "open"; labels: Record<string, string> }[] = [
        { task_state: "ready", labels: { run: ctx.runId, area: "ios" } },
        { task_state: "open", labels: { run: ctx.runId, area: "ios" } },
        { labels: { run: ctx.runId, area: "ios", "board.task": "ready" } },
      ];
      for (const f of filters) {
        const listed = await owner.ok("list_threads", { board_id: board, kind: "task", ...f });
        check(listed.threads.some((x) => x.id === thread.id), `list_threads finds the task with ${JSON.stringify(f)} (04 §Filters)`);
      }
      const miss = await owner.ok("list_threads", { board_id: board, labels: { run: ctx.runId, area: "ios", "board.task": "claimed" } });
      check(!miss.threads.some((x) => x.id === thread.id), "board.task=claimed does not match a ready task");
      const d = await startThread(owner, board, `Discussion ${ctx.runId}`, "not a task");
      check(d.thread.kind === "discussion" && d.thread.task === null, "discussions have task: null");
      await owner.fails("start_thread", { board_id: board, title: "Not a task", body: "x", for: mayaId, idempotency_key: newKey() }, "invalid_argument");
    },
  },
  {
    id: "tasks.concurrent-claim",
    profile: "tasks",
    title: "Two principals claiming the same task at once: exactly one wins and gets a lease",
    async run(ctx) {
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const ids = { owner: (await ctx.me("owner")).id, maya: (await ctx.me("maya")).id };
      for (let round = 1; round <= 3; round++) {
        const { thread, board } = await newTask(ctx, "owner", `Race ${round} ${ctx.runId}`);
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
        const won = (a.ok ? a.data : b.ok ? b.data : null)!;
        checkClaim(won.claim, `round ${round}`);
        check(won.thread.task?.lease_until === won.claim.until, `round ${round}: task.lease_until equals claim.until`);
        const view = await owner.ok("get_thread", { thread_id: thread.id });
        check(view.thread.task?.state === "claimed" && view.thread.task.assignee?.id === winner && view.thread.task.claimed_at, `round ${round}: the task is claimed by the winner`);
        const c0 = await boardCursor(owner, board);
        const again = await (winner === ids.maya ? maya : owner).ok("claim_task", { thread_id: thread.id });
        check(again.claim.token === won.claim.token && again.claim.epoch === won.claim.epoch, "claiming a task you hold returns the same claim (04 §Claiming)");
        const after = await readAll(owner, board, c0);
        check(!after.changes.some((c) => c.thread_id === thread.id), "re-claiming a task you hold records no change");
      }
    },
  },
  {
    id: "tasks.claim-next",
    profile: "tasks",
    title: "Claim-next takes tasks kept for the caller first, then the oldest ready task matching every label",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const run = `cn${ctx.runId}`;
      const t1 = await newTask(ctx, "owner", `Next 1 ${ctx.runId}`, { labels: { batch: run, queue: "a" } });
      await sleep(30);
      const t2 = await newTask(ctx, "owner", `Next 2 ${ctx.runId}`, { labels: { batch: run, queue: "a" } });
      await sleep(30);
      const kept = await newTask(ctx, "owner", `Kept for maya ${ctx.runId}`, { labels: { batch: run, queue: "a" }, for: mayaId });
      await sleep(30);
      const t3 = await newTask(ctx, "owner", `Next 3 ${ctx.runId}`, { labels: { batch: run, queue: "b" } });
      const board = t1.board;
      const c0 = await maya.ok("claim_task", { board_id: board, labels: { batch: run, queue: "a" } });
      check(c0.thread.id === kept.thread.id, "a task kept for the caller comes before older unassigned tasks (04 §Claiming)");
      checkClaim(c0.claim, "claim-next");
      const c1 = await maya.ok("claim_task", { board_id: board, labels: { batch: run, queue: "a" } });
      check(c1.thread.id === t1.thread.id, "then the oldest matching task");
      const c2 = await maya.ok("claim_task", { board_id: board, labels: { batch: run, queue: "a" } });
      check(c2.thread.id === t2.thread.id, "then the next oldest");
      await maya.fails("claim_task", { board_id: board, labels: { batch: run, queue: "a" } }, "no_task_available");
      const c3 = await maya.ok("claim_task", { board_id: board, labels: { batch: run } });
      check(c3.thread.id === t3.thread.id, "a broader label filter claims the remaining ready task");
      await maya.fails("claim_task", { board_id: board, labels: { batch: run } }, "no_task_available");
      const owner = await ctx.session("owner");
      const inChannel = await owner.ok("start_thread", {
        board_id: board,
        channel: `conf-${ctx.runId}/queue`,
        title: `Channel task ${ctx.runId}`,
        body: "in a channel",
        task: true,
        labels: { batch: run },
        idempotency_key: newKey(),
      });
      await maya.fails("claim_task", { board_id: board, channel: `conf-${ctx.runId}/other`, labels: { batch: run } }, "no_task_available");
      const c4 = await maya.ok("claim_task", { board_id: board, channel: `conf-${ctx.runId}/`, labels: { batch: run } });
      check(c4.thread.id === inChannel.thread.id, "claim-next with a channel subtree claims the task in that subtree (04 §Claiming)");
      await maya.fails("claim_task", { board_id: board, thread_id: t1.thread.id }, "invalid_argument");
      await maya.fails("claim_task", {}, "invalid_argument");
      await maya.fails("claim_task", { labels: { batch: run } }, "invalid_argument");
      await maya.fails("claim_task", { thread_id: t1.thread.id, wait_seconds: 1 }, "invalid_argument");
    },
  },
  {
    id: "tasks.complete-with-result",
    profile: "tasks",
    title: "Completing with the claim's token posts the result as a reply; a missing or stale token changes nothing",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const { thread, board } = await newTask(ctx, "owner", `Complete ${ctx.runId}`);
      const mayaId = (await ctx.me("maya")).id;
      const { claim: c } = await claim(maya, thread.id);
      await maya.fails("update_task", { thread_id: thread.id, action: "complete" }, "invalid_argument");
      await maya.fails("update_task", { thread_id: thread.id, action: "complete", token: `${c.token}x` }, "claim_lost");
      const owner = await ctx.session("owner");
      await owner.fails("update_task", { thread_id: thread.id, action: "complete", token: c.token }, "claim_lost");
      const c0 = await boardCursor(maya, board);
      const args = { thread_id: thread.id, action: "complete" as const, token: c.token, result: `Done in run ${ctx.runId}.`, idempotency_key: newKey() };
      const r = await maya.ok("update_task", args);
      check(r.thread.task?.state === "completed" && r.thread.task.completed_at, "the task is completed with completed_at");
      check(r.thread.task?.result === args.result, "task.result is the posted result (04 §Results)");
      check(r.thread.task?.assignee?.id === mayaId && r.thread.task.lease_until === null, "a completed task keeps who did it and has no lease");
      check(r.message && r.message.author.id === mayaId && r.message.body === args.result && r.message.thread_id === thread.id, "the result is posted as a reply by the caller");
      const again = await maya.ok("update_task", args);
      check(again.message?.id === r.message.id, "retrying with the same idempotency key returns the same reply");
      await maya.fails("update_task", { thread_id: thread.id, action: "complete", token: c.token }, "claim_lost");
      const { changes } = await readAll(maya, board, c0);
      const mine = changes.filter((c) => c.thread_id === thread.id);
      check(mine.some((c) => c.type === "thread.updated") && mine.filter((c) => c.type === "message.created").length === 1, `expected thread.updated and one message.created, got ${mine.map((c) => c.type).join(", ")}`);
      const e = await maya.fails("claim_task", { thread_id: thread.id }, "task_finished");
      check((e.details as { state?: string } | undefined)?.state === "completed", "task_finished carries details.state");
    },
  },
  {
    id: "tasks.lease",
    profile: "tasks",
    title: "A lease is capped by task_lease_seconds, renew extends it, and an expired lease returns the task to ready",
    timeoutMs: 120_000,
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const { thread, board } = await newTask(ctx, "owner", `Lease ${ctx.runId}`);
      const max = (await ctx.limitsOf("maya")).task_lease_seconds;
      await maya.reserveWrites(4);
      const { claim: c } = await claim(maya, thread.id, 1_000_000);
      if (typeof max === "number") {
        check(Date.parse(c.until) - ctx.serverNow() <= max * 1000 + 5000, `a requested lease is capped at task_lease_seconds (${max})`);
      } else ctx.note("the server does not advertise task_lease_seconds in its limits");
      const r1 = await maya.ok("renew_task", { thread_id: thread.id, token: c.token, lease_seconds: 3 });
      check(r1.claim.token === c.token && r1.claim.epoch === c.epoch, "renewing keeps the claim's epoch and token");
      const leaseMs = Date.parse(r1.claim.until) - ctx.serverNow();
      check(leaseMs <= 4500 && leaseMs > 0, `renew_task with lease_seconds: 3 sets the lease from now (got ${leaseMs} ms)`);
      check(r1.thread.task?.lease_until === r1.claim.until, "task.lease_until follows the renewal");
      await owner.fails("renew_task", { thread_id: thread.id, token: c.token }, "claim_lost");
      await sleep(Math.max(0, Date.parse(r1.claim.until) - ctx.serverNow()) + 1500);
      await owner.reserveWrites(2);
      await maya.fails("renew_task", { thread_id: thread.id, token: c.token }, "claim_lost");
      await maya.fails("update_task", { thread_id: thread.id, action: "complete", token: c.token }, "claim_lost");
      const c0 = await boardCursor(owner, board);
      const taken = await claim(owner, thread.id);
      check(taken.claim.epoch > c.epoch && taken.claim.token !== c.token, "a claim after expiry has a new epoch and token");
      const { changes } = await readAll(owner, board, c0);
      const mine = changes.filter((x) => x.thread_id === thread.id && x.type === "thread.updated");
      // The sweep may already have recorded the expiry before the cursor was taken; either way no stale claim survives.
      if (mine.length >= 2) check(mine[0]!.actor === null, "the expiry change has a null actor (04 §Leases)");
      await maya.fails("update_task", { thread_id: thread.id, action: "release", token: c.token }, "claim_lost");
      // Without a claim attempt, the server's sweep returns an expired task to ready.
      await owner.reserveWrites(1);
      const short = await owner.ok("renew_task", { thread_id: thread.id, token: taken.claim.token, lease_seconds: 1 });
      const ready = await until(async () => ((await stateOf(owner, thread.id)) === "ready" ? true : null), 25_000, 500);
      if (!ready) ctx.note("the expired lease was not returned to ready within 25 s without a claim (04 §Leases: SHOULD within a minute)");
      check(Date.parse(short.claim.until) - ctx.serverNow() < 2500, "renew_task honours a shorter lease");
    },
  },
  {
    id: "tasks.release",
    profile: "tasks",
    title: "The claimer releases with its token; the owner can hold a claimed task, ending the claim",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const { thread } = await newTask(ctx, "owner", `Release ${ctx.runId}`);
      const { claim: c1 } = await claim(maya, thread.id);
      const r = await maya.ok("update_task", { thread_id: thread.id, action: "release", token: c1.token });
      check(r.thread.task?.state === "ready" && r.thread.task.assignee === null && r.thread.task.claimed_at === null, "release returns the task to ready with no assignee");
      check(r.message === null, "no result means message: null");
      await maya.fails("update_task", { thread_id: thread.id, action: "release", token: c1.token }, "claim_lost");
      await owner.fails("update_task", { thread_id: thread.id, action: "release" }, "invalid_argument");
      const { claim: c2 } = await claim(maya, thread.id);
      const held = await owner.ok("update_task", { thread_id: thread.id, action: "block", reason: "wait for the release window" });
      check(held.thread.task?.state === "blocked" && held.thread.task.assignee === null, "the owner can hold a claimed task");
      await maya.fails("update_task", { thread_id: thread.id, action: "complete", token: c2.token }, "claim_lost");
      await owner.ok("update_task", { thread_id: thread.id, action: "unblock" });
    },
  },
  {
    id: "tasks.needs",
    profile: "tasks",
    title: "A task waits for its needs; completing the last one readies it, a failed or canceled one readies nothing",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const a = await newTask(ctx, "maya", `Needs A ${ctx.runId}`);
      const b = await newTask(ctx, "maya", `Needs B ${ctx.runId}`, { needs: [a.thread.id] });
      const board = a.board;
      check(b.thread.task?.state === "waiting", `a task with an unmet need is waiting, got ${b.thread.task?.state}`);
      check(b.thread.task?.needs.length === 1 && b.thread.task.needs[0]!.thread_id === a.thread.id && b.thread.task.needs[0]!.state === "ready", "task.needs lists the prerequisite and its state");
      await owner.fails("claim_task", { thread_id: b.thread.id }, "task_waiting");
      await maya.fails("update_task", { thread_id: a.thread.id, action: "set_needs", needs: [b.thread.id] }, "invalid_needs");
      await maya.fails("update_task", { thread_id: a.thread.id, action: "set_needs", needs: [a.thread.id] }, "invalid_needs");
      const chat = await startThread(maya, board, `Not a task ${ctx.runId}`, "chat");
      await maya.fails("start_thread", { board_id: board, title: "Bad needs", body: "x", task: true, needs: [chat.thread.id], idempotency_key: newKey() }, "invalid_needs");
      await maya.fails("start_thread", { board_id: board, title: "Bad needs", body: "x", task: true, needs: ["t_does_not_exist"], idempotency_key: newKey() }, "invalid_needs");

      const { claim: ca } = await claim(owner, a.thread.id);
      const c0 = await boardCursor(owner, board);
      await owner.ok("update_task", { thread_id: a.thread.id, action: "complete", token: ca.token });
      check((await stateOf(owner, b.thread.id)) === "ready", "completing the only prerequisite readies the task (04 §Dependencies)");
      const { changes } = await readAll(owner, board, c0);
      check(changes.some((c) => c.thread_id === b.thread.id && c.type === "thread.updated"), "readying a dependent records a thread.updated change");

      const c = await newTask(ctx, "maya", `Needs C ${ctx.runId}`);
      const d = await newTask(ctx, "maya", `Needs D ${ctx.runId}`, { needs: [c.thread.id, a.thread.id] });
      check(d.thread.task?.state === "waiting", "a task waits while any need is unmet");
      const { claim: cc } = await claim(owner, c.thread.id);
      const failed = await owner.ok("update_task", { thread_id: c.thread.id, action: "fail", token: cc.token, reason: "the build machine is gone" });
      check(failed.thread.task?.state === "failed" && failed.thread.task.failure_reason === "the build machine is gone", "fail records the reason");
      check((await stateOf(owner, d.thread.id)) === "waiting", "a failed prerequisite readies nothing");
      const replaced = await maya.ok("update_task", { thread_id: d.thread.id, action: "set_needs", needs: [a.thread.id] });
      check(replaced.thread.task?.state === "ready", "replacing needs with completed tasks makes the task ready");
      const cleared = await maya.ok("update_task", { thread_id: d.thread.id, action: "set_needs", needs: [] });
      check(cleared.thread.task?.needs.length === 0 && cleared.thread.task.state === "ready", "set_needs with [] removes every need");
      const other = await newTask(ctx, "owner", `Not maya's ${ctx.runId}`);
      await maya.fails("update_task", { thread_id: other.thread.id, action: "set_needs", needs: [] }, "task_not_owned");
    },
  },
  {
    id: "tasks.for-assign",
    profile: "tasks",
    title: "A task kept for one principal can only be claimed by them; the owner assigns and returns it to the pool",
    async run(ctx) {
      const owner = await ctx.session("owner");
      const maya = await ctx.session("maya");
      const mayaId = (await ctx.me("maya")).id;
      const before = await maya.ok("get_inbox", { limit: 1 });
      const t = await newTask(ctx, "owner", `For maya ${ctx.runId}`, { for: mayaId });
      check(t.thread.task?.state === "ready" && t.thread.task.for?.id === mayaId && t.thread.task.assignee === null, "a task kept for someone is ready, with task.for set");
      const inbox = await maya.ok("get_changes", { inbox: true, cursor: before.as_of });
      const items = "items" in inbox ? inbox.items : [];
      check(items.some((i) => i.kind === "task_assigned" && i.thread_id === t.thread.id), "the principal it is kept for gets a task_assigned inbox item");
      const e = await owner.fails("claim_task", { thread_id: t.thread.id }, "task_assigned");
      check((e.details as { for?: { id?: string } } | undefined)?.for?.id === mayaId, "task_assigned carries details.for");
      const listed = await maya.ok("list_threads", { board_id: t.board, for: "me", labels: { run: ctx.runId } });
      check(listed.threads.some((x) => x.id === t.thread.id), "list_threads filters by for: 'me'");
      await maya.fails("update_task", { thread_id: t.thread.id, action: "assign", for: null }, "task_not_owned");
      const pooled = await owner.ok("update_task", { thread_id: t.thread.id, action: "assign", for: null });
      check(pooled.thread.task?.for === null, "assign with for: null returns the task to anyone");
      const back = await owner.ok("update_task", { thread_id: t.thread.id, action: "assign", for: mayaId });
      check(back.thread.task?.for?.id === mayaId, "assign keeps the task for a member");
      await owner.fails("update_task", { thread_id: t.thread.id, action: "assign" }, "invalid_argument");
      const { claim: c } = await claim(maya, t.thread.id);
      await maya.ok("update_task", { thread_id: t.thread.id, action: "release", token: c.token });
      check((await stateOf(owner, t.thread.id)) === "ready", "after a release the task stays kept for the same principal");
      await owner.fails("claim_task", { thread_id: t.thread.id }, "task_assigned");
    },
  },
  {
    id: "tasks.block-unblock",
    profile: "tasks",
    title: "The worker blocks with its token; only the task's owner (or board owner) unblocks",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const t = await newTask(ctx, "owner", `Block ${ctx.runId}`);
      const { claim: c } = await claim(maya, t.thread.id);
      await maya.fails("update_task", { thread_id: t.thread.id, action: "block", token: c.token }, "invalid_argument");
      const b = await maya.ok("update_task", { thread_id: t.thread.id, action: "block", token: c.token, reason: "approve the prod deploy?", kind: "awaiting_approval" });
      check(b.thread.task?.state === "blocked" && b.thread.task.blocked_reason === "approve the prod deploy?" && b.thread.task.blocked_kind === "awaiting_approval", "block records the reason and kind");
      check(b.thread.task?.assignee === null && b.thread.task.lease_until === null, "blocking ends the claim");
      await maya.fails("renew_task", { thread_id: t.thread.id, token: c.token }, "claim_lost");
      const e = await maya.fails("claim_task", { thread_id: t.thread.id }, "task_blocked");
      check((e.details as { state?: string } | undefined)?.state === "blocked", "task_blocked carries details.state");
      await maya.fails("update_task", { thread_id: t.thread.id, action: "unblock" }, "task_not_owned");
      const u = await owner.ok("update_task", { thread_id: t.thread.id, action: "unblock" });
      check(u.thread.task?.state === "ready" && u.thread.task.blocked_reason === null, "unblock returns the task to ready and clears the hold");
      await owner.fails("update_task", { thread_id: t.thread.id, action: "unblock" }, "conflict");
      const mine = await newTask(ctx, "maya", `Block own ${ctx.runId}`);
      const held = await maya.ok("update_task", { thread_id: mine.thread.id, action: "block", reason: "check with me first" });
      check(held.thread.task?.state === "blocked", "a task's creator can hold an unclaimed task without a token");
      await maya.ok("update_task", { thread_id: mine.thread.id, action: "unblock" });
    },
  },
  {
    id: "tasks.fail-reopen-cancel",
    profile: "tasks",
    title: "A failed task can be reopened by its owner; cancel needs a reason and ends any claim",
    async run(ctx) {
      const maya = await ctx.session("maya");
      const owner = await ctx.session("owner");
      const t = await newTask(ctx, "maya", `Fail ${ctx.runId}`);
      const { claim: c } = await claim(owner, t.thread.id);
      await owner.fails("update_task", { thread_id: t.thread.id, action: "fail", token: c.token }, "invalid_argument");
      const f = await owner.ok("update_task", { thread_id: t.thread.id, action: "fail", token: c.token, reason: "no credentials for the registry" });
      check(f.thread.task?.state === "failed" && f.thread.task.failure_reason === "no credentials for the registry" && f.thread.task.completed_at, "fail records the reason and when");
      await owner.fails("claim_task", { thread_id: t.thread.id }, "task_finished");
      const ro = await maya.ok("update_task", { thread_id: t.thread.id, action: "reopen" });
      check(ro.thread.task?.state === "ready" && ro.thread.task.failure_reason === null && ro.thread.task.assignee === null, "the creator can reopen a failed task");
      await maya.fails("update_task", { thread_id: t.thread.id, action: "reopen" }, "conflict");

      const theirs = await newTask(ctx, "owner", `Cancel ${ctx.runId}`);
      const { claim: c2 } = await claim(maya, theirs.thread.id);
      await maya.fails("update_task", { thread_id: theirs.thread.id, action: "cancel", reason: "mine now" }, "task_not_owned");
      await owner.fails("update_task", { thread_id: theirs.thread.id, action: "cancel" }, "invalid_argument");
      const x = await owner.ok("update_task", { thread_id: theirs.thread.id, action: "cancel", reason: "superseded by the nightly run" });
      check(x.thread.task?.state === "canceled" && x.thread.task.canceled_reason === "superseded by the nightly run", "cancel records the reason");
      await maya.fails("update_task", { thread_id: theirs.thread.id, action: "complete", token: c2.token }, "claim_lost");
      await owner.fails("update_task", { thread_id: theirs.thread.id, action: "cancel", reason: "again" }, "task_finished");
      await owner.fails("update_task", { thread_id: theirs.thread.id, action: "reopen" }, "conflict");
    },
  },
  {
    id: "tasks.plan",
    profile: "tasks",
    title: "create_tasks creates a plan in one write (all or none), with needs by key, and is idempotent",
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const tag = `pl${ctx.runId}`;
      const count = async () => (await maya.ok("list_threads", { board_id: board, kind: "task", labels: { plan: tag } })).threads.length;
      const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: `${title} body`, labels: { plan: tag }, ...extra });
      await maya.fails("create_tasks", { board_id: board, tasks: [task("A", { key: "a" }), task("B", { needs: [{ key: "missing" }] })] }, "invalid_needs");
      await maya.fails("create_tasks", { board_id: board, tasks: [task("A", { key: "a" }), task("B", { key: "a" })] }, "invalid_needs");
      await maya.fails(
        "create_tasks",
        { board_id: board, tasks: [task("A", { key: "a", needs: [{ key: "b" }] }), task("B", { key: "b", needs: [{ key: "a" }] })] },
        "invalid_needs",
      );
      check((await count()) === 0, "a plan that fails creates nothing");
      const args = {
        board_id: board,
        tasks: [task("Fix", { key: "fix" }), task("Review", { key: "review", needs: [{ key: "fix" }] }), task("Ship", { needs: [{ key: "review" }, { key: "fix" }] })],
        idempotency_key: newKey(),
      };
      const r = await maya.ok("create_tasks", args as never);
      check(r.threads.length === 3, `create_tasks returned ${r.threads.length} threads, expected 3`);
      check(JSON.stringify(r.threads.map((t: Thread) => t.task?.state)) === JSON.stringify(["ready", "waiting", "waiting"]), `plan states: ${r.threads.map((t: Thread) => t.task?.state).join(", ")}`);
      check(r.threads[2]!.task?.needs.map((n) => n.thread_id).sort().join() === [r.threads[0]!.id, r.threads[1]!.id].sort().join(), "needs by key resolve to the plan's thread IDs");
      const again = await maya.ok("create_tasks", args as never);
      check(JSON.stringify(again.threads.map((t: Thread) => t.id)) === JSON.stringify(r.threads.map((t: Thread) => t.id)), "retrying with the same idempotency key returns the same tasks");
      check((await count()) === 3, "the retry created nothing");
      const tooMany = Array.from({ length: 16 }, (_, i) => task(`T${i}`));
      await maya.fails("create_tasks", { board_id: board, tasks: tooMany }, "invalid_argument");
    },
  },
  {
    id: "tasks.claim-wait",
    profile: "tasks",
    title: "Claim-next with wait_seconds waits for a matching task to become ready",
    timeoutMs: 60_000,
    async run(ctx) {
      const board = await mayaOnOwnerBoard(ctx);
      const maya = await ctx.session("maya");
      const tag = `cw${ctx.runId}`;
      const t0 = Date.now();
      await maya.fails("claim_task", { board_id: board, labels: { wait: `${tag}-none` }, wait_seconds: 1 }, "no_task_available");
      check(Date.now() - t0 >= 800, "a claim with wait_seconds waits before no_task_available");
      const waiting = maya.call("claim_task", { board_id: board, labels: { wait: tag }, wait_seconds: 10 });
      await sleep(700);
      const made = await newTask(ctx, "owner", `Wait ${ctx.runId}`, { labels: { wait: tag } });
      const started = Date.now();
      const r = await waiting;
      check(r.ok, `the waiting claim failed: ${r.ok ? "" : r.error.code}`);
      if (r.ok) {
        check(r.data.thread.id === made.thread.id, "the waiting claim took the new task");
        check(Date.now() - started < 8000, "the waiting claim woke soon after the task became ready");
      }
    },
  },
  {
    id: "tasks.permissions",
    profile: "tasks",
    title: "Readers cannot claim or label; task tools reject discussions; board.* labels are reserved",
    async run(ctx) {
      await quotaReaderOnOwnerBoard(ctx);
      const reader = await ctx.session("quota");
      const owner = await ctx.session("owner");
      const { thread, board } = await newTask(ctx, "owner", `Permissions ${ctx.runId}`);
      await reader.fails("claim_task", { thread_id: thread.id }, "forbidden");
      await reader.fails("set_labels", { thread_id: thread.id, set: { x: "y" } }, "forbidden");
      await owner.fails("set_labels", { thread_id: thread.id, set: { "board.task": "completed" } }, "invalid_argument");
      const d = await startThread(owner, board, `Not a task ${ctx.runId}`, "discussion");
      await owner.fails("claim_task", { thread_id: d.thread.id }, "task_not_claimable");
      await owner.fails("update_task", { thread_id: d.thread.id, action: "unblock" }, "task_not_claimable");
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
      await maya.ok("update_task", { thread_id: thread.id, action: "release", token: r.claim.token });
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
