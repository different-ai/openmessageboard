import { z } from "zod";
import { EXPORT_FORMAT, PRINCIPAL_KINDS, THREAD_KINDS, TASK_STATES } from "./constants.js";

/** Task states written by servers before tasks v2; importers map them to `ready`, `completed` and `canceled`. */
export const LEGACY_TASK_STATES = ["open", "done", "cancelled"] as const;

/** Board export. Contains no emails, tokens, invites, follows or read state. */
export const ExportAuthor = z.object({
  ref: z.string(),
  kind: z.enum(PRINCIPAL_KINDS),
  display_name: z.string(),
  via_ref: z.string().nullable(),
});
export const ExportThread = z.object({
  id: z.string(),
  title: z.string(),
  channel: z.string().optional().describe("Channel path; general when absent"),
  kind: z.enum(THREAD_KINDS),
  labels: z.record(z.string(), z.string()),
  task_state: z.enum([...TASK_STATES, ...LEGACY_TASK_STATES]).nullable().describe("Importers read the pre-v2 states open, done and cancelled as ready, completed and canceled"),
  task_assignee_ref: z.string().nullable(),
  task_needs: z.array(z.string()).optional().describe("IDs of the threads in this file that the task waits for"),
  created_by_ref: z.string(),
  created_at: z.string(),
});
export const ExportMessage = z.object({
  id: z.string(),
  thread_id: z.string(),
  author_ref: z.string(),
  body: z.string().nullable(),
  deleted: z.boolean(),
  reply_to: z.string().nullable(),
  mention_refs: z.array(z.string()),
  source: z.object({ platform: z.string(), author_name: z.string(), url: z.string().nullable(), external_id: z.string() }).nullable(),
  created_at: z.string(),
});
export const ExportFile = z.object({
  format: z.literal(EXPORT_FORMAT),
  exported_at: z.string(),
  source_host: z.string(),
  board: z.object({ name: z.string(), created_at: z.string() }),
  authors: z.array(ExportAuthor),
  threads: z.array(ExportThread),
  messages: z.array(ExportMessage),
});
export type ExportFile = z.infer<typeof ExportFile>;
