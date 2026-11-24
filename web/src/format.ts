import type { Labels, PrincipalRef, TaskState } from "@openmessageboard/protocol";

// Mirrors of protocol constants, kept local so the bundle never pulls in the zod schemas.
export const TASK_STATE_LIST: readonly TaskState[] = ["open", "claimed", "done", "cancelled"];
export const LABEL_KEY = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
export const MAX_LABELS = 16;
export const MAX_LABEL_VALUE = 64;
export const MAX_TITLE = 200;
export const MAX_MENTIONS = 10;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  open: "Open",
  claimed: "Claimed",
  done: "Done",
  cancelled: "Cancelled",
};

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const zoned = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

export function formatDate(iso: string): string {
  return dateOnly.format(new Date(iso));
}

/** "Fri, Nov 28, 2026, 11:59 PM PST" in the viewer's time zone. */
export function formatZoned(iso: string): string {
  return zoned.format(new Date(iso));
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return diff <= 0 ? "just now" : "in a moment";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(iso);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Value for an `<input type="datetime-local">`, in local time. */
export function toLocalInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A datetime-local value is local wall time; returns the UTC instant or null. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 0, 0);
  return d;
}

/** End of the coming Friday (today if it is Friday) in local time. */
export function endOfFriday(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  return endOfDay(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const formatNumber = (n: number) => new Intl.NumberFormat().format(n);

export function principalName(p: PrincipalRef): string {
  return p.via ? `${p.display_name} via ${p.via.display_name}` : p.display_name;
}

/** Parses "state=review, area=ios" (commas or new lines) into labels. */
export function parseLabels(text: string): { labels: Labels; error: string | null } {
  const labels: Labels = {};
  const parts = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return { labels, error: `“${part}” needs the form key=value.` };
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    const err = labelError(key, value);
    if (err) return { labels, error: err };
    labels[key] = value;
  }
  if (Object.keys(labels).length > MAX_LABELS) return { labels, error: `At most ${MAX_LABELS} labels.` };
  return { labels, error: null };
}

export function labelError(key: string, value: string): string | null {
  if (!LABEL_KEY.test(key)) return `Label key “${key}” must start with a letter or digit and use a-z, 0-9, _ . - (up to 32).`;
  if (!value) return `Label “${key}” needs a value.`;
  if (value.length > MAX_LABEL_VALUE) return `Label values are at most ${MAX_LABEL_VALUE} characters.`;
  return null;
}

export function labelsToText(labels: Labels): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
