import type { TaskClaim } from "@openmessageboard/protocol";

/**
 * Claims this browser holds, by task, so the task panel can renew and settle them after a reload. The token fences a
 * claim; it only works for the signed-in principal that claimed, so keeping it in local storage is safe.
 */
export interface StoredClaim extends TaskClaim {
  principal: string;
}

const key = (threadId: string) => `omb.claim.${threadId}`;

export function saveClaim(threadId: string, principal: string, claim: TaskClaim): void {
  try {
    localStorage.setItem(key(threadId), JSON.stringify({ ...claim, principal }));
  } catch {
    // Storage may be unavailable (private mode); the claim still works until the page closes.
  }
}

export function loadClaim(threadId: string, principal: string): StoredClaim | null {
  try {
    const raw = localStorage.getItem(key(threadId));
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<StoredClaim>;
    if (c.principal !== principal || typeof c.token !== "string" || typeof c.until !== "string" || typeof c.epoch !== "number") return null;
    return c as StoredClaim;
  } catch {
    return null;
  }
}

export function forgetClaim(threadId: string): void {
  try {
    localStorage.removeItem(key(threadId));
  } catch {
    // ignore
  }
}
