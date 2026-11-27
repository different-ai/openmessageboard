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

export const SITE = "https://openmessageboard.com";
export const SITE_NAME = "OpenMessageBoard";
export const TAGLINE = "An open specification for message boards where people and agents work together";
export const SUMMARY =
  "OpenMessageBoard is an open, testable specification for message boards shared by people and AI agents, served over the Model Context Protocol (MCP). It defines who is speaking, what each caller may see, exactly-once ordered delivery, safe handoff of tasks, and that message content is data and not instructions.";

export interface SitePage {
  /** Stable key, also the name of the page's share image under /og/. */
  key: string;
  /** Canonical path of the HTML page. */
  path: string;
  /** Path of the Markdown twin served for agents. */
  markdown: string;
  title: string;
  description: string;
  /** Short lines drawn on the share image. */
  card: { kicker: string; title: string; detail: string };
}

const docPages: SitePage[] = documents.map((d) => ({
  key: d.slug,
  path: d.href,
  markdown: `${SPEC_BASE}${d.slug}.md`,
  title: `${d.number} ${d.title}`,
  description: `${d.title}: ${stripInline(d.covers)}. Document ${d.number} of the OpenMessageBoard specification, version ${SPEC_VERSION}.`,
  card: { kicker: `Specification ${SPEC_VERSION} · Document ${d.number}`, title: d.title, detail: stripInline(d.covers) },
}));

function stripInline(md: string): string {
  return md.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** Every page of the site, in reading order. The sitemap, llms.txt, share images and Markdown twins all come from it. */
export const pages: SitePage[] = [
  {
    key: "home",
    path: "/",
    markdown: "/index.md",
    title: `${SITE_NAME}: ${TAGLINE.charAt(0).toLowerCase()}${TAGLINE.slice(1)}`,
    description: SUMMARY,
    card: { kicker: `Open specification · Version ${SPEC_VERSION} · Draft`, title: SITE_NAME, detail: TAGLINE },
  },
  {
    key: "overview",
    path: SPEC_BASE,
    markdown: `${SPEC_BASE}index.md`,
    title: `OpenMessageBoard specification, version ${SPEC_VERSION}`,
    description:
      "Scope, goals, design principles, conformance language, profiles, extensions and versioning of the OpenMessageBoard specification.",
    card: {
      kicker: `Specification ${SPEC_VERSION} · Overview`,
      title: "The OpenMessageBoard specification",
      detail: "Scope, goals, design principles, profiles, extensions and versioning",
    },
  },
  ...docPages,
  {
    key: "requirements",
    path: `${SPEC_BASE}requirements/`,
    markdown: `${SPEC_BASE}requirements.md`,
    title: "Requirements and conformance coverage",
    description: `Every numbered requirement of OpenMessageBoard ${SPEC_VERSION}, quoted from the specification, with the conformance cases that check it: ${coverage().checked} of ${coverage().total} are checked.`,
    card: {
      kicker: `Specification ${SPEC_VERSION} · Catalogue`,
      title: "Requirements and conformance coverage",
      detail: `${coverage().total} numbered requirements, ${coverage().checked} checked by a conformance case`,
    },
  },
  {
    key: "examples",
    path: `${SPEC_BASE}examples/`,
    markdown: `${SPEC_BASE}examples/index.md`,
    title: "Worked examples",
    description: `Worked JSON-RPC exchanges for OpenMessageBoard ${SPEC_VERSION}. Each one is also a test fixture checked against the schemas.`,
    card: {
      kicker: `Specification ${SPEC_VERSION} · Examples`,
      title: "Worked examples",
      detail: `${examples.length} wire exchanges, each one a test fixture`,
    },
  },
];

export const page = (key: string): SitePage => {
  const found = pages.find((p) => p.key === key);
  if (!found) throw new Error(`no page ${key}`);
  return found;
};

const SPEC_DIR = "spec/v0.1";

/**
 * A specification document as Markdown an agent can follow: repository-relative links become absolute, and links to
 * other specification documents point at their Markdown twins.
 */
export function agentMarkdown(md: string, fromDir = SPEC_DIR): string {
  return md
    .replace(/(\]\()([^)\s]+)(\))/g, (_m, a, href, c) => `${a}${agentHref(href, fromDir)}${c}`)
    .replace(/^(\[[^\]]+\]:\s*)(\S+)/gm, (_m, a, href) => `${a}${agentHref(href, fromDir)}`);
}

/** Where a link written in a specification document leads for an agent: an absolute URL, Markdown where there is one. */
export function agentHref(href: string, fromDir = SPEC_DIR): string {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const [rawPath, hash = ""] = href.split("#");
  const frag = hash ? `#${hash}` : "";
  const target = path.posix.normalize(path.posix.join(fromDir, rawPath)).replace(/\/$/, "");
  if (target === SPEC_DIR || target === `${SPEC_DIR}/README.md`) return `${SITE}${SPEC_BASE}index.md${frag}`;
  if (target === `${SPEC_DIR}/examples` || target === `${SPEC_DIR}/examples/README.md`) return `${SITE}${SPEC_BASE}examples/index.md${frag}`;
  if (target.startsWith(`${SPEC_DIR}/`)) {
    const rel = target.slice(SPEC_DIR.length + 1);
    if (/^[\w-]+\.md$/.test(rel) || rel === "requirements.json" || /^examples\/[\w-]+\.json$/.test(rel)) return `${SITE}${SPEC_BASE}${rel}${frag}`;
  }
  if (/^schemas\/v0\.1\/(?!samples\/).+\.json$/.test(target) && fs.existsSync(path.join(root, target))) return `${SITE}/${target}${frag}`;
  const isFile = /\.[a-z0-9]+$/i.test(target);
  return `${REPO}/${isFile ? "blob" : "tree"}/main/${target}${frag}`;
}

export const specSource = (file: string) => read(`${SPEC_DIR}/${file}`);

/** The published JSON Schemas (everything but the test samples), as paths relative to schemas/v0.1. */
export const schemaFiles: string[] = (function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, "schemas/v0.1", dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return e.name === "samples" ? [] : walk(rel);
    return e.name.endsWith(".json") ? [rel] : [];
  });
})("");
export const schemaSource = (rel: string) => read(`schemas/v0.1/${rel}`);
