import { randomUUID } from "node:crypto";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const newKey = (prefix = "omb-conf") => `${prefix}-${randomUUID()}`;

/** Polls `fn` until it returns a truthy value or `timeoutMs` elapses. */
export async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, intervalMs = 200): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() >= deadline) return undefined;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Resolves with the value, or with `fallback` after `ms`. */
export async function within<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Splits a stream of Server-Sent Events text into parsed `data` payloads. */
export function parseSse(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (data.length) out.push(data.join("\n"));
  }
  return out;
}
