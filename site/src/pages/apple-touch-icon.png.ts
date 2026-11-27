import fs from "node:fs";
import path from "node:path";
import type { APIRoute } from "astro";
import sharp from "sharp";

export const GET: APIRoute = async () => {
  const svg = fs.readFileSync(path.resolve("public/favicon.svg"));
  const png = await sharp(svg, { density: 600 }).resize(180, 180).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
};
