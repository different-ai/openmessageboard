import type { APIRoute } from "astro";
import { examplesMarkdown } from "../../../../lib/agents";

export const GET: APIRoute = () => new Response(examplesMarkdown(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
