import type { EventType, InboxKind } from "@openmessageboard/protocol";

/** Post-commit notifications. Listeners must not throw; data is always re-read from the database. */
export type HubEvent =
  | {
      kind: "board";
      boardId: string;
      seq: number;
      type: EventType;
      threadId: string | null;
      messageId: string | null;
      actorId: string | null;
      subjectId: string | null;
    }
  | { kind: "inbox"; principalId: string; seq: number; itemId: string; itemKind: InboxKind; boardId: string; threadId: string; messageId: string | null }
  | { kind: "access"; boardId: string; principalId: string; reason: "removed" | "expired" | "role_changed" | "disabled" }
  | { kind: "board_deleted"; boardId: string };

export type HubListener = (event: HubEvent) => void;

export class Hub {
  private listeners = new Set<HubListener>();
  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(event: HubEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (e) {
        console.error("hub listener failed", e);
      }
    }
  }
  get size(): number {
    return this.listeners.size;
  }
}
