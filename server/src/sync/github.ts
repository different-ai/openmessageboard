import { z } from "zod";
import type { AppContext } from "../context.js";
import { invalid } from "../errors.js";
import { badSignature, fetchJson, hmacHex, idString, obj, retryAfterMs, safeEqual, str, SyncHttpError } from "./http.js";
import { createInboundThread, ignored, postInboundReply } from "./inbound.js";
import { syncEndpoints, syncOptions } from "./settings.js";
import { cachedIdentity, isOwnOutbound, linkByRef, recordIntegrationActivity, type LoadedIntegration } from "./store.js";
import { OMB_MARKER_PREFIX, clamp, escapeMarkdown, ombMarker, type OutboundMessage } from "./text.js";
import { parseJsonBody, parseWith, type SyncAdapter, type WebhookResult } from "./types.js";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const validRepo = (repo: string) => REPO.test(repo) && !repo.split("/").some((part) => /^\.+$/.test(part));

const GitHubConfig = z.strictObject({
  repo: z.string().trim().refine(validRepo, "must look like owner/name"),
  auto_create_threads: z.boolean().default(false),
});
const GitHubSecrets = z.strictObject({
  token: z.string().trim().min(10, "is required"),
  webhook_secret: z.string().trim().min(8, "must be at least 8 characters"),
});
type GitHubConfig = z.infer<typeof GitHubConfig>;

const HINTS: Record<number, string> = {
  401: "check the token",
  403: "the token needs Issues: read and write on this repository",
  404: "check the repository and issue number, and that the token can see them",
  410: "issues are turned off for this repository",
};

async function gh(token: string, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpenMessageBoard-sync",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetchJson("GitHub", `${syncEndpoints().github}${path}`, { method, headers, body: body === undefined ? null : JSON.stringify(body) }, timeoutMs);
  if (res.status >= 200 && res.status < 300) return obj(res.json);
  const msg = str(obj(res.json).message) ?? `HTTP ${res.status}`;
  if (res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(msg)))) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const wait = retryAfterMs(res.headers) ?? (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined);
    throw new SyncHttpError("GitHub rate limit reached", 429, true, wait);
  }
  throw new SyncHttpError(`GitHub: ${msg}${HINTS[res.status] ? ` (${HINTS[res.status]})` : ""}`, res.status, res.status >= 500);
}

const token = (ig: LoadedIntegration) => ig.secrets.token ?? "";
const config = (ig: LoadedIntegration): GitHubConfig => GitHubConfig.parse(ig.config);

/** The login of the token's user, so its own comments (sent by the sync) are skipped. */
function tokenLogin(ig: LoadedIntegration): Promise<string | null> {
  return cachedIdentity(`${ig.row.id}:github:login`, async () => {
    const r = await gh(token(ig), "GET", "/user", undefined, syncOptions().lookupTimeoutMs);
    const login = str(r.login);
    if (!login) throw new Error("no login");
    return login.toLowerCase();
  });
}

/** Accepts `owner/repo#123`, `#123` or `123` (the configured repository), or an issue or pull request URL. */
export function parseGitHubRef(ref: string, defaultRepo: string): { repo: string; number: number } | null {
  const t = ref.trim();
  const full = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\/(?:issues|pull)\/)(\d+)(?:[/?#].*)?$/.exec(t);
  if (full && validRepo(full[1]!)) return { repo: full[1]!, number: Number(full[2]) };
  const short = /^#?(\d+)$/.exec(t);
  if (short) return { repo: defaultRepo, number: Number(short[1]) };
  return null;
}

const refOf = (repo: string, n: number | string) => `${repo.toLowerCase()}#${n}`;

function githubBody(m: OutboundMessage): string {
  return `**${escapeMarkdown(m.author)}** on [OpenMessageBoard](${m.threadUrl}):\n\n${m.body}\n\n${ombMarker(m.id)}`;
}

async function onComment(
  ctx: AppContext,
  ig: LoadedIntegration,
  repoFullName: string | undefined,
  number: unknown,
  comment: Record<string, unknown>,
  prefix = "",
): Promise<WebhookResult> {
  const id = idString(comment.id);
  const body = str(comment.body) ?? "";
  const login = str(obj(comment.user).login);
  if (!repoFullName || typeof number !== "number" || !id || !login) return ignored("incomplete");
  const link = linkByRef(ctx, ig.row.id, refOf(repoFullName, number));
  if (!link) return ignored("issue_not_linked");
  if (body.includes(OMB_MARKER_PREFIX) || isOwnOutbound(ctx, ig.row.id, id)) return ignored("own_comment");
  const own = await tokenLogin(ig);
  if (own && login.toLowerCase() === own) return ignored("own_comment");
  return postInboundReply(ctx, ig, link, {
    body: prefix + body,
    source: { platform: "github", author_name: login, url: str(comment.html_url) ?? null, external_id: id },
  });
}

export const github: SyncAdapter = {
  platform: "github",

  parseSetup(cfg, secrets) {
    return { config: parseWith(GitHubConfig, cfg, "config"), secrets: parseWith(GitHubSecrets, secrets, "secrets") };
  },

  async resolveRef(_ctx, ig, ref) {
    const p = parseGitHubRef(ref, config(ig).repo);
    if (!p) throw invalid("Link a GitHub issue or pull request as owner/repo#123, #123, or its URL");
    const r = await gh(token(ig), "GET", `/repos/${p.repo}/issues/${p.number}`, undefined, syncOptions().requestTimeoutMs);
    return { externalRef: refOf(p.repo, p.number), url: str(r.html_url) ?? null, externalId: null };
  },

  async createCounterpart(_ctx, ig, root) {
    const repo = config(ig).repo;
    const r = await gh(token(ig), "POST", `/repos/${repo}/issues`, { title: clamp(root.threadTitle, 256), body: githubBody(root) }, syncOptions().requestTimeoutMs);
    const number = idString(r.number);
    if (!number) throw new SyncHttpError("GitHub didn't return an issue number", 201, false);
    const issueId = idString(r.id);
    return { externalRef: refOf(repo, number), url: str(r.html_url) ?? null, externalId: null, rootExternalId: issueId ? `issue:${issueId}` : null };
  },

  async send(_ctx, ig, link, message) {
    const m = /^(.+)#(\d+)$/.exec(link.external_ref);
    if (!m || !validRepo(m[1]!)) throw new SyncHttpError(`Stored GitHub reference ${link.external_ref} is not valid`, null, false);
    const r = await gh(token(ig), "POST", `/repos/${m[1]}/issues/${m[2]}/comments`, { body: githubBody(message) }, syncOptions().requestTimeoutMs);
    const id = idString(r.id);
    if (!id) throw new SyncHttpError("GitHub didn't return a comment ID", 201, false);
    return { externalId: id };
  },

  async handleWebhook(ctx, ig, req) {
    const sig = req.headers.get("x-hub-signature-256");
    const secret = ig.secrets.webhook_secret;
    if (!sig || !secret || !safeEqual(`sha256=${hmacHex(secret, req.raw)}`, sig)) throw badSignature();
    const event = req.headers.get("x-github-event");
    const payload = parseJsonBody(req.raw);
    if (event === "ping") return { status: 200, body: { ok: true } };
    recordIntegrationActivity(ctx, ig.row.id);
    const repoFullName = str(obj(payload.repository).full_name);

    if (event === "issue_comment" && payload.action === "created") {
      return onComment(ctx, ig, repoFullName, obj(payload.issue).number, obj(payload.comment));
    }
    if (event === "pull_request_review_comment" && payload.action === "created") {
      const comment = obj(payload.comment);
      const path = str(comment.path);
      return onComment(ctx, ig, repoFullName, obj(payload.pull_request).number, comment, path ? `Review comment on \`${path}\`:\n\n` : "");
    }
    if (event === "issues" && payload.action === "opened") {
      const cfg = config(ig);
      if (!cfg.auto_create_threads) return ignored("auto_create_off");
      if (!repoFullName || repoFullName.toLowerCase() !== cfg.repo.toLowerCase()) return ignored("other_repository");
      const issue = obj(payload.issue);
      const number = idString(issue.number);
      const issueId = idString(issue.id);
      const login = str(obj(issue.user).login);
      const body = str(issue.body) ?? "";
      if (!number || !issueId || !login) return ignored("incomplete");
      if (body.includes(OMB_MARKER_PREFIX)) return ignored("own_issue");
      const own = await tokenLogin(ig);
      if (own && login.toLowerCase() === own) return ignored("own_issue");
      const url = str(issue.html_url) ?? null;
      return createInboundThread(ctx, ig, {
        title: str(issue.title) ?? `Issue #${number}`,
        body: body.trim() ? body : "_No description._",
        source: { platform: "github", author_name: login, url, external_id: `issue:${issueId}` },
        externalRef: refOf(repoFullName, number),
        externalId: null,
        url,
      });
    }
    return ignored("event");
  },
};
