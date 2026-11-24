import { OmbError } from "../errors.js";

export type CloseReason = "removed" | "expired" | "board_deleted" | "disabled" | "shutdown" | "role_changed";

export interface LiveConnection {
  id: number;
  principalId: string;
  kind: "sse" | "listen" | "wait" | "events_push";
  boards: Set<string>;
  close(reason: CloseReason, boardId?: string): void;
}

/** Tracks open live channels so limits can be enforced and access loss can cut them off. */
export class ConnectionRegistry {
  private seq = 0;
  private open = new Map<number, LiveConnection>();

  constructor(private readonly perBoardLimit: (boardId: string) => number, private readonly perPrincipalWaits: (principalId: string) => number) {}

  countForBoard(boardId: string): number {
    let n = 0;
    for (const c of this.open.values()) if (c.boards.has(boardId)) n++;
    return n;
  }

  register(input: Omit<LiveConnection, "id">): LiveConnection {
    for (const b of input.boards) {
      const used = this.countForBoard(b);
      const limit = this.perBoardLimit(b);
      if (used >= limit) {
        throw new OmbError("quota_exceeded", "This board has reached its live connection limit. Changes can still be read with get_changes.", {
          allowance: "live_connections",
          used,
          limit,
          resets_at: null,
        });
      }
    }
    if (input.kind === "wait") {
      let waits = 0;
      for (const c of this.open.values()) if (c.kind === "wait" && c.principalId === input.principalId) waits++;
      if (waits >= this.perPrincipalWaits(input.principalId)) {
        throw new OmbError("rate_limited", "Too many concurrent waits for this principal", { retry_after_ms: 1000 });
      }
    }
    const conn: LiveConnection = { ...input, id: ++this.seq };
    this.open.set(conn.id, conn);
    return conn;
  }

  unregister(conn: LiveConnection): void {
    this.open.delete(conn.id);
  }

  /** Close every channel this principal has on a board (or every channel on the board when principalId is null). */
  closeFor(boardId: string, principalId: string | null, reason: CloseReason): number {
    let n = 0;
    for (const c of [...this.open.values()]) {
      if (!c.boards.has(boardId)) continue;
      if (principalId !== null && c.principalId !== principalId) continue;
      c.close(reason, boardId);
      n++;
    }
    return n;
  }

  /** Principals with at least one open channel (for periodic checks such as disabled accounts). */
  principals(): Set<string> {
    return new Set([...this.open.values()].map((c) => c.principalId));
  }

  closePrincipal(principalId: string, reason: CloseReason): number {
    let n = 0;
    for (const c of [...this.open.values()]) {
      if (c.principalId !== principalId) continue;
      c.close(reason);
      n++;
    }
    return n;
  }

  closeAll(): void {
    for (const c of [...this.open.values()]) c.close("shutdown");
    this.open.clear();
  }

  get size(): number {
    return this.open.size;
  }
}
