// Share images, drawn at build time in the site's own typeface so they look the same wherever the site is built.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import satori from "satori";
import sharp from "sharp";

const require = createRequire(path.resolve("package.json"));
const font = (weight: number, style: "normal" | "italic") =>
  fs.readFileSync(require.resolve(`@fontsource/source-serif-4/files/source-serif-4-latin-${weight}-${style}.woff`));

const fonts = [
  { name: "Serif", data: font(400, "normal"), weight: 400 as const, style: "normal" as const },
  { name: "Serif", data: font(600, "normal"), weight: 600 as const, style: "normal" as const },
  { name: "Serif", data: font(400, "italic"), weight: 400 as const, style: "italic" as const },
];

const PAPER = "#fbfaf6";
const INK = "#1c1b19";
const MUTED = "#625f58";
const ACCENT = "#8a1c1c";

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const el = (style: Record<string, unknown>, children?: unknown): Node => ({ type: "div", props: { style, children } });

export interface Card {
  kicker: string;
  title: string;
  detail: string;
}

export async function shareImage({ kicker, title, detail }: Card): Promise<Buffer> {
  // One line where it fits: the serif averages about half an em per character.
  const titleSize = Math.max(60, Math.min(104, Math.floor(1048 / (title.length * 0.53))));
  const tree = el(
    {
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      width: 1200,
      height: 630,
      boxSizing: "border-box",
      background: PAPER,
      color: INK,
      padding: "64px 76px 56px",
      fontFamily: "Serif",
    },
    [
      el({ display: "flex", flexDirection: "column", width: 1048 }, [
        el({ display: "flex", fontSize: 25, fontWeight: 600, letterSpacing: 3.2, textTransform: "uppercase", color: ACCENT }, kicker),
        el({ display: "flex", marginTop: 34, fontSize: titleSize, fontWeight: 600, lineHeight: 1.06, letterSpacing: -2 }, title),
        el({ display: "flex", marginTop: 26, fontSize: 38, fontStyle: "italic", lineHeight: 1.3, color: INK, maxWidth: 960 }, detail),
      ]),
      el({ display: "flex", flexDirection: "column", width: 1048 }, [
        el({ display: "flex", width: 1048, height: 3, background: INK }),
        el({ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22, fontSize: 28 }, [
          el({ display: "flex", fontWeight: 600 }, [
            el({ display: "flex" }, "Open"),
            el({ display: "flex", color: ACCENT }, "Message"),
            el({ display: "flex" }, "Board"),
          ]),
          el({ display: "flex", color: MUTED }, "openmessageboard.com"),
        ]),
      ]),
    ],
  );
  const svg = await satori(tree as never, { width: 1200, height: 630, fonts });
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
