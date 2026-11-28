import test from "node:test";
import assert from "node:assert/strict";
import {
  NotSentError,
  RETRY_MS,
  checkLinkToken,
  composeMail,
  lifecycleSettings,
  linkToken,
  plan,
  runLifecycle,
  type BoardSnapshot,
  type LifecycleDeps,
  type LifecycleMail,
  type LifecycleState,
} from "../src/lifecycle.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2027-01-01T00:00:00Z");
const SETTINGS = lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "90" })!;

/** One board's lifecycle object, with storage that outlives it (a restart is a new `deps()` over the same store). */
function world(settings = SETTINGS) {
  const w = {
    now: T0,
    settings: settings as typeof SETTINGS | null,
    store: { state: null as LifecycleState | null },
    alarm: null as number | null,
    board: { board_id: "b1", exists: true, name: "Release notes", owner_email: "maya@example.test", active_at: new Date(T0).toISOString(), deactivated_at: null, disabled: false } as BoardSnapshot,
    sent: [] as LifecycleMail[],
    failSends: 0,
    unclearAfterHandOver: false,
    deactivations: 0,
    deps(): LifecycleDeps {
      return {
        settings: w.settings,
        now: () => w.now,
        // Storage keeps copies, as a Durable Object's does.
        load: async () => (w.store.state ? structuredClone(w.store.state) : null),
        save: async (s) => void (w.store.state = structuredClone(s)),
        forget: async () => {
          w.store.state = null;
          w.alarm = null;
        },
        setAlarm: async (at) => void (w.alarm = at),
        snapshot: async () => structuredClone(w.board),
        deactivate: async () => {
          w.deactivations++;
          if (w.now >= Date.parse(w.board.active_at) + w.settings!.inactiveMs) w.board.deactivated_at = new Date(w.now).toISOString();
          return structuredClone(w.board);
        },
        send: async (mail) => {
          if (w.failSends > 0) {
            w.failSends--;
            throw new NotSentError("refused");
          }
          w.sent.push(mail);
          if (w.unclearAfterHandOver) throw new Error("connection lost");
        },
      };
    },
    run: () => runLifecycle(w.deps(), "b1"),
    /** Runs the Alarm whenever it is due, up to `until`, as the platform would. */
    async advance(until: number) {
      for (let i = 0; i < 100 && w.alarm !== null && w.alarm <= until; i++) {
        w.now = Math.max(w.now, w.alarm);
        await w.run();
      }
      w.now = until;
    },
  };
  return w;
}
const kinds = (w: ReturnType<typeof world>) => w.sent.map((m) => (m.kind === "reminder" ? `reminder:${m.deadline.toISOString().slice(0, 10)}` : "deactivated"));

test("settings: off unless a period is set; reminders default to 30 and 7 days and never precede the last activity", () => {
  assert.equal(lifecycleSettings({}), null);
  assert.equal(lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "0" }), null);
  assert.equal(lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "soon" }), null);
  assert.deepEqual(SETTINGS, { inactiveMs: 90 * DAY, reminderMs: [30 * DAY, 7 * DAY], fingerprint: "90:30,7" });
  assert.deepEqual(lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "14", OMB_BOARD_INACTIVE_REMINDER_DAYS: "30, 7,7,x,3" })!.reminderMs, [7 * DAY, 3 * DAY]);
  assert.deepEqual(lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "5" })!.reminderMs, []);
});

test("plan: wakes for each reminder, then the deadline", () => {
  const p = (now: number) => plan(SETTINGS, T0, 0, T0 + now);
  assert.deepEqual(p(0), { deadline: T0 + 90 * DAY, remind: null, deactivate: false, wakeAt: T0 + 60 * DAY });
  assert.deepEqual(p(60 * DAY), { deadline: T0 + 90 * DAY, remind: 30 * DAY, deactivate: false, wakeAt: T0 + 83 * DAY });
  assert.deepEqual(p(84 * DAY), { deadline: T0 + 90 * DAY, remind: 7 * DAY, deactivate: false, wakeAt: T0 + 90 * DAY });
  assert.equal(p(90 * DAY).deactivate, true);
});

test("a quiet board gets a reminder 30 days and 7 days before, then is deactivated and told so, each once", async () => {
  const w = world();
  // A board that has just been created: its first deadline is 90 days out.
  await w.run();
  assert.equal(w.alarm, T0 + 60 * DAY);
  await w.advance(T0 + 59 * DAY);
  assert.deepEqual(kinds(w), []);
  await w.advance(T0 + 61 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-04-01"]);
  await w.advance(T0 + 84 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-04-01", "reminder:2027-04-01"]);
  await w.advance(T0 + 91 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-04-01", "reminder:2027-04-01", "deactivated"]);
  assert.equal(w.deactivations, 1);
  assert.equal(w.board.deactivated_at, new Date(T0 + 90 * DAY).toISOString());
  assert.equal(w.alarm, null, "a deactivated board has no Alarm");
  // Any number of further runs change nothing.
  await w.run();
  await w.run();
  assert.equal(w.sent.length, 3);
});

test("running again and again, across restarts, never repeats a reminder", async () => {
  const w = world();
  await w.run();
  w.now = T0 + 60 * DAY;
  for (let i = 0; i < 5; i++) await w.run();
  w.now = T0 + 70 * DAY;
  for (let i = 0; i < 5; i++) await runLifecycle(w.deps(), "b1", structuredClone(w.board));
  assert.deepEqual(kinds(w), ["reminder:2027-04-01"]);
  assert.equal(w.alarm, T0 + 83 * DAY);
});

test("a restart between the mark and the email loses that email; it is never sent later", async () => {
  const w = world();
  await w.run();
  w.now = T0 + 60 * DAY;
  // What storage holds if the object stops right after marking the reminder: the mark, and no email.
  w.store.state!.sent[`remind|${T0 + 90 * DAY}|${30 * DAY}`] = "sending";
  await w.run();
  await w.run();
  assert.equal(w.sent.length, 0);
  assert.equal(w.alarm, T0 + 83 * DAY, "the next reminder is still scheduled");
});

test("a failure after the email was handed over is not retried, because it may have gone out", async () => {
  const w = world();
  await w.run();
  w.now = T0 + 60 * DAY;
  w.unclearAfterHandOver = true;
  await w.run();
  w.unclearAfterHandOver = false;
  await w.run();
  await w.run();
  assert.equal(w.sent.length, 1);
  assert.equal(w.alarm, T0 + 83 * DAY);
});

test("a board is not deactivated while its final reminder keeps being refused", async () => {
  const w = world();
  await w.run();
  await w.advance(T0 + 61 * DAY);
  w.failSends = 1e9;
  await w.advance(T0 + 95 * DAY);
  assert.equal(w.deactivations, 0);
  assert.equal(w.board.deactivated_at, null);
  // The sender works again: the reminder goes out with a new date, and the board gets that notice in full.
  w.failSends = 0;
  await w.advance(T0 + 96 * DAY);
  assert.equal(w.sent.length, 2);
  const deadline = (w.sent[1] as { deadline: Date }).deadline.getTime();
  assert.ok(deadline >= T0 + 95 * DAY + 7 * DAY - 2 * RETRY_MS && deadline <= T0 + 96 * DAY + 7 * DAY);
  await w.advance(deadline + DAY);
  assert.equal(kinds(w).at(-1), "deactivated");
  assert.equal(w.sent.length, 3);
});

test("an email the sender refused is tried again later, and still goes out once", async () => {
  const w = world();
  await w.run();
  w.now = T0 + 60 * DAY;
  w.failSends = 2;
  await w.run();
  assert.equal(w.sent.length, 0);
  assert.equal(w.alarm, w.now + RETRY_MS);
  await w.advance(T0 + 60 * DAY + 3 * RETRY_MS);
  assert.deepEqual(kinds(w), ["reminder:2027-04-01"]);
  assert.equal(w.alarm, T0 + 83 * DAY);
});

test("activity moves the deadline: no reminder for the old one, and the next ones are for the new one", async () => {
  const w = world();
  await w.run();
  // Somebody posts on day 50. Nothing tells the object; it finds out when its Alarm fires on day 60.
  w.board.active_at = new Date(T0 + 50 * DAY).toISOString();
  await w.advance(T0 + 61 * DAY);
  assert.deepEqual(kinds(w), []);
  assert.equal(w.alarm, T0 + 110 * DAY);
  await w.advance(T0 + 111 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-05-21"]);
  // The owner follows the link on day 112: the server object nudges the board with what is true now.
  w.board.active_at = new Date(T0 + 112 * DAY).toISOString();
  await runLifecycle(w.deps(), "b1", structuredClone(w.board));
  assert.equal(w.alarm, T0 + 172 * DAY);
  await w.advance(T0 + 140 * DAY);
  assert.equal(w.sent.length, 1);
  assert.equal(w.deactivations, 0);
});

test("activity at the last moment: the server object refuses, and the board is rescheduled", async () => {
  const w = world();
  await w.run();
  await w.advance(T0 + 89 * DAY);
  w.now = T0 + 90 * DAY;
  // The object's snapshot is stale by the time it asks to deactivate.
  const stale = structuredClone(w.board);
  w.board.active_at = new Date(T0 + 90 * DAY - 1000).toISOString();
  await runLifecycle(w.deps(), "b1", stale);
  assert.equal(w.deactivations, 1);
  assert.equal(w.board.deactivated_at, null);
  assert.equal(w.alarm, T0 + 150 * DAY - 1000);
  assert.equal(w.sent.length, 2, "nothing new was sent");
});

test("a board that was already quiet when the lifecycle is switched on gets its notice first", async () => {
  const w = world();
  // Last activity 200 days ago: past the deadline on the day the operator sets the period.
  w.board.active_at = new Date(T0 - 200 * DAY).toISOString();
  await w.run();
  assert.equal(w.deactivations, 0);
  assert.deepEqual(kinds(w), ["reminder:2027-01-31"], "one reminder, naming a date 30 days out");
  await w.advance(T0 + 24 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-01-31", "reminder:2027-01-31"]);
  await w.advance(T0 + 31 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-01-31", "reminder:2027-01-31", "deactivated"]);
});

test("a late start sends the nearest reminder only", async () => {
  const w = world();
  w.board.active_at = new Date(T0 - 85 * DAY).toISOString();
  w.store.state = { board_id: "b1", fingerprint: SETTINGS.fingerprint, floor_at: 0, sent: {} };
  await w.run();
  assert.equal(w.sent.length, 1, "the 30-day reminder is not sent five days before the deadline");
  await w.advance(T0 + 6 * DAY);
  assert.deepEqual(kinds(w), ["reminder:2027-01-06", "deactivated"]);
});

test("new settings start the notice again; the deactivation email is still not repeated", async () => {
  const w = world();
  await w.run();
  await w.advance(T0 + 61 * DAY);
  assert.equal(w.sent.length, 1);
  w.settings = lifecycleSettings({ OMB_BOARD_INACTIVE_DAYS: "30", OMB_BOARD_INACTIVE_REMINDER_DAYS: "7" })!;
  await w.run();
  // Under the new period the board is long overdue, but it gets seven days and a reminder first.
  assert.equal(w.deactivations, 0);
  assert.equal(w.sent.length, 2);
  await w.advance(T0 + 70 * DAY);
  assert.equal(kinds(w).at(-1), "deactivated");
  const total = w.sent.length;
  w.settings = SETTINGS;
  await w.run();
  assert.equal(w.sent.length, total);
});

test("reactivation starts a new deadline, and a second deactivation is announced again", async () => {
  const w = world();
  await w.run();
  await w.advance(T0 + 91 * DAY);
  assert.equal(kinds(w).at(-1), "deactivated");
  w.board.deactivated_at = null;
  w.board.active_at = new Date(T0 + 100 * DAY).toISOString();
  w.now = T0 + 100 * DAY;
  await runLifecycle(w.deps(), "b1", structuredClone(w.board));
  assert.equal(w.alarm, T0 + 160 * DAY);
  await w.advance(T0 + 191 * DAY);
  assert.deepEqual(kinds(w).slice(3), ["reminder:2027-07-10", "reminder:2027-07-10", "deactivated"]);
});

test("switched off, hidden by an operator, or deleted: nothing is sent and nothing is scheduled", async () => {
  const off = world();
  await off.run();
  off.settings = null;
  off.now = T0 + 200 * DAY;
  await off.run();
  assert.deepEqual([off.sent.length, off.alarm, off.deactivations], [0, null, 0]);

  const hidden = world();
  hidden.board.disabled = true;
  hidden.now = T0 + 200 * DAY;
  await hidden.run();
  assert.deepEqual([hidden.sent.length, hidden.alarm, hidden.deactivations], [0, null, 0]);

  const gone = world();
  await gone.run();
  gone.board.exists = false;
  await gone.advance(T0 + 61 * DAY);
  assert.deepEqual([gone.sent.length, gone.alarm, gone.store.state], [0, null, null]);
});

test("an owner without an address is not emailed, and the board still follows its schedule", async () => {
  const w = world();
  w.board.owner_email = null;
  await w.run();
  await w.advance(T0 + 91 * DAY);
  assert.equal(w.sent.length, 0);
  assert.equal(w.deactivations, 1);
});

test("links: a token is good for one action on one board until it expires", async () => {
  const secret = "s".repeat(32);
  const token = await linkToken(secret, "keep", "b1", T0 + DAY);
  assert.equal(await checkLinkToken(secret, "keep", "b1", token, T0), true);
  assert.equal(await checkLinkToken(secret, "keep", "b2", token, T0), false);
  assert.equal(await checkLinkToken(secret, "reactivate", "b1", token, T0), false);
  assert.equal(await checkLinkToken("t".repeat(32), "keep", "b1", token, T0), false);
  assert.equal(await checkLinkToken(secret, "keep", "b1", token, T0 + DAY + 1), false);
  // A later expiry can't be claimed with the same signature.
  assert.equal(await checkLinkToken(secret, "keep", "b1", `${T0 + 9 * DAY}.${token.split(".")[1]}`, T0), false);
  for (const bad of ["", "x", "1.2.3", `${T0 + DAY}.`]) assert.equal(await checkLinkToken(secret, "keep", "b1", bad, T0), false);
});

test("emails: the reminder names the date and carries a working keep link; the deactivation says nothing was deleted", async () => {
  const secret = "s".repeat(32);
  const opts = { base: "https://omb.example/", secret, now: T0 + 60 * DAY };
  const reminder = await composeMail({ kind: "reminder", board_id: "b1", name: "Release\nnotes", to: "maya@example.test", deadline: new Date(T0 + 90 * DAY), settings: SETTINGS }, opts);
  assert.equal(reminder.to, "maya@example.test");
  assert.equal(reminder.subject, '"Release notes" will be deactivated in 30 days');
  assert.match(reminder.text, /on 2027-04-01/);
  const url = new URL(reminder.text.match(/https:\/\/omb\.example\/x\/lifecycle\/keep\S+/)![0]);
  assert.equal(await checkLinkToken(secret, "keep", url.searchParams.get("board")!, url.searchParams.get("t")!, T0 + 95 * DAY), true);

  const off = await composeMail({ kind: "deactivated", board_id: "b1", name: "Release notes", to: "maya@example.test", settings: SETTINGS }, opts);
  assert.match(off.text, /Nothing was deleted/);
  assert.match(off.text, /https:\/\/omb\.example\/x\/lifecycle\/boards\/b1\/export/);
  const back = new URL(off.text.match(/https:\/\/omb\.example\/x\/lifecycle\/reactivate\S+/)![0]);
  assert.equal(await checkLinkToken(secret, "reactivate", "b1", back.searchParams.get("t")!, T0 + 200 * DAY), true);
});
