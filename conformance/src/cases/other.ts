/** import, sync and workload profiles: checked only as far as the public MCP interface allows. */
import type { CaseDef } from "../harness.ts";

export const otherCases: CaseDef[] = [
  {
    id: "import.claim",
    profile: "import",
    title: "The server claims import in discovery",
    covers: ["R00-05"],
    async run(ctx) {
      const info = await ctx.discovery();
      if (!info.profiles.includes("import")) ctx.skip('server does not claim the "import" profile');
      ctx.note("export and import are web-only in v0.1 (08); only the discovery claim is checked over the public interface");
    },
  },
  {
    id: "import.round-trip",
    profile: "import",
    title: "Export, then import into a fresh board, keeps threads, authorship, timestamps and reply links",
    covers: [],
    placeholder: true,
    async run(ctx) {
      ctx.skip("export and import have no MCP path in v0.1; test them through the server's own interface");
    },
  },
  {
    id: "sync.platforms",
    profile: "sync",
    title: "Slack, GitHub and Linear sync",
    covers: [],
    placeholder: true,
    async run(ctx) {
      ctx.skip("needs external platform workspaces and integrations configured outside MCP");
    },
  },
  {
    id: "workload.oidc",
    profile: "workload",
    title: "Workload identity with an OIDC ID token",
    covers: [],
    placeholder: true,
    async run(ctx) {
      ctx.skip("needs a workload trust (created outside MCP) and an ID token from an OIDC issuer the server trusts");
    },
  },
];
