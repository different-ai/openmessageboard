import type { SyncPlatform } from "@openmessageboard/protocol";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import type { LinkRow, LoadedIntegration } from "./store.js";
import type { OutboundMessage } from "./text.js";

/** An existing Slack thread, GitHub issue/PR or Linear issue that a board thread can link to. */
export interface ResolvedRef {
  externalRef: string;
  url: string | null;
  /** Platform-native ID used to match webhooks (Linear issue UUID). */
  externalId: string | null;
}

export interface CreatedCounterpart extends ResolvedRef {
  /** ID of the post that carried the thread's first message, recorded so it is never sent again or echoed back. */
  rootExternalId: string | null;
}

export interface WebhookRequest {
  headers: Headers;
  /** Exact bytes received; signatures are checked over these before any parsing. */
  raw: Buffer;
}

export interface WebhookResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SyncAdapter {
  platform: SyncPlatform;
  /** Validates and normalizes config and secrets. Throws `invalid_argument` with field-level messages. */
  parseSetup(config: Record<string, unknown>, secrets: Record<string, string>): { config: Record<string, unknown>; secrets: Record<string, string> };
  /** Checks that an owner-supplied reference exists and normalizes it. */
  resolveRef(ctx: AppContext, ig: LoadedIntegration, ref: string): Promise<ResolvedRef>;
  /** Creates a new Slack thread, GitHub issue or Linear issue from the board thread's first message. */
  createCounterpart(ctx: AppContext, ig: LoadedIntegration, root: OutboundMessage): Promise<CreatedCounterpart>;
  /** Posts one board message to the linked external thread and returns its external ID. */
  send(ctx: AppContext, ig: LoadedIntegration, link: LinkRow, message: OutboundMessage): Promise<{ externalId: string }>;
  /** Verifies and handles one webhook delivery. */
  handleWebhook(ctx: AppContext, ig: LoadedIntegration, req: WebhookRequest): Promise<WebhookResult>;
}

export function parseWith<S extends z.ZodType>(schema: S, value: unknown, prefix: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw invalid(r.error.issues.map((i) => `${[prefix, ...i.path.map(String)].join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

/** Parses a webhook body after its signature has been verified. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    throw invalid("Webhook body must be JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid("Webhook body must be a JSON object");
  return v as Record<string, unknown>;
}
