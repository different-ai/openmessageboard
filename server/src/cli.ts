#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";
import { migrate, openDatabase } from "./db/index.js";
import { startServer } from "./main.js";
import { actorFromPrincipal, nowIso } from "./domain/access.js";
import { createAgent, ensureHuman, mintToken, removeMembershipCascade } from "./domain/boards.js";
import { exportBoard, importBoard } from "./domain/portability.js";
import { tx } from "./context.js";

const HELP = `omb — OpenMessageBoard reference server

Usage:
  omb serve                                 Start the server (configure with OMB_* environment variables)
  omb migrate                               Apply database migrations and exit
  omb admin create-token <email> [--label]  Mint a personal access token for a person (prints it once)
  omb admin disable-account <email>         Disable a person and their agents; revoke their tokens
  omb admin enable-account <email>
  omb admin disable-board <board-id>        Hide a board (abuse handling); members lose access
  omb admin test-identities [--out file]    Test mode only: mint conformance identities
  omb export <board-id> --owner <email>     Write a board export to stdout
  omb import <file> --owner <email> [--name <board name>]   Import an export as a new board (bypasses limits)
`;

async function openCtx() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  await migrate(db);
  return createContext(config, db);
}

async function main(argv: string[]) {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "serve") {
    const running = await startServer();
    console.log(`OpenMessageBoard listening on ${running.ctx.config.host}:${running.ctx.config.port} (public URL ${running.url})${running.ctx.config.testMode ? " [test mode]" : ""}`);
    const shutdown = async () => {
      await running.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  if (cmd === "migrate") {
    const ctx = await openCtx();
    const { getMigrations } = await import("better-auth/db/migration");
    const { createAuth } = await import("./auth/auth.js");
    const { createMailer } = await import("./auth/mailer.js");
    const auth = createAuth(ctx, await createMailer(ctx));
    await (await getMigrations(auth.options)).runMigrations();
    console.log("Migrations applied.");
    return;
  }
  if (cmd === "admin") {
    const ctx = await openCtx();
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { label: { type: "string" }, out: { type: "string" } } });
    const target = positionals[0];
    if (sub === "create-token") {
      if (!target) throw new Error("email required");
      const p = ensureHuman(ctx, { email: target });
      console.log(mintToken(ctx, p.id, "personal", values.label ?? "admin").token);
      return;
    }
    if (sub === "disable-account" || sub === "enable-account") {
      if (!target) throw new Error("email required");
      const p = ctx.db.prepare("SELECT * FROM principals WHERE email = ?").get(target.toLowerCase()) as { id: string } | undefined;
      if (!p) throw new Error("No such account");
      if (sub === "enable-account") {
        ctx.db.prepare("UPDATE principals SET disabled_at = NULL WHERE id = ?").run(p.id);
        console.log("Enabled.");
        return;
      }
      tx(ctx, (emit) => {
        const now = nowIso(ctx);
        ctx.db.prepare("UPDATE principals SET disabled_at = ? WHERE id = ? OR owner_id = ?").run(now, p.id, p.id);
        ctx.db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE principal_id IN (SELECT id FROM principals WHERE id = ? OR owner_id = ?) AND revoked_at IS NULL").run(now, p.id, p.id);
        for (const m of ctx.db.prepare("SELECT board_id FROM memberships WHERE principal_id = ?").all(p.id) as { board_id: string }[]) {
          emit({ kind: "access", boardId: m.board_id, principalId: p.id, reason: "disabled" });
        }
      });
      console.log("Disabled. Running servers stop accepting this account's sessions and tokens immediately.");
      return;
    }
    if (sub === "disable-board") {
      if (!target) throw new Error("board id required");
      const info = ctx.db.prepare("UPDATE boards SET disabled_at = ? WHERE id = ?").run(nowIso(ctx), target);
      console.log(info.changes ? "Board disabled." : "No such board.");
      return;
    }
    if (sub === "test-identities") {
      if (!ctx.config.testMode) throw new Error("test-identities requires OMB_TEST_MODE=1");
      const people = {
        owner: "owner@example.test",
        maya: "maya@example.test",
        outsider: "outsider@elsewhere.test",
        lookalike: "user@examp1e.test",
        subdomain: "user@eng.example.test",
        quota: "quota@example.test",
      } as const;
      const principals: Record<string, Record<string, string>> = {};
      for (const [name, email] of Object.entries(people)) {
        const p = ensureHuman(ctx, { email, displayName: name === "maya" ? "Maya" : name.charAt(0).toUpperCase() + name.slice(1) });
        principals[name] = { token: mintToken(ctx, p.id, "test", "conformance").token, email, id: p.id };
      }
      const maya = actorFromPrincipal(ensureHuman(ctx, { email: people.maya }), "system");
      const agent = createAgent(ctx, maya, "release-agent");
      principals.agent = { token: mintToken(ctx, agent.id, "agent", "conformance").token, owner: "maya", display_name: "release-agent", id: agent.id };
      const out = JSON.stringify({ server: ctx.config.publicUrl, principals }, null, 2) + "\n";
      if (values.out) {
        writeFileSync(values.out, out, { mode: 0o600 });
        console.log(`Wrote ${values.out}`);
      } else process.stdout.write(out);
      return;
    }
    throw new Error(`Unknown admin command: ${sub}`);
  }
  if (cmd === "export" || cmd === "import") {
    const ctx = await openCtx();
    const args = cmd === "export" ? [sub ?? "", ...rest] : [sub ?? "", ...rest];
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { owner: { type: "string" }, name: { type: "string" } } });
    if (!values.owner) throw new Error("--owner <email> is required");
    const owner = actorFromPrincipal(ensureHuman(ctx, { email: values.owner }), "system");
    if (cmd === "export") {
      process.stdout.write(JSON.stringify(exportBoard(ctx, owner, positionals[0] ?? ""), null, 2) + "\n");
      return;
    }
    const file = JSON.parse(await readFile(positionals[0] ?? "", "utf8")) as unknown;
    const board = importBoard(ctx, owner, file, { bypassLimits: true, ...(values.name ? { name: values.name } : {}) });
    console.log(`Imported as ${board.name} (${board.id}) at ${board.url}`);
    return;
  }
  // keep the helper referenced for future admin commands
  void removeMembershipCascade;
  throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
