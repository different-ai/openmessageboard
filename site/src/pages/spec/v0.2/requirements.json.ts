import type { APIRoute } from "astro";
import { specSource } from "../../../lib/spec";

export const GET: APIRoute = () =>
  new Response(specSource("requirements.json"), { headers: { "content-type": "application/json; charset=utf-8" } });
