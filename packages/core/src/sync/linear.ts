import { z } from "zod";
import { ChannelPath } from "@openmessageboard/protocol";
import { OmbError, invalid } from "../errors.js";
import { badSignature, fetchJson, hmacHex, idString, obj, retryAfterMs, safeEqual, str, SyncHttpError } from "./http.js";
import { createInboundThread, ignored, postInboundReply } from "./inbound.js";
import { syncEndpoints, syncOptions } from "./settings.js";
import { cachedIdentity, isOwnOutbound, linkByExternalId, linkByRef, recordIntegrationActivity, type LoadedIntegration } from "./store.js";
import { clamp, escapeMarkdown, type OutboundMessage } from "./text.js";
import { parseJsonBody, parseWith, type SyncAdapter } from "./types.js";

const LinearConfig = z.strictObject({
  team_key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, "must be a team key such as ENG"),
  auto_create_threads: z.boolean().default(false),
  /** Board channel for threads this integration creates. Default general. */
  channel: ChannelPath.optional(),
});
const LinearSecrets = z.strictObject({
  api_key: z.string().trim().min(10, "is required"),
  webhook_secret: z.string().trim().min(8, "is required"),
});
type LinearConfig = z.infer<typeof LinearConfig>;

/** Linear asks receivers to reject deliveries whose webhookTimestamp is more than a minute old. */
const TIMESTAMP_WINDOW_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function gql(apiKey: string, query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetchJson(
    "Linear",
    syncEndpoints().linear,
    { method: "POST", headers: { Authorization: apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) },
    timeoutMs,
  );
  const json = obj(res.json);
  const errors = Array.isArray(json.errors) ? json.errors.map(obj) : [];
  if (res.status === 429 || errors.some((e) => obj(e.extensions).code === "RATELIMITED")) {
    throw new SyncHttpError("Linear rate limit reached", 429, true, retryAfterMs(res.headers));
  }
  if (res.status >= 500) throw new SyncHttpError(`Linear returned HTTP ${res.status}`, res.status, true);
  if (res.status === 401 || res.status === 403) throw new SyncHttpError("Linear rejected the API key", res.status, false);
  if (errors.length) throw new SyncHttpError(`Linear: ${str(errors[0]!.message) ?? "request failed"}`, res.status, false);
  if (res.status !== 200) throw new SyncHttpError(`Linear returned HTTP ${res.status}`, res.status, false);
  return obj(json.data);
}

const apiKey = (ig: LoadedIntegration) => ig.secrets.api_key ?? "";
const config = (ig: LoadedIntegration): LinearConfig => LinearConfig.parse(ig.config);

/** The API key's user. Comments and issues it creates are the sync's own and are not imported. */
function viewerId(ig: LoadedIntegration): Promise<string | null> {
  return cachedIdentity(`${ig.row.id}:linear:viewer`, async () => {
    const data = await gql(apiKey(ig), "query { viewer { id } }", {}, syncOptions().lookupTimeoutMs);
    const id = str(obj(data.viewer).id);
    if (!id) throw new Error("no viewer");
    return id;
  });
}

/** Accepts an identifier (`ENG-123`), an issue UUID, or an issue URL. */
export function parseLinearRef(ref: string): string | null {
  const t = ref.trim();
  if (UUID.test(t)) return t.toLowerCase();
  const url = /linear\.app\/[^/]+\/issue\/([A-Za-z0-9]+-\d+)/i.exec(t);
  if (url) return url[1]!.toUpperCase();
  if (/^[A-Za-z0-9]{1,10}-\d+$/.test(t)) return t.toUpperCase();
  return null;
}

function linearBody(m: OutboundMessage): string {
  return `**${escapeMarkdown(m.author)}** on [OpenMessageBoard](${m.threadUrl}):\n\n${m.body}`;
}

export const linear: SyncAdapter = {
  platform: "linear",

  parseSetup(cfg, secrets) {
    return { config: parseWith(LinearConfig, cfg, "config"), secrets: parseWith(LinearSecrets, secrets, "secrets") };
  },

  async resolveRef(_ctx, ig, ref) {
    const id = parseLinearRef(ref);
    if (!id) throw invalid("Link a Linear issue by its identifier (e.g. ENG-123), ID, or URL");
    const data = await gql(apiKey(ig), "query($id: String!) { issue(id: $id) { id identifier url } }", { id }, syncOptions().requestTimeoutMs);
    const issue = obj(data.issue);
    const issueId = str(issue.id);
    const identifier = str(issue.identifier);
    if (!issueId || !identifier) throw invalid(`Linear has no issue ${id} that this API key can see`);
    return { externalRef: identifier, url: str(issue.url) ?? null, externalId: issueId };
  },

  async createCounterpart(_ctx, ig, root) {
    const cfg = config(ig);
    const timeout = syncOptions().requestTimeoutMs;
    const teams = await gql(apiKey(ig), "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }", { key: cfg.team_key }, timeout);
    const nodes = obj(teams.teams).nodes;
    const teamId = Array.isArray(nodes) ? str(obj(nodes[0]).id) : undefined;
    if (!teamId) throw new OmbError("invalid_argument", `Linear has no team with key ${cfg.team_key} that this API key can see`);
    const data = await gql(
      apiKey(ig),
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input: { teamId, title: clamp(root.threadTitle, 255), description: linearBody(root) } },
      timeout,
    );
    const issue = obj(obj(data.issueCreate).issue);
    const issueId = str(issue.id);
    const identifier = str(issue.identifier);
    if (!issueId || !identifier) throw new SyncHttpError("Linear didn't return the new issue", 200, false);
    return { externalRef: identifier, url: str(issue.url) ?? null, externalId: issueId, rootExternalId: `issue:${issueId}` };
  },

  async send(_ctx, ig, link, message) {
    const data = await gql(
      apiKey(ig),
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      { input: { issueId: link.external_id ?? link.external_ref, body: linearBody(message) } },
      syncOptions().requestTimeoutMs,
    );
    const id = str(obj(obj(data.commentCreate).comment).id);
    if (!id) throw new SyncHttpError("Linear didn't return a comment ID", 200, false);
    return { externalId: id };
  },

  async handleWebhook(ctx, ig, req) {
    const sig = req.headers.get("linear-signature");
    const secret = ig.secrets.webhook_secret;
    if (!sig || !secret || !safeEqual(hmacHex(secret, req.raw), sig.trim().toLowerCase())) throw badSignature();
    const payload = parseJsonBody(req.raw);
    const sentAt = payload.webhookTimestamp;
    if (typeof sentAt !== "number" || Math.abs(ctx.now().getTime() - sentAt) > TIMESTAMP_WINDOW_MS) {
      throw new OmbError("unauthenticated", "Webhook timestamp is outside the allowed window");
    }
    recordIntegrationActivity(ctx, ig.row.id);
    const data = obj(payload.data);
    const actor = obj(payload.actor);
    const url = str(payload.url) ?? str(data.url) ?? null;

    if (payload.type === "Comment" && payload.action === "create") {
      const id = idString(data.id);
      const issueId = str(data.issueId) ?? str(obj(data.issue).id);
      const body = str(data.body) ?? "";
      if (!id || !issueId) return ignored("not_an_issue_comment");
      const identifier = str(obj(data.issue).identifier);
      const link = linkByExternalId(ctx, ig.row.id, issueId) ?? (identifier ? linkByRef(ctx, ig.row.id, identifier) : undefined);
      if (!link) return ignored("issue_not_linked");
      if (isOwnOutbound(ctx, ig.row.id, id)) return ignored("own_comment");
      const viewer = await viewerId(ig);
      if (viewer && (str(data.userId) === viewer || str(actor.id) === viewer)) return ignored("own_comment");
      const author = str(actor.name) ?? str(obj(data.user).name) ?? "Linear user";
      return postInboundReply(ctx, ig, link, { body, source: { platform: "linear", author_name: author, url, external_id: id } });
    }

    if (payload.type === "Issue" && payload.action === "create") {
      const cfg = config(ig);
      if (!cfg.auto_create_threads) return ignored("auto_create_off");
      const issueId = str(data.id);
      const identifier = str(data.identifier);
      if (!issueId || !identifier) return ignored("incomplete");
      const teamKey = (str(obj(data.team).key) ?? identifier.split("-")[0] ?? "").toUpperCase();
      if (teamKey !== cfg.team_key) return ignored("other_team");
      const viewer = await viewerId(ig);
      if (viewer && (str(data.creatorId) === viewer || str(actor.id) === viewer)) return ignored("own_issue");
      const description = str(data.description) ?? "";
      return createInboundThread(ctx, ig, {
        title: str(data.title) ?? identifier,
        body: description.trim() ? description : "_No description._",
        source: { platform: "linear", author_name: str(actor.name) ?? str(obj(data.creator).name) ?? "Linear user", url, external_id: `issue:${issueId}` },
        externalRef: identifier,
        externalId: issueId,
        url,
      });
    }
    return ignored("event");
  },
};
