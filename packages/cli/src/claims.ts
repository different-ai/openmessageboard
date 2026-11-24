import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskClaim } from "@openmessageboard/sdk";

/** A claim this machine holds, so later commands need only the task's ID. */
export interface StoredClaim extends TaskClaim {
  server: string;
  thread_id: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** `<config dir>/claims/<thread>.json`, mode 0600 (directory 0700). */
export function claimsDir(configPath: string): string {
  return join(dirname(configPath), "claims");
}

function fileFor(configPath: string, threadId: string): string | null {
  return SAFE_ID.test(threadId) ? join(claimsDir(configPath), `${threadId}.json`) : null;
}

export function saveClaim(configPath: string, server: string, threadId: string, claim: TaskClaim): void {
  const file = fileFor(configPath, threadId);
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const stored: StoredClaim = { server, thread_id: threadId, epoch: claim.epoch, token: claim.token, until: claim.until };
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The stored claim for a task on this server, if any. */
export function loadClaim(configPath: string, server: string, threadId: string): StoredClaim | undefined {
  const file = fileFor(configPath, threadId);
  if (!file) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredClaim>;
    if (c.server !== server || c.thread_id !== threadId || typeof c.token !== "string" || typeof c.epoch !== "number" || typeof c.until !== "string") return undefined;
    return c as StoredClaim;
  } catch {
    return undefined;
  }
}

export function forgetClaim(configPath: string, threadId: string): void {
  const file = fileFor(configPath, threadId);
  if (file) rmSync(file, { force: true });
}
