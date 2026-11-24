import { z } from "zod";
import { EXPORT_FORMAT, PRINCIPAL_KINDS, THREAD_KINDS, TASK_STATES } from "./constants.js";

/** Board export. Contains no emails, tokens, invites, follows, read state, reactions or attachment contents. */
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
  task_state: z.enum(TASK_STATES).nullable(),
  task_assignee_ref: z.string().nullable(),
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
  edited_at: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  blocks: z.array(z.object({ schema: z.string(), version: z.number().int(), data: z.record(z.string(), z.unknown()) })).optional(),
  attachments: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string(), size: z.number().int() }))
    .optional()
    .describe("Metadata only; files are not part of the export"),
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
