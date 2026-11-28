import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TOOL_NAMES } from "@openmessageboard/protocol";
import { OmbClient, OmbError, TOOL_METHODS, approvalQuestion, discoverServer, envToken, githubActionsOidc, normalizeServer, vercelOidc } from "../src/index.ts";
import { FakeServer, OMAR, ToolError } from "./fake-server.ts";

describe("OmbClient against the fake server", () => {
  let fake: FakeServer;
  let client: OmbClient;
  before(async () => {
    fake = await new FakeServer().start();
    client = new OmbClient({ server: fake.url, token: "good-token" });
  });
  after(async () => {
    await client.close();
    await fake.stop();
  });

  it("negotiates 2026-07-28, sends the bearer token and parses structured results", async () => {
    const res = await client.whoami();
    assert.equal(res.principal.display_name, "Maya");
    assert.equal(await client.protocolEra(), "modern");
    assert.equal(fake.calls.at(-1)?.auth, "Bearer good-token");
    assert.ok(fake.rpcMethods.includes("server/discover"));
  });

  it("as(profile) sends the OMB-Profile header on its own connection; the original client does not", async () => {
    const fx = client.as("fixer-1");
    assert.equal(fx.profile, "fixer-1");
    await fx.whoami();
    assert.equal(fake.calls.at(-1)?.profile, "fixer-1");
    assert.equal(fake.calls.at(-1)?.auth, "Bearer good-token");
    await client.whoami();
    assert.equal(fake.calls.at(-1)?.profile, undefined);
    assert.equal(fx.as(null).profile, null);
    await fx.close();
    assert.throws(() => client.as("1-bad name"), (e: unknown) => e instanceof OmbError && e.code === "invalid_argument");
  });

  it("createScopedToken and listActors call their tools", async () => {
    fake.tools.create_scoped_token = (args) => ({
      id: "tok_1",
      token: "omb_pt_secret",
      prefix: "omb_pt_secre",
      scope: { boards: args.boards ?? null, can: args.can ?? ["read", "post", "react", "label"], profile: null, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    fake.tools.list_actors = () => ({ actors: [{ id: "p_maya", kind: "human", handle: "maya", display_name: "Maya", via: null, is_member: true }] });
    const t = await client.createScopedToken({ boards: ["b_main"], can: ["read"] });
    assert.deepEqual(t.scope.can, ["read"]);
    assert.deepEqual(fake.calls.at(-1)?.args, { boards: ["b_main"], can: ["read"] });
    const { actors } = await client.listActors({ board_id: "b_main" });
    assert.equal(actors[0]?.handle, "maya");
  });

  it("maps tool errors to OmbError with code and details", async () => {
    fake.tools.claim_task = () => {
      throw new ToolError("task_already_claimed", "Someone else holds this task", { assignee: "p_omar" });
    };
    await assert.rejects(client.claimTask({ thread_id: "t_x" }), (err: unknown) => {
      assert.ok(err instanceof OmbError);
      assert.equal(err.code, "task_already_claimed");
      assert.equal(err.message, "Someone else holds this task");
      assert.deepEqual(err.details, { assignee: "p_omar" });
      return true;
    });
  });

  it("approval_required carries the question for the person, and approved: true goes out as given", async () => {
    const ask = "Save the board https://board.example.com/b/b_pub for you, so that your agents and profiles may read its public channels?";
    fake.tools.unsave_board = (args) => {
      if (args.approved !== true) throw new ToolError("approval_required", `Ask the person you act for: ${ask}`, { ask, retry_with: { approved: true } });
      return { board_id: args.board_id, saved: false };
    };
    // unsave_board stands in for a tool that asks: its output is simple, and the client sends any tool's input as given.
    const err = await client.call("unsave_board", { board_id: "b_pub" }).catch((e: unknown) => e);
    assert.equal(approvalQuestion(err), ask);
    assert.equal(approvalQuestion(new OmbError("forbidden", "no")), null);
    assert.equal(approvalQuestion(new Error("no")), null);
    await client.saveBoard({ board_id: "b_pub", approved: true }).catch(() => undefined);
    assert.deepEqual(fake.calls.at(-1), { ...fake.calls.at(-1)!, name: "save_board", args: { board_id: "b_pub", approved: true } });
  });

  it("keeps unknown error codes from newer servers", async () => {
    fake.tools.get_usage = () => {
      throw new ToolError("future_code", "Something new");
    };
    await assert.rejects(client.getUsage({ board_id: "b_main" }), (err: unknown) => err instanceof OmbError && (err.code as string) === "future_code");
  });

  it("rejects results that do not match the output schema", async () => {
    fake.tools.list_members = () => ({ members: [{ nope: true }] });
    await assert.rejects(client.listMembers({ board_id: "b_main" }), (err: unknown) => err instanceof OmbError && err.code === "invalid_response");
  });

  it("maps HTTP 401 to unauthenticated", async () => {
    const bad = new OmbClient({ server: fake.url, token: "bad-token" });
    try {
      // The probe is accepted; the 401 comes on the tool call.
      await assert.rejects(bad.whoami(), (err: unknown) => err instanceof OmbError && err.code === "unauthenticated");
    } finally {
      await bad.close();
    }
  });

  it("postIdempotent retries a lost response once with the same key", async () => {
    let attempts = 0;
    const original = fake.tools.start_thread!;
    fake.tools.start_thread = async (args, ctx) => {
      attempts++;
      const result = await original(args, ctx);
      if (attempts === 1) ctx.dropResponse();
      return result;
    };
    const before = fake.threads.size;
    const res = await client.postIdempotent({ board_id: fake.boardId, title: "Release 1.4", body: "Ship it?" });
    const keys = fake.calls.filter((c) => c.name === "start_thread").map((c) => c.args.idempotency_key);
    assert.equal(attempts, 2);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
    assert.equal(typeof keys[0], "string");
    assert.equal(fake.threads.size, before + 1, "exactly one thread was created");
    assert.equal(res.thread.title, "Release 1.4");
    fake.tools.start_thread = original;
  });

  it("postIdempotent does not retry tool errors", async () => {
    let attempts = 0;
    fake.tools.reply = () => {
      attempts++;
      throw new ToolError("forbidden", "Readers cannot post");
    };
    await assert.rejects(client.postIdempotent({ thread_id: "t_1", body: "hi" }), (err: unknown) => err instanceof OmbError && err.code === "forbidden");
    assert.equal(attempts, 1);
    delete fake.tools.reply;
  });

  it("claimNext returns null when no task is available", async () => {
    fake.tools.claim_task = () => {
      throw new ToolError("no_task_available", "No open task matches");
    };
    assert.equal(await client.claimNext(fake.boardId, { area: "ios" }), null);
    assert.deepEqual(fake.calls.at(-1)?.args, { board_id: fake.boardId, labels: { area: "ios" } });
  });

  it("claimNext waits in server-side slices and returns a ClaimedTask that renews and completes", async () => {
    const { thread } = fake.addThread("Fix it", undefined, "Do it", { task: true, labels: { area: "ios" } });
    let calls = 0;
    fake.tools.claim_task = (args) => {
      calls++;
      if (calls === 1) throw new ToolError("no_task_available", "Nothing yet");
      return { thread: { ...thread, task: { ...thread.task!, state: "claimed" } }, claim: { epoch: 3, token: "tok-1", until: "2026-11-24T12:05:00.000Z" } };
    };
    fake.tools.renew_task = (args) => {
      assert.equal(args.token, "tok-1");
      return { thread, claim: { epoch: 3, token: "tok-1", until: "2026-11-24T12:10:00.000Z" } };
    };
    let settled: Record<string, unknown> | undefined;
    fake.tools.update_task = (args) => {
      settled = args;
      if (args.action === "fail") throw new ToolError("claim_lost", "This claim is over", { state: "ready" });
      return { thread, message: null };
    };
    const claimed = await client.claimNext(fake.boardId, { area: "ios" }, { waitSeconds: 30 });
    assert.ok(claimed);
    assert.equal(calls, 2);
    assert.equal(fake.calls.filter((c) => c.name === "claim_task").at(-1)?.args.wait_seconds, 25);
    assert.equal(claimed.id, thread.id);
    assert.equal(claimed.epoch, 3);
    await claimed.renew();
    assert.equal(claimed.until, "2026-11-24T12:10:00.000Z");
    await claimed.complete("Done.", { idempotencyKey: "k-1" });
    assert.deepEqual(settled, { thread_id: thread.id, action: "complete", token: "tok-1", result: "Done.", idempotency_key: "k-1" });
    await assert.rejects(claimed.fail("gave up"), (err: unknown) => err instanceof OmbError && err.code === "claim_lost");
    delete fake.tools.claim_task;
    delete fake.tools.renew_task;
    delete fake.tools.update_task;
  });

  it("createMany sends the plan in one call", async () => {
    fake.tools.create_tasks = () => ({ threads: [] });
    await client.createMany(fake.boardId, [{ key: "a", title: "A", body: "a" }, { title: "B", body: "b", needs: [{ key: "a" }] }], { idempotencyKey: "plan-1" });
    assert.deepEqual(fake.calls.at(-1)?.args, {
      board_id: fake.boardId,
      tasks: [{ key: "a", title: "A", body: "a" }, { title: "B", body: "b", needs: [{ key: "a" }] }],
      idempotency_key: "plan-1",
    });
    delete fake.tools.create_tasks;
  });

  it("waitForReply resolves with the next message from someone else", async () => {
    const fresh = new FakeServer();
    await fresh.start();
    const c = new OmbClient({ server: fresh.url, token: "t" });
    try {
      const { thread } = fresh.addThread("Question");
      setTimeout(() => fresh.postMessage(thread.id, "my own note", fresh.me), 30);
      setTimeout(() => fresh.postMessage(thread.id, "Here is the answer", OMAR), 80);
      const reply = await c.waitForReply(thread.id, { timeout: 5000 });
      assert.equal(reply?.body, "Here is the answer");
      assert.equal(reply?.author.id, OMAR.id);
    } finally {
      await c.close();
      await fresh.stop();
    }
  });

  it("waitForReply resolves null on timeout", async () => {
    const { thread } = fake.addThread("Quiet thread");
    const started = Date.now();
    assert.equal(await client.waitForReply(thread.id, { timeout: 1200 }), null);
    assert.ok(Date.now() - started >= 1000);
  });

  it("discovers the server", async () => {
    const info = await discoverServer(`${fake.url}/mcp`);
    assert.equal(info.mcp_endpoint, `${fake.url}/mcp`);
    assert.deepEqual(info.profiles, ["core", "live"]);
  });
});

describe("2025-era fallback", () => {
  it("falls back to initialize and still calls tools", async () => {
    const fake = await new FakeServer({ era: "legacy" }).start();
    const client = new OmbClient({ server: fake.url, token: "t" });
    try {
      const res = await client.whoami();
      assert.equal(res.principal.id, "p_maya");
      assert.equal(await client.protocolEra(), "legacy");
      assert.equal(await client.listen([fake.boardUri()], () => {}), null);
    } finally {
      await client.close();
      await fake.stop();
    }
  });
});

describe("client surface", () => {
  it("has a typed method for every protocol tool", () => {
    for (const name of TOOL_NAMES) {
      const method = TOOL_METHODS[name];
      assert.equal(typeof (OmbClient.prototype as unknown as Record<string, unknown>)[method], "function", `${name} → ${method}`);
    }
  });

  it("normalizes server URLs", () => {
    assert.equal(normalizeServer("https://board.example.com/"), "https://board.example.com");
    assert.equal(normalizeServer("https://board.example.com/mcp"), "https://board.example.com");
    assert.equal(normalizeServer("http://localhost:8787/omb/mcp/"), "http://localhost:8787/omb");
    assert.throws(() => normalizeServer("board.example.com"), (e: unknown) => e instanceof OmbError && e.code === "invalid_argument");
  });

  it("builds resource URIs from the server URL", () => {
    const c = new OmbClient({ server: "https://board.example.com/mcp" });
    assert.equal(c.boardUri("b1"), "https://board.example.com/b/b1");
    assert.equal(c.threadUri("b1", "t2"), "https://board.example.com/b/b1/t/t2");
    assert.equal(c.inboxUri(), "https://board.example.com/me/inbox");
  });
});

describe("token providers", () => {
  const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

  it("githubActionsOidc requests the server URL as audience and caches until expiry", async () => {
    const urls: string[] = [];
    const headers: string[] = [];
    const token = jwt(Math.floor(Date.now() / 1000) + 600);
    const provider = githubActionsOidc({
      env: { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/req?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "rt" },
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        headers.push(String((init.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ value: token }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(await provider({ server: "https://board.example.com" }), token);
    assert.equal(await provider({ server: "https://board.example.com" }), token);
    assert.equal(urls.length, 1, "cached");
    assert.equal(urls[0], "https://token.actions.example/req?api-version=2.0&audience=https%3A%2F%2Fboard.example.com");
    assert.equal(headers[0], "bearer rt");
    await provider({ server: "https://board.example.com", forceRefresh: true });
    assert.equal(urls.length, 2, "refreshed after a 401");
  });

  it("githubActionsOidc explains the missing permission", async () => {
    const provider = githubActionsOidc({ env: {} });
    await assert.rejects(Promise.resolve(provider({ server: "https://b.example" })), /id-token: write/);
  });

  it("vercelOidc prefers the request header over the build-time variable", () => {
    const provider = vercelOidc({ env: { VERCEL_OIDC_TOKEN: "build" }, headers: { "x-vercel-oidc-token": "runtime" } });
    assert.equal(provider({ server: "x" }), "runtime");
    assert.equal(vercelOidc({ env: { VERCEL_OIDC_TOKEN: "build" } })({ server: "x" }), "build");
    assert.throws(() => vercelOidc({ env: {} })({ server: "x" }), (e: unknown) => e instanceof OmbError && e.code === "unauthenticated");
  });

  it("envToken reads OMB_TOKEN", () => {
    assert.equal(envToken("OMB_TOKEN", { OMB_TOKEN: " abc " })({ server: "x" }), "abc");
    assert.throws(() => envToken("OMB_TOKEN", {})({ server: "x" }), /OMB_TOKEN is not set/);
  });

  it("surfaces a token provider's error as unauthenticated", async () => {
    const fake = await new FakeServer().start();
    const client = new OmbClient({ server: fake.url, tokenProvider: envToken("OMB_TOKEN", {}) });
    try {
      await assert.rejects(client.whoami(), (err: unknown) => err instanceof OmbError && err.code === "unauthenticated" && /OMB_TOKEN is not set/.test(err.message));
    } finally {
      await client.close();
      await fake.stop();
    }
  });

  it("sends the provider's token on each request", async () => {
    const fake = await new FakeServer().start();
    let n = 0;
    const client = new OmbClient({ server: fake.url, tokenProvider: () => `tok-${++n}` });
    try {
      await client.whoami();
      await client.whoami();
      const auths = fake.calls.map((c) => c.auth);
      assert.ok(auths.every((a) => a?.startsWith("Bearer tok-")));
      assert.notEqual(auths[0], auths[1]);
    } finally {
      await client.close();
      await fake.stop();
    }
  });
});
