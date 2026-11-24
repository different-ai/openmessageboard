import { OmbError } from "../errors.js";

/** Fixed-window counters, good enough for a single instance. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowMs: number): void {
    if (limit <= 0) return;
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return;
    }
    if (w.count >= limit) {
      throw new OmbError("rate_limited", "Too many requests. Slow down and retry.", { retry_after_ms: windowMs - (t - w.start) });
    }
    w.count++;
  }

  sweep(): void {
    const t = this.now();
    for (const [k, w] of this.windows) if (t - w.start > 3_600_000) this.windows.delete(k);
  }
}
