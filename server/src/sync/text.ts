import { MAX_TITLE_CHARS, threadUrl } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { refOf } from "../domain/present.js";
import type { MessageRow, ThreadRow } from "../domain/model.js";
import { PLATFORM_LABEL } from "./store.js";

const TRUNCATED = "\n\n… (truncated; open the original for the rest)";

/** Shortens an inbound body to the board's message size limit instead of dropping it. */
export function fitBody(ctx: AppContext, text: string): string {
  const limit = ctx.config.limits.message_bytes;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const room = Math.max(0, limit - Buffer.byteLength(TRUNCATED, "utf8"));
  const cut = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "");
  return cut + TRUNCATED;
}

/** Trims to `max` characters (code points), adding an ellipsis when shortened. */
export function clamp(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

export function titleFrom(text: string, max = MAX_TITLE_CHARS): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return clamp(line || "Untitled", Math.min(max, MAX_TITLE_CHARS));
}

/** "Maya", "release-agent via Maya", or "Ada (Slack)" for a message that arrived from another platform. */
export function authorDisplay(ctx: AppContext, m: MessageRow): string {
  if (m.source_platform && m.source_author_name) {
    const label = PLATFORM_LABEL[m.source_platform as keyof typeof PLATFORM_LABEL] ?? m.source_platform;
    return `${m.source_author_name} (${label})`;
  }
  const ref = refOf(ctx, m.author_id);
  return ref.kind === "agent" && ref.via ? `${ref.display_name} via ${ref.via.display_name}` : ref.display_name;
}

/** What an adapter needs to post one board message elsewhere. */
export interface OutboundMessage {
  id: string;
  author: string;
  body: string;
  threadTitle: string;
  threadUrl: string;
}

export function outboundMessage(ctx: AppContext, m: MessageRow, thread: ThreadRow): OutboundMessage {
  return {
    id: m.id,
    author: authorDisplay(ctx, m),
    body: m.body ?? "",
    threadTitle: thread.title,
    threadUrl: threadUrl(ctx.config.publicUrl, thread.board_id, thread.id),
  };
}

/** Escapes characters that would change how a display name renders in Markdown. */
export const escapeMarkdown = (s: string) => s.replace(/([\\`*_[\]<>#|~])/g, "\\$1");

/** Hidden marker added to GitHub comments and issues so the sync recognizes its own posts. */
export const ombMarker = (messageId: string) => `<!-- omb:${messageId} -->`;
export const OMB_MARKER_PREFIX = "<!-- omb:";
