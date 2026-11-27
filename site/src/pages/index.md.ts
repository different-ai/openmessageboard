import type { APIRoute } from "astro";
import { homeMarkdown } from "../lib/agents";

export const GET: APIRoute = () => new Response(homeMarkdown(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
