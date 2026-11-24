import { z } from "zod";
import { ChannelPath } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import { badSignature, fetchJson, hmacHex, obj, retryAfterMs, safeEqual, str, SyncHttpError } from "./http.js";
import { createInboundThread, ignored, postInboundReply } from "./inbound.js";
import { syncEndpoints, syncOptions } from "./settings.js";
import { cachedIdentity, isOwnOutbound, linkByRef, recordIntegrationActivity, type LoadedIntegration } from "./store.js";
import { titleFrom, type OutboundMessage } from "./text.js";
import { parseJsonBody, parseWith, type SyncAdapter } from "./types.js";

const SlackConfig = z.strictObject({
  channel_id: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[CG][A-Z0-9]{4,}$/, "must be a Slack channel ID such as C0123456789"),
  auto_create_threads: z.boolean().default(true),
  /** Board channel for threads this integration creates. Default general. */
  channel: ChannelPath.optional(),
});
const SlackSecrets = z.strictObject({
  bot_token: z.string().trim().regex(/^xox[a-z]-/, "must be the app's bot token (starts with xoxb-)"),
  signing_secret: z.string().trim().min(8, "is required (Basic Information → App Credentials)"),
});
type SlackConfig = z.infer<typeof SlackConfig>;

const SIGNATURE_WINDOW_S = 5 * 60;
/** Message subtypes that carry a person's new message; edits, deletes, joins and bot posts are ignored. */
const ACCEPTED_SUBTYPES = new Set(["thread_broadcast", "file_share"]);
const RETRYABLE = new Set(["ratelimited", "service_unavailable", "internal_error", "fatal_error", "request_timeout"]);
const HINTS: Record<string, string> = {
  not_in_channel: "invite the app to the channel",
  channel_not_found: "check the channel ID and invite the app to the channel",
  invalid_auth: "check the bot token",
  token_revoked: "the bot token was revoked",
  account_inactive: "the app was uninstalled",
  missing_scope: "add the chat:write, channels:history and users:read scopes and reinstall the app",
  message_not_found: "check the channel and message timestamp",
  thread_not_found: "check the channel and message timestamp",
};

async function slackCall(token: string, method: string, params: Record<string, string | undefined>, timeoutMs: number): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  const res = await fetchJson(
    "Slack",
    `${syncEndpoints().slack}/${method}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body },
    timeoutMs,
  );
  if (res.status === 429) throw new SyncHttpError("Slack is rate limiting requests", 429, true, retryAfterMs(res.headers));
  if (res.status >= 500) throw new SyncHttpError(`Slack returned HTTP ${res.status}`, res.status, true);
  const json = obj(res.json);
  if (res.status !== 200 || json.ok !== true) {
    const code = str(json.error) ?? `HTTP ${res.status}`;
    throw new SyncHttpError(`Slack: ${code}${HINTS[code] ? ` (${HINTS[code]})` : ""}`, res.status, RETRYABLE.has(code));
  }
  return json;
}

const token = (ig: LoadedIntegration) => ig.secrets.bot_token ?? "";
const config = (ig: LoadedIntegration): SlackConfig => SlackConfig.parse(ig.config);

interface SlackIdentity {
  url: string | null;
  userId: string | null;
  botId: string | null;
}

/** The bot's own user/bot IDs and the workspace URL (for permalinks), from `auth.test`. */
function slackIdentity(ig: LoadedIntegration): Promise<SlackIdentity | null> {
  return cachedIdentity(`${ig.row.id}:slack:auth`, async () => {
    const r = await slackCall(token(ig), "auth.test", {}, syncOptions().lookupTimeoutMs);
    return { url: str(r.url) ?? null, userId: str(r.user_id) ?? null, botId: str(r.bot_id) ?? null };
  });
}

/** A person's display name from `users.info`, cached; falls back to the user ID. */
async function slackUserName(ig: LoadedIntegration, userId: string): Promise<string> {
  const name = await cachedIdentity(`${ig.row.id}:slack:user:${userId}`, async () => {
    const r = await slackCall(token(ig), "users.info", { user: userId }, syncOptions().lookupTimeoutMs);
    const u = obj(r.user);
    const p = obj(u.profile);
    return str(p.display_name)?.trim() || str(p.real_name)?.trim() || str(u.real_name)?.trim() || str(u.name) || userId;
  });
  return name ?? userId;
}

function permalink(identity: SlackIdentity | null, channel: string, ts: string, threadTs?: string): string | null {
  if (!identity?.url) return null;
  const base = `${identity.url.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/** Accepts `C0123/1700000000.000100` or a Slack message link (a reply link resolves to its thread). */
export function parseSlackRef(ref: string): { channel: string; ts: string } | null {
  const t = ref.trim();
  const plain = /^([CG][A-Z0-9]+)\/(\d+\.\d+)$/i.exec(t);
  if (plain) return { channel: plain[1]!.toUpperCase(), ts: plain[2]! };
  const link = /\/archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/i.exec(t);
  if (link) {
    const threadTs = new URLSearchParams(link[4] ?? "").get("thread_ts");
    return { channel: link[1]!.toUpperCase(), ts: threadTs && /^\d+\.\d+$/.test(threadTs) ? threadTs : `${link[2]}.${link[3]}` };
  }
  return null;
}

// ---------- text conversion ----------

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Minimal Markdown → Slack mrkdwn: bold, italics, strikethrough, links, headings; code is left alone. */
export function markdownToSlack(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((block, i) =>
      i % 2 === 1
        ? slackEscape(block)
        : block
            .split(/(`[^`\n]+`)/g)
            .map((seg, j) => {
              if (j % 2 === 1) return slackEscape(seg);
              let s = slackEscape(seg).replace(/^&gt; ?/gm, "> ");
              s = s.replace(/!?\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => `<${url}|${text}>`);
              s = s.replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "\u0001$1\u0001");
              s = s.replace(/\*\*(.+?)\*\*/g, "\u0001$1\u0001").replace(/__(.+?)__/g, "\u0001$1\u0001");
              s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
              s = s.replace(/~~(.+?)~~/g, "~$1~");
              return s.replace(/\u0001/g, "*");
            })
            .join(""),
    )
    .join("");
}

/** Slack mrkdwn → Markdown: mentions, channel references, links and HTML entities. */
async function slackToMarkdown(ig: LoadedIntegration, text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))].slice(0, 5);
  const names = new Map(await Promise.all(ids.map(async (id) => [id, await slackUserName(ig, id)] as const)));
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#([CG][A-Z0-9]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function authorLine(m: OutboundMessage): string {
  return m.body.trim() ? `*${slackEscape(m.author)}*: ${markdownToSlack(m.body)}` : `*${slackEscape(m.author)}*`;
}

// ---------- webhook ----------

function verify(ctx: AppContext, ig: LoadedIntegration, headers: Headers, raw: Buffer): void {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  const secret = ig.secrets.signing_secret;
  if (!ts || !sig || !secret || !/^\d{1,12}$/.test(ts)) throw badSignature();
  if (Math.abs(Math.floor(ctx.now().getTime() / 1000) - Number(ts)) > SIGNATURE_WINDOW_S) {
    throw new OmbError("unauthenticated", "Webhook timestamp is outside the allowed window");
  }
  if (!safeEqual(`v0=${hmacHex(secret, `v0:${ts}:`, raw)}`, sig)) throw badSignature();
}

export const slack: SyncAdapter = {
  platform: "slack",

  parseSetup(cfg, secrets) {
    return { config: parseWith(SlackConfig, cfg, "config"), secrets: parseWith(SlackSecrets, secrets, "secrets") };
  },

  async resolveRef(_ctx, ig, ref) {
    const p = parseSlackRef(ref);
    if (!p) throw invalid("Link a Slack thread as <channel ID>/<message ts>, e.g. C0123456789/1700000000.000100, or paste a message link");
    const r = await slackCall(token(ig), "chat.getPermalink", { channel: p.channel, message_ts: p.ts }, syncOptions().requestTimeoutMs);
    return { externalRef: `${p.channel}/${p.ts}`, url: str(r.permalink) ?? null, externalId: null };
  },

  async createCounterpart(_ctx, ig, root) {
    const cfg = config(ig);
    const text = `*${slackEscape(root.threadTitle)}*\n${authorLine(root)}\n<${root.threadUrl}|Open on OpenMessageBoard>`;
    const r = await slackCall(token(ig), "chat.postMessage", { channel: cfg.channel_id, text, unfurl_links: "false", unfurl_media: "false" }, syncOptions().requestTimeoutMs);
    const ts = str(r.ts);
    if (!ts) throw new SyncHttpError("Slack didn't return a message timestamp", 200, false);
    const channel = str(r.channel) ?? cfg.channel_id;
    let url: string | null = null;
    try {
      url = str((await slackCall(token(ig), "chat.getPermalink", { channel, message_ts: ts }, syncOptions().lookupTimeoutMs)).permalink) ?? null;
    } catch {
      url = permalink(await slackIdentity(ig), channel, ts);
    }
    return { externalRef: `${channel}/${ts}`, url, externalId: null, rootExternalId: ts };
  },

  async send(_ctx, ig, link, message) {
    const p = parseSlackRef(link.external_ref);
    if (!p) throw new SyncHttpError(`Stored Slack reference ${link.external_ref} is not valid`, null, false);
    const r = await slackCall(
      token(ig),
      "chat.postMessage",
      { channel: p.channel, thread_ts: p.ts, text: authorLine(message), unfurl_links: "false", unfurl_media: "false" },
      syncOptions().requestTimeoutMs,
    );
    const ts = str(r.ts);
    if (!ts) throw new SyncHttpError("Slack didn't return a message timestamp", 200, false);
    return { externalId: ts };
  },

  async handleWebhook(ctx, ig, req) {
    verify(ctx, ig, req.headers, req.raw);
    const payload = parseJsonBody(req.raw);
    if (payload.type === "url_verification") return { status: 200, body: { challenge: str(payload.challenge) ?? "" } };
    if (payload.type !== "event_callback") return ignored("not_an_event");
    const ev = obj(payload.event);
    if (ev.type !== "message") return ignored("not_a_message");
    recordIntegrationActivity(ctx, ig.row.id);

    const subtype = str(ev.subtype);
    if (subtype && !ACCEPTED_SUBTYPES.has(subtype)) return ignored("subtype");
    if (ev.bot_id || ev.app_id || ev.bot_profile) return ignored("bot");
    const user = str(ev.user);
    const ts = str(ev.ts);
    const channel = str(ev.channel);
    const text = str(ev.text) ?? "";
    if (!user || !ts || !channel) return ignored("incomplete");
    if (isOwnOutbound(ctx, ig.row.id, ts)) return ignored("own_message");

    const threadTs = str(ev.thread_ts);
    const isReply = !!threadTs && threadTs !== ts;
    const cfg = config(ig);
    const link = isReply ? linkByRef(ctx, ig.row.id, `${channel}/${threadTs}`) : undefined;
    if (isReply && !link) return ignored("thread_not_linked");
    if (!isReply && (channel !== cfg.channel_id || !cfg.auto_create_threads)) return ignored("not_synced");

    const [identity, authorName, body] = await Promise.all([slackIdentity(ig), slackUserName(ig, user), slackToMarkdown(ig, text)]);
    if (identity?.userId && identity.userId === user) return ignored("own_message");
    const source = { platform: "slack" as const, author_name: authorName, url: permalink(identity, channel, ts, threadTs), external_id: ts };
    if (link) return postInboundReply(ctx, ig, link, { body, source });
    return createInboundThread(ctx, ig, { title: titleFrom(body, 80), body, source, externalRef: `${channel}/${ts}`, externalId: null, url: source.url });
  },
};
