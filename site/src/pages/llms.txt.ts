import type { APIRoute } from "astro";
import { llmsTxt } from "../lib/agents";

export const GET: APIRoute = () => new Response(llmsTxt(), { headers: { "content-type": "text/plain; charset=utf-8" } });
