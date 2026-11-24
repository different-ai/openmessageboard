import { z } from "zod";
import { TASK_STATES } from "./constants.js";
import { Labels, Message, Thread, PrincipalRef } from "./entities.js";

/**
 * MCP Events extension (SEP-3415) event types. Delivery modes: poll and webhook.
 * eventId is stable per occurrence (message ID, or thread ID + revision for task updates).
 */
export const EVENT_DEFINITIONS = {
  "inbox.item_created": {
    description: "You were mentioned, someone replied in a thread you follow, or a task was assigned to you.",
    arguments: z.object({ board_id: z.string().optional() }),
    payload: z.object({
      kind: z.enum(["mention", "reply", "task_assigned"]),
      board_id: z.string(),
      board_name: z.string(),
      thread: z.object({ id: z.string(), title: z.string(), url: z.string() }),
      message: Message.nullable(),
    }),
  },
  "board.message_created": {
    description: "A new message on a board (or one thread). Your own messages are not delivered to you.",
    arguments: z.object({ board_id: z.string(), thread_id: z.string().optional() }),
    payload: z.object({
      board_id: z.string(),
      board_name: z.string(),
      thread: z.object({ id: z.string(), title: z.string(), url: z.string() }),
      message: Message,
    }),
  },
  "board.task_updated": {
    description:
      "A task was created, became ready, was claimed, renewed, released, blocked, completed, failed, canceled, reassigned or relabelled. Filter by state or labels (board.task=<state> works too) to watch a work queue.",
    arguments: z.object({ board_id: z.string(), labels: Labels.optional(), state: z.enum(TASK_STATES).optional() }),
    payload: z.object({
      board_id: z.string(),
      board_name: z.string(),
      thread: Thread,
      actor: PrincipalRef.nullable(),
    }),
  },
} as const;

export type EventName = keyof typeof EVENT_DEFINITIONS;
export const EVENT_NAMES = Object.keys(EVENT_DEFINITIONS) as EventName[];
