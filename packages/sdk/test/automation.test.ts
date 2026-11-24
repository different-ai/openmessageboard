import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OmbClient, OmbError, toSeconds, type WatchItem } from "../src/index.ts";
import { FakeServer, MAYA, OMAR } from "./fake-server.ts";

const schedule = (over: Record<string, unknown> = {}) => ({
  id: "sch_1",
  board_id: "b_main",
  thread_id: null,
  title: "Standup",
  body: "notes",
  labels: {},
  mentions: [],
  created_by: MAYA,
  created_at: new Date().toISOString(),
  state: "pending",
  next_run_at: new Date().toISOString(),
  every_seconds: 86_400,
  times: null,
  until: null,
  runs: 0,
  last_run_at: null,
  last_message_id: null,
  last_error: null,
  stopped_reason: null,
  ...over,
});

describe("filters, schedules and watchers", () => {
  it("parses durations", () => {
    assert.equal(toSeconds(90), 90);
    assert.equal(toSeconds("30s"), 30);
    assert.equal(toSeconds("10m"), 600);
    assert.equal(toSeconds("12h"), 43_200);
    assert.equal(toSeconds("1d"), 86_400);
    assert.equal(toSeconds("2w"), 1_209_600);
    assert.throws(() => toSeconds("soon"), (e: unknown) => e instanceof OmbError && e.code === "invalid_argument");
  });

  it("messages() reads with filters; schedule() sends seconds and instants", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    fake.tools.read_messages = (args) => ({ messages: [], cursor: "c1", has_more: false, echo: args });
    fake.tools.schedule_post = (args) => ({ schedule: schedule({ every_seconds: args.every_seconds ?? null }) });
    try {
      const page = await client.messages("b_main", { by: "maya", labels: { kind: "bug" }, limit: 10 });
      assert.equal(page.cursor, "c1");
      assert.deepEqual(fake.calls.find((c) => c.name === "read_messages")!.args, { by: "maya", labels: { kind: "bug" }, limit: 10, board_id: "b_main" });
      const at = new Date("2026-12-01T09:00:00Z");
      const s = await client.schedule({ board: "b_main", title: "Standup" }, { body: "notes", every: "1d", at, times: 5 });
      assert.equal(s.every_seconds, 86_400);
      assert.deepEqual(fake.calls.find((c) => c.name === "schedule_post")!.args, {
        board_id: "b_main",
        title: "Standup",
        body: "notes",
        at: "2026-12-01T09:00:00.000Z",
        every_seconds: 86_400,
        times: 5,
      });
      await client.schedule({ thread: "t_1" }, { body: "ping", in: "1d" });
      assert.deepEqual(fake.calls.filter((c) => c.name === "schedule_post")[1]!.args, { thread_id: "t_1", body: "ping", in_seconds: 86_400 });
    } finally {
      await client.close();
      await fake.stop();
    }
  });

  it("waitForChanges sends after on the first wait and the cursor afterwards, with the filters each time", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { thread, message } = fake.addThread("Question", MAYA);
    const waits: Record<string, unknown>[] = [];
    let n = 0;
    fake.tools.wait_for_activity = (args) => {
      waits.push(args);
      n++;
      if (n === 1) return { changes: [], cursor: "c5", has_more: false };
      const answer = fake.postMessage(thread.id, "the answer", OMAR);
      return { changes: fake.events.filter((e) => e.message_id === answer.id), cursor: fake.cursorFor(fake.lastSeq), has_more: false };
    };
    try {
      const result = await client.waitForChanges({ board: fake.boardId }, { after: message.id, filters: { re: thread.id, by: "omar" }, timeoutMs: 10_000 });
      assert.ok(result && result.changes.length === 1);
      assert.equal(waits[0]!.after, message.id);
      assert.equal(waits[0]!.cursor, undefined);
      assert.equal(waits[1]!.cursor, "c5");
      assert.equal(waits[1]!.after, undefined);
      for (const w of waits) assert.equal(w.by, "omar");
      assert.equal(waits[0]!.re, thread.id);
    } finally {
      await client.close();
      await fake.stop();
    }
  });

  it("watch passes filters and after to get_changes", async () => {
    const fake = await new FakeServer({ listen: "ignore" }).start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    const { message } = fake.addThread("Bugs", MAYA);
    const seen: WatchItem[] = [];
    const stop = client.watch({ board: fake.boardId }, { mode: "poll", pollSeconds: 1, after: message.id, filters: { labels: { kind: "bug" } }, onChange: (i) => void seen.push(i) });
    try {
      for (let i = 0; i < 200 && !fake.calls.some((c) => c.name === "wait_for_activity"); i++) await new Promise((r) => setTimeout(r, 10));
      const first = fake.calls.find((c) => c.name === "get_changes")!;
      assert.equal(first.args.after, message.id);
      assert.deepEqual(first.args.labels, { kind: "bug" });
      const wait = fake.calls.find((c) => c.name === "wait_for_activity")!;
      assert.deepEqual(wait.args.labels, { kind: "bug" });
    } finally {
      await stop();
      await client.close();
      await fake.stop();
    }
  });
});
