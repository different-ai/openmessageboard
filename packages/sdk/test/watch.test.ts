import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { OmbClient, OmbError, backoffDelay, type WatchItem, type WatchStatus } from "../src/index.ts";
import { FakeServer, OMAR } from "./fake-server.ts";

function bodies(items: WatchItem[]): string[] {
  return items.flatMap((i) => ("seq" in i && i.type === "message.created" && i.message?.body ? [i.message.body] : []));
}

async function until(cond: () => boolean, ms = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("watch", () => {
  it("opens listen first, catches up from a saved cursor in pages, dedupes, and handles a notification during catch-up", async () => {
    const fake = await new FakeServer({ pageSize: 2 }).start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread } = fake.addThread("Release 1.4");
    const saved = fake.cursorFor(fake.lastSeq);
    fake.postMessage(thread.id, "one");
    fake.postMessage(thread.id, "two");
    fake.postMessage(thread.id, "three");

    // Serve the first page twice so the client sees the same changes again (as after a lost response).
    let getChangesCalls = 0;
    const original = fake.tools.get_changes!;
    fake.tools.get_changes = async (args, ctx) => {
      getChangesCalls++;
      if (getChangesCalls === 2) return original({ ...args, cursor: saved }, ctx);
      return original(args, ctx);
    };
    // While the last catch-up page is in flight, a new message arrives (with its notification) that the page misses.
    let injected = false;
    fake.afterGetChanges = (args) => {
      if (!injected && args.cursor && args.cursor !== saved && Number(String(args.cursor).slice(1)) >= fake.lastSeq - 1) {
        injected = true;
        fake.postMessage(thread.id, "four");
      }
    };

    const seen: WatchItem[] = [];
    const cursors: string[] = [];
    const statuses: WatchStatus[] = [];
    let listenOpenWhenCatchUpStarted: boolean | undefined;
    fake.beforeGetChanges = () => {
      listenOpenWhenCatchUpStarted ??= fake.openListens > 0;
    };
    const stop = client.watch(
      { board: fake.boardId },
      {
        cursor: saved,
        onChange: async (item) => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(item);
        },
        onCursor: (c) => void cursors.push(c),
        onStatus: (s) => void statuses.push(s),
      },
    );
    try {
      await until(() => bodies(seen).length >= 4, 5000, "four messages");
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(bodies(seen), ["one", "two", "three", "four"]);
      assert.ok(injected, "a message arrived during the catch-up");
      assert.ok(getChangesCalls >= 4, "the repeated page was fetched and skipped");
      const seqs = seen.map((i) => ("seq" in i ? i.seq : -1));
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "in order");
      assert.equal(new Set(seqs).size, seqs.length, "each change once");
      assert.equal(listenOpenWhenCatchUpStarted, true, "live channel opened before the catch-up");
      assert.ok(statuses.some((s) => s.state === "live" && s.via === "listen"));
      assert.equal(stop.cursor(), fake.cursorFor(fake.lastSeq));
      assert.equal(cursors.at(-1), fake.cursorFor(fake.lastSeq));
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });

  it("does not advance the cursor until the handler resolves, and retries a failed handler", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread } = fake.addThread("Flaky handler");
    const start = fake.cursorFor(fake.lastSeq);
    fake.postMessage(thread.id, "poison once");
    let failures = 0;
    let cursorAtFailure: string | undefined;
    const handled: string[] = [];
    const errors: OmbError[] = [];
    const stop = client.watch(
      { thread: thread.id },
      {
        cursor: start,
        backoff: { initialMs: 10, maxMs: 20 },
        onChange: (item) => {
          if (failures++ === 0) {
            cursorAtFailure = stop.cursor();
            throw new Error("boom");
          }
          handled.push(bodies([item])[0] ?? "");
        },
        onError: (e) => void errors.push(e),
      },
    );
    try {
      await until(() => handled.length === 1, 5000, "handled after retry");
      assert.deepEqual(handled, ["poison once"]);
      assert.equal(errors[0]?.code, "handler");
      assert.equal(cursorAtFailure, start, "cursor not advanced past an unhandled change");
      await until(() => stop.cursor() === fake.cursorFor(fake.lastSeq), 2000, "cursor advanced after success");
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });

  it("falls back to wait_for_activity when the server does not acknowledge the URI", async () => {
    const fake = await new FakeServer({ listen: "ignore" }).start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread } = fake.addThread("Polling");
    const seen: WatchItem[] = [];
    const statuses: WatchStatus[] = [];
    const stop = client.watch({ thread: thread.id }, { onChange: (i) => void seen.push(i), onStatus: (s) => void statuses.push(s), pollSeconds: 2 });
    try {
      await until(() => statuses.some((s) => s.state === "live"), 5000, "live");
      assert.ok(statuses.some((s) => s.state === "live" && s.via === "wait_for_activity"));
      fake.postMessage(thread.id, "polled reply", OMAR);
      await until(() => bodies(seen).includes("polled reply"), 5000, "polled reply");
      assert.ok(fake.calls.some((c) => c.name === "wait_for_activity" && c.args.thread_id === thread.id));
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });

  it("reconnects after the listen stream drops and catches up what it missed", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread } = fake.addThread("Reconnect");
    const seen: WatchItem[] = [];
    const stop = client.watch({ board: fake.boardId }, { onChange: (i) => void seen.push(i), backoff: { initialMs: 20, maxMs: 40 } });
    try {
      await until(() => fake.openListens === 1, 5000, "listening");
      fake.dropListens();
      fake.postMessage(thread.id, "while away", OMAR);
      await until(() => bodies(seen).includes("while away"), 5000, "missed message");
      await until(() => fake.openListens === 1, 5000, "listening again");
      fake.postMessage(thread.id, "after reconnect", OMAR);
      await until(() => bodies(seen).includes("after reconnect"), 5000, "live message");
      assert.deepEqual(bodies(seen), ["while away", "after reconnect"]);
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });

  it("calls onResync on cursor_expired and continues from the cursor it returns", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread } = fake.addThread("Old");
    fake.expiredCursors.add("c0");
    const fresh = fake.cursorFor(fake.lastSeq);
    fake.postMessage(thread.id, "after resync", OMAR);
    const resyncs: Array<string | undefined> = [];
    const seen: WatchItem[] = [];
    const stop = client.watch(
      { board: fake.boardId },
      {
        cursor: "c0",
        onChange: (i) => void seen.push(i),
        onResync: ({ expiredCursor }) => {
          resyncs.push(expiredCursor);
          return fresh;
        },
      },
    );
    try {
      await until(() => bodies(seen).includes("after resync"), 5000, "resync");
      assert.deepEqual(resyncs, ["c0"]);
      assert.deepEqual(bodies(seen), ["after resync"]);
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });

  it("stops on a fatal error and reports it through done", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const handle = client.watch({ thread: "t_missing" }, { onChange: () => {} });
    try {
      const err = await handle.done;
      assert.equal(err?.code, "not_found");
    } finally {
      await handle();
      await client.close();
      await fake.stop();
    }
  });

  it("backs off while the server is unreachable and stop() ends the wait immediately", async () => {
    // Reserve a port and close it so connections are refused.
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const client = new OmbClient({ server: `http://127.0.0.1:${port}`, token: "t", requestTimeoutMs: 2000 });
    const statuses: WatchStatus[] = [];
    const errors: OmbError[] = [];
    const handle = client.watch(
      { board: "b_main" },
      { onChange: () => {}, backoff: { initialMs: 60_000, maxMs: 60_000 }, onStatus: (s) => void statuses.push(s), onError: (e) => void errors.push(e) },
    );
    await until(() => statuses.some((s) => s.state === "reconnecting"), 5000, "reconnecting");
    const reconnecting = statuses.find((s) => s.state === "reconnecting");
    assert.ok(reconnecting && reconnecting.state === "reconnecting" && reconnecting.inMs <= 60_000);
    assert.equal(errors[0]?.code, "network");
    const started = Date.now();
    await handle();
    assert.ok(Date.now() - started < 1000, "stop() does not wait out the backoff");
    assert.equal(await handle.done, undefined);
    assert.equal(statuses.at(-1)?.state, "stopped");
    const attempts = statuses.filter((s) => s.state === "connecting").length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(statuses.filter((s) => s.state === "connecting").length, attempts, "no attempts after stop");
    await client.close();
  });

  it("uses full-jitter backoff capped at the maximum", () => {
    assert.equal(backoffDelay(0, 1000, 60_000, () => 0.999), 999);
    assert.equal(backoffDelay(3, 1000, 60_000, () => 0.5), 4000);
    assert.equal(backoffDelay(20, 1000, 60_000, () => 0.999), 59_940);
    assert.equal(backoffDelay(5, 1000, 60_000, () => 0), 0);
  });
});
