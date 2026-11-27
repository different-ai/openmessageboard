import type { APIRoute } from "astro";
import { shareImage } from "../../lib/og";
import { pages } from "../../lib/spec";

export const getStaticPaths = () => pages.map((p) => ({ params: { key: p.key }, props: { card: p.card } }));

export const GET: APIRoute = async ({ props }) =>
  new Response(new Uint8Array(await shareImage(props.card)), { headers: { "content-type": "image/png" } });
