// Facts about the specification, read from the repository at build time.
import fs from "node:fs";
import path from "node:path";

export const REPO = "https://github.com/different-ai/openmessageboard";
export const SPEC_VERSION = "0.1";
export const SPEC_BASE = "/spec/v0.1/";

const root = path.resolve(process.cwd(), "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

export interface Requirement {
  id: string;
  doc: string;
  section: string;
  party: string;
  quote: string;
  untested?: "client" | "process" | "internal" | "external" | "gap";
}

export const requirements: Requirement[] = JSON.parse(read("spec/v0.1/requirements.json")).requirements;

export function coverage(list: Requirement[] = requirements) {
  const by = (reason: string) => list.filter((r) => r.untested === reason).length;
  return {
    total: list.length,
    checked: list.filter((r) => !r.untested).length,
    gap: by("gap"),
    internal: by("internal"),
    external: by("external"),
    client: by("client"),
    process: by("process"),
  };
}

/** Inline Markdown found in the spec's tables: bold, code and links. Everything else is escaped. */
export function inline(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(md)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function tableRows(md: string, start: RegExp): string[][] {
  const lines = md.split("\n");
  const from = lines.findIndex((l) => start.test(l));
  if (from === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(from)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((c) => c.trim()));
  }
  return rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
}

const overview = read("spec/v0.1/README.md");

/** The design principles table of the specification's opening document. */
export const principles = tableRows(overview, /^\| # \| Principle/)
  .slice(1)
  .map(([id, text]) => {
    const m = text.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    return { id, name: m ? m[1].replace(/\.$/, "") : text, detail: m ? m[2] : "" };
  });

/** The document table of the specification's opening document, in reading order. */
export const documents = tableRows(overview, /^\| Document \| Covers/)
  .slice(1)
  .map(([doc, covers]) => {
    const m = doc.match(/\[(.+?)\]\((.+?)\)/);
    const file = m ? m[2] : "";
    const label = m ? m[1] : doc;
    const num = label.match(/^(\d\d) (.*)$/);
    return { file, number: num ? num[1] : "", title: num ? num[2] : label, covers };
  })
  .filter((d) => /^\d\d-.*\.md$/.test(d.file))
  .map((d) => ({ ...d, slug: d.file.replace(/\.md$/, ""), href: `${SPEC_BASE}${d.file.replace(/\.md$/, "")}/` }));

/** "The specification at a glance" from the repository README, which CI keeps current. */
export const glance = Object.fromEntries(
  tableRows(read("README.md"), /^\| In spec v0\.1 \| Count/)
    .slice(1)
    .map(([what, count]) => [what.replace(/\s*\(.*\)$/, ""), Number(count)]),
) as Record<string, number>;

export interface Example {
  slug: string;
  title: string;
  summary: string;
  profiles: string[];
  sections: string[];
  steps: number;
  json: string;
}

export const examples: Example[] = fs
  .readdirSync(path.join(root, "spec/v0.1/examples"))
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const json = read(`spec/v0.1/examples/${f}`);
    const data = JSON.parse(json);
    return {
      slug: f.replace(/\.json$/, ""),
      title: data.title ?? f,
      summary: data.summary ?? "",
      profiles: data.profiles ?? [],
      sections: data.sections ?? [],
      steps: Array.isArray(data.steps) ? data.steps.length : 0,
      json,
    };
  });

/** Navigation order: the overview, the twelve documents, then the generated catalogue and the examples. */
export const nav = [
  { href: SPEC_BASE, number: "", title: "Overview", slug: "README" },
  ...documents.map((d) => ({ href: d.href, number: d.number, title: d.title, slug: d.slug })),
  { href: `${SPEC_BASE}requirements/`, number: "", title: "Requirements and coverage", slug: "requirements" },
  { href: `${SPEC_BASE}examples/`, number: "", title: "Worked examples", slug: "examples" },
];
