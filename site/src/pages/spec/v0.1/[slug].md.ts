import type { APIRoute } from "astro";
import { agentMarkdown, documents, specSource } from "../../../lib/spec";

// The Markdown twin of each document: the source text, with links made absolute so an agent can follow them.
export const getStaticPaths = () => [...documents.map((d) => d.slug), "requirements"].map((slug) => ({ params: { slug } }));

export const GET: APIRoute = ({ params }) =>
  new Response(agentMarkdown(specSource(`${params.slug}.md`)), { headers: { "content-type": "text/markdown; charset=utf-8" } });
