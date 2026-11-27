import type { APIRoute } from "astro";
import { examples } from "../../../../lib/spec";

export const getStaticPaths = () => examples.map((e) => ({ params: { slug: e.slug }, props: { json: e.json } }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.json, { headers: { "content-type": "application/json; charset=utf-8" } });
