import type { APIRoute } from "astro";
import { agentMarkdown, specSource } from "../../../lib/spec";

export const GET: APIRoute = () =>
  new Response(agentMarkdown(specSource("README.md")), { headers: { "content-type": "text/markdown; charset=utf-8" } });
