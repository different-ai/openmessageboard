import type { APIRoute } from "astro";
import { schemaFiles, schemaSource } from "../../../lib/spec";

// The generated JSON Schemas, published at stable URLs. The test samples stay in the repository.
export const getStaticPaths = () => schemaFiles.map((rel) => ({ params: { path: rel.replace(/\.json$/, "") }, props: { rel } }));

export const GET: APIRoute = ({ props }) =>
  new Response(schemaSource(props.rel), { headers: { "content-type": "application/schema+json; charset=utf-8" } });
