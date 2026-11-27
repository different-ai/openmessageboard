import type { Message, TaskClaim, Thread, ToolInput } from "@openmessageboard/protocol";
import type { CallOptions, OmbClient } from "./client.js";

/** What `ClaimedTask` needs from the client (kept narrow so the class is easy to fake in tests). */
type TaskClient = Pick<OmbClient, "renewTask" | "updateTask">;

/** One task of a `createMany` plan. `needs` takes thread IDs of existing tasks or `{ key }` of a task in the same plan. */
export type PlanTask = ToolInput<"create_tasks">["tasks"][number];

/**
 * A claim you hold on a task: a lease that ends at `until` unless renewed. Settle it with `complete`, `fail`,
 * `release` or `block`. Once the claim is over (the lease ran out, or the task was released, blocked, canceled or
 * claimed again) every method throws `OmbError` with code `claim_lost` and changes nothing.
 */
export class ClaimedTask {
  #thread: Thread;
  #claim: TaskClaim;

  constructor(
    private readonly client: TaskClient,
    thread: Thread,
    claim: TaskClaim,
  ) {
    this.#thread = thread;
    this.#claim = claim;
  }

  /** The task's thread ID. */
  get id(): string {
    return this.#thread.id;
  }
  /** The thread as of the last call on this claim. */
  get thread(): Thread {
    return this.#thread;
  }
  get epoch(): number {
    return this.#claim.epoch;
  }
  get token(): string {
    return this.#claim.token;
  }
  /** When the lease ends (RFC 3339). */
  get until(): string {
    return this.#claim.until;
  }
  /** The claim as stored by `heldTask` callers: `{ epoch, token, until }`. */
  get claim(): TaskClaim {
    return { ...this.#claim };
  }
  /** Milliseconds until the lease ends (negative once it has). */
  remainingMs(now: number = Date.now()): number {
    return Date.parse(this.#claim.until) - now;
  }

  /** Extends the lease from now, up to the server's `task_lease_seconds`. */
  async renew(leaseSeconds?: number, options?: CallOptions): Promise<this> {
    const res = await this.client.renewTask({ thread_id: this.id, token: this.#claim.token, ...(leaseSeconds ? { lease_seconds: leaseSeconds } : {}) }, options);
    this.#thread = res.thread;
    this.#claim = res.claim;
    return this;
  }

  /** Finishes the task. A result is posted as a reply (with an idempotency key, so a retry posts it once). */
  async complete(result?: string, options?: CallOptions & { idempotencyKey?: string }): Promise<{ thread: Thread; message: Message | null }> {
    const res = await this.client.updateTask(
      {
        thread_id: this.id,
        action: "complete",
        token: this.#claim.token,
        ...(result?.trim() ? { result, idempotency_key: options?.idempotencyKey ?? crypto.randomUUID() } : {}),
      },
      options,
    );
    this.#thread = res.thread;
    return res;
  }

  /** Gives up on the task, with a reason. Its owner can reopen it. */
  async fail(reason: string, options?: CallOptions): Promise<Thread> {
    return this.#settle({ action: "fail", reason }, options);
  }

  /** Returns the task to the queue. */
  async release(options?: CallOptions): Promise<Thread> {
    return this.#settle({ action: "release" }, options);
  }

  /** Holds the task for a person (ends the claim). `kind` says what for, such as `needs_input`. */
  async block(reason: string, opts: { kind?: string } & CallOptions = {}): Promise<Thread> {
    const { kind, ...options } = opts;
    return this.#settle({ action: "block", reason, ...(kind ? { kind } : {}) }, options);
  }

  async #settle(input: Omit<ToolInput<"update_task">, "thread_id" | "token">, options?: CallOptions): Promise<Thread> {
    const res = await this.client.updateTask({ ...input, thread_id: this.id, token: this.#claim.token }, options);
    this.#thread = res.thread;
    return res.thread;
  }
}
