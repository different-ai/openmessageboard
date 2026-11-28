// The inactivity lifecycle of one board: when to remind its owner, when to deactivate it, and the record that keeps
// an email from going out twice. Nothing here imports Cloudflare or the core, so it runs in tests as it does in the
// per-board Durable Object (lifecycle-object.ts). The server object answers its questions (lifecycle-server.ts).

export const LIFECYCLE_EXTENSION_ID = "openmessageboard.cloudflare/lifecycle";

const DAY_MS = 86_400_000;
/** How long to wait before trying again after an email or the server object failed. */
export const RETRY_MS = 60 * 60_000;

export interface LifecycleSettings {
  /** A board with no activity for this long is deactivated. */
  inactiveMs: number;
  /** How long before the deadline each reminder goes out: longest first, each shorter than `inactiveMs`. */
  reminderMs: number[];
  /** Changes when the settings do, so each board gives its owner the full notice again. */
  fingerprint: string;
}

/**
 * `OMB_BOARD_INACTIVE_DAYS` switches the lifecycle on (unset or 0: off). `OMB_BOARD_INACTIVE_REMINDER_DAYS` is a
 * comma-separated list of days before the deadline (default `30,7`); reminders that would fall before the board's
 * last activity are dropped. Fractions of a day are accepted, which is how the tests and a local Worker run it.
 */
export function lifecycleSettings(vars: Record<string, unknown>): LifecycleSettings | null {
  const days = Number(vars.OMB_BOARD_INACTIVE_DAYS ?? 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  const raw = typeof vars.OMB_BOARD_INACTIVE_REMINDER_DAYS === "string" ? vars.OMB_BOARD_INACTIVE_REMINDER_DAYS : "30,7";
  const reminders = [...new Set(raw.split(",").map((s) => Number(s.trim())))].filter((d) => Number.isFinite(d) && d > 0 && d < days).sort((a, b) => b - a);
  return { inactiveMs: Math.round(days * DAY_MS), reminderMs: reminders.map((d) => Math.round(d * DAY_MS)), fingerprint: `${days}:${reminders.join(",")}` };
}

/** What the server object knows about a board. Times are ISO strings. */
export interface BoardSnapshot {
  board_id: string;
  /** False once the board is deleted: its lifecycle object forgets everything. */
  exists: boolean;
  name: string;
  owner_email: string | null;
  /** The latest of: the board's creation, a post on it, its owner signing in, a "keep active" or a reactivation. */
  active_at: string;
  /** Set while the board is deactivated for inactivity. */
  deactivated_at: string | null;
  /** Disabled for another reason (an operator hid it): the lifecycle leaves it alone. */
  disabled: boolean;
}

/** What the per-board object keeps. `sent` is the ledger: a key is written before its email is handed over. */
export interface LifecycleState {
  board_id: string;
  fingerprint: string;
  /** The board is never deactivated before this time (set when it is first scheduled, or the settings change). */
  floor_at: number;
  sent: Record<string, "sending" | "sent">;
}

export type LifecycleMail =
  | { kind: "reminder"; board_id: string; name: string; to: string; deadline: Date; settings: LifecycleSettings }
  | { kind: "deactivated"; board_id: string; name: string; to: string; settings: LifecycleSettings };

export interface LifecycleDeps {
  settings: LifecycleSettings | null;
  now(): number;
  load(): Promise<LifecycleState | null>;
  save(state: LifecycleState): Promise<void>;
  forget(): Promise<void>;
  setAlarm(at: number | null): Promise<void>;
  snapshot(boardId: string): Promise<BoardSnapshot>;
  /** Asks the server object to deactivate the board. It checks activity again and answers with what is true now. */
  deactivate(boardId: string): Promise<BoardSnapshot>;
  /** Hands one email over for delivery. Throws `NotSentError` when the message was certainly not accepted. */
  send(mail: LifecycleMail): Promise<void>;
}

export interface Plan {
  deadline: number;
  /** The reminder to send now (its notice in milliseconds), if one is due. */
  remind: number | null;
  deactivate: boolean;
  /** When to look again. */
  wakeAt: number;
}

/** The deadline and the next step for an active board. Pure: the same inputs always give the same plan. */
export function plan(settings: LifecycleSettings, activeAt: number, floorAt: number, now: number): Plan {
  const deadline = Math.max(activeAt + settings.inactiveMs, floorAt);
  if (now >= deadline) return { deadline, remind: null, deactivate: true, wakeAt: now };
  // Reminders are longest notice first. The last one that is due is the one worth sending.
  const due = settings.reminderMs.filter((r) => deadline - r <= now);
  const next = settings.reminderMs.find((r) => deadline - r > now);
  return { deadline, remind: due.length ? due[due.length - 1]! : null, deactivate: false, wakeAt: next !== undefined ? deadline - next : deadline };
}

const reminderKey = (deadline: number, notice: number) => `remind|${deadline}|${notice}`;
const offKey = (deactivatedAt: string) => `off|${deactivatedAt}`;

/**
 * One pass for one board: reads what is true now, sends at most one email, and sets the Alarm for the next step.
 * Safe to run at any time and any number of times (an Alarm, a nudge from the server object, a retry after a
 * redeploy): the ledger decides whether an email goes out, never the caller.
 */
export async function runLifecycle(deps: LifecycleDeps, boardId: string, given?: BoardSnapshot): Promise<void> {
  const { settings } = deps;
  if (!settings) return deps.setAlarm(null);
  const now = deps.now();
  let snap = given ?? (await deps.snapshot(boardId));
  if (!snap.exists) return deps.forget();

  let state = await deps.load();
  if (!state || state.fingerprint !== settings.fingerprint) {
    // First schedule, or new settings: the owner gets the whole run of reminders before anything happens, however
    // long the board has already been quiet. Reminders sent under the old settings don't count.
    const off = Object.fromEntries(Object.entries(state?.sent ?? {}).filter(([k]) => k.startsWith("off|")));
    state = { board_id: boardId, fingerprint: settings.fingerprint, floor_at: now + (settings.reminderMs[0] ?? 0), sent: off };
    await deps.save(state);
  }

  if (!snap.deactivated_at && !snap.disabled) {
    let p = plan(settings, Date.parse(snap.active_at), state.floor_at, now);
    const last = settings.reminderMs.at(-1);
    if (p.deactivate && last !== undefined && snap.owner_email && !state.sent[reminderKey(p.deadline, last)]) {
      // The final reminder for this deadline never went out (the sender kept refusing it, or this object was not
      // running). A board is not deactivated unannounced: the deadline moves out by that reminder's notice.
      state.floor_at = now + last;
      await deps.save(state);
      p = plan(settings, Date.parse(snap.active_at), state.floor_at, now);
    }
    if (p.deactivate) {
      // The server object decides, in one transaction with a fresh look at activity.
      snap = await deps.deactivate(boardId);
      if (!snap.exists) return deps.forget();
      if (!snap.deactivated_at && !snap.disabled) {
        // Somebody posted or signed in meanwhile. Never loop: look again shortly.
        const again = plan(settings, Date.parse(snap.active_at), state.floor_at, now);
        return deps.setAlarm(again.deactivate ? now + RETRY_MS : again.wakeAt);
      }
    } else {
      if (p.remind !== null && !state.sent[reminderKey(p.deadline, p.remind)]) {
        // Only this deadline's keys are kept: an earlier deadline can't come back, because activity only moves forward.
        const keep = Object.entries(state.sent).filter(([k]) => k.startsWith("off|") || k.startsWith(`remind|${p.deadline}|`));
        state.sent = Object.fromEntries(keep);
        // Every reminder with more notice than this one is settled too, so a late start sends one email, not two.
        for (const r of settings.reminderMs) if (r > p.remind) state.sent[reminderKey(p.deadline, r)] ??= "sent";
        const deadline = p.deadline;
        const ok = await sendOnce(deps, state, reminderKey(deadline, p.remind), snap.owner_email, (to) => ({ kind: "reminder", board_id: boardId, name: snap.name, to, deadline: new Date(deadline), settings }));
        if (!ok) return deps.setAlarm(Math.min(now + RETRY_MS, Math.max(p.wakeAt, now + 1)));
      }
      return deps.setAlarm(p.wakeAt);
    }
  }

  if (snap.deactivated_at) {
    const ok = await sendOnce(deps, state, offKey(snap.deactivated_at), snap.owner_email, (to) => ({ kind: "deactivated", board_id: boardId, name: snap.name, to, settings }));
    if (!ok) return deps.setAlarm(now + RETRY_MS);
  }
  // Deactivated or hidden: nothing is scheduled until the server object nudges this board again.
  return deps.setAlarm(null);
}

/** Thrown by `send` when the message was certainly not accepted, so trying again can't deliver it twice. */
export class NotSentError extends Error {}

/**
 * Sends one email at most once. The key is stored before the message is handed over, so a restart in between loses
 * that email instead of repeating it. Only a send that certainly failed (`NotSentError`) clears the key for another
 * try; after any other failure nobody knows whether it went out, so it counts as sent.
 */
async function sendOnce(deps: LifecycleDeps, state: LifecycleState, key: string, to: string | null, mail: (to: string) => LifecycleMail): Promise<boolean> {
  if (state.sent[key]) return true;
  state.sent[key] = to ? "sending" : "sent";
  await deps.save(state);
  if (!to) return true;
  try {
    await deps.send(mail(to));
  } catch (e) {
    if (!(e instanceof NotSentError)) return true;
    delete state.sent[key];
    await deps.save(state);
    return false;
  }
  state.sent[key] = "sent";
  await deps.save(state);
  return true;
}

// ---------- links in the emails ----------

export type LinkAction = "keep" | "reactivate";

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sign(secret: string, action: LinkAction, boardId: string, expires: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(`openmessageboard.cloudflare/lifecycle|${action}|${boardId}|${expires}`)));
}

/** A token for one action on one board, signed with `OMB_SECRET`. It names no person and carries no access. */
export async function linkToken(secret: string, action: LinkAction, boardId: string, expires: number): Promise<string> {
  return `${expires}.${await sign(secret, action, boardId, expires)}`;
}

export async function checkLinkToken(secret: string, action: LinkAction, boardId: string, token: string, now: number): Promise<boolean> {
  const [exp, sig, ...rest] = token.split(".");
  const expires = Number(exp);
  if (rest.length || !sig || !Number.isSafeInteger(expires) || expires < now) return false;
  const want = await sign(secret, action, boardId, expires);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function linkUrl(base: string, action: LinkAction, boardId: string, token: string): string {
  return `${base.replace(/\/$/, "")}/x/lifecycle/${action}?board=${encodeURIComponent(boardId)}&t=${encodeURIComponent(token)}`;
}

/** How long a link in an email keeps working after it was sent. */
export const KEEP_LINK_MS = 14 * DAY_MS;
export const REACTIVATE_LINK_MS = 365 * DAY_MS;

function span(ms: number): string {
  const days = ms / DAY_MS;
  if (days >= 1) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The text of an email. Board names are member content: they are quoted as data and never decide a link. */
export async function composeMail(mail: LifecycleMail, opts: { base: string; secret: string; now: number }): Promise<{ to: string; subject: string; text: string }> {
  const base = opts.base.replace(/\/$/, "");
  const name = mail.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Your board";
  if (mail.kind === "reminder") {
    const left = Math.max(0, mail.deadline.getTime() - opts.now);
    const keep = linkUrl(base, "keep", mail.board_id, await linkToken(opts.secret, "keep", mail.board_id, mail.deadline.getTime() + KEEP_LINK_MS));
    return {
      to: mail.to,
      subject: `"${name}" will be deactivated in ${span(left)}`,
      text: [
        `Nobody has posted on your board "${name}" at ${base} for a while, and you haven't signed in.`,
        `Boards with no activity for ${span(mail.settings.inactiveMs)} are deactivated. Yours will be on ${mail.deadline.toISOString().slice(0, 10)}.`,
        `Keep it active:\n${keep}`,
        "Posting on the board or signing in also keeps it active. A deactivated board is not deleted: its messages and members are kept, and you can reactivate it.",
      ].join("\n\n"),
    };
  }
  const reactivate = linkUrl(base, "reactivate", mail.board_id, await linkToken(opts.secret, "reactivate", mail.board_id, opts.now + REACTIVATE_LINK_MS));
  return {
    to: mail.to,
    subject: `"${name}" has been deactivated`,
    text: [
      `Your board "${name}" at ${base} had no activity for ${span(mail.settings.inactiveMs)} and has been deactivated.`,
      "Nothing was deleted. Its messages and members are kept, but nobody can read or post on it, and nothing is delivered from it, until you reactivate it.",
      `Reactivate it:\n${reactivate}`,
      `To download a copy instead, sign in at ${base} and open:\n${base}/x/lifecycle/boards/${encodeURIComponent(mail.board_id)}/export`,
    ].join("\n\n"),
  };
}
