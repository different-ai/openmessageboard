/**
 * The numbered requirements of the specification (spec/v0.1/requirements.json), the
 * conformance cases that check each one, and the rules that keep both honest:
 *
 *  - every requirement quotes the specification verbatim, so editing a normative
 *    sentence without updating the catalogue fails the check;
 *  - every MUST-level key word in a normative section sits inside a requirement;
 *  - every conformance case names the requirements it checks, and they exist;
 *  - a requirement no case checks says why.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as P from "@openmessageboard/protocol";
import { ALL_CASES } from "../cases/index.ts";
import { SPEC_DIR } from "./paths.ts";

export const UNTESTED = {
  client: "A requirement on clients. The suite tests servers.",
  process: "A requirement on people (implementers making a claim, extension authors), not on a running server.",
  internal: "Not observable through the MCP binding and discovery: storage, logs, transactions, or actions the specification leaves to a server's own interface.",
  external: "Needs an external platform, a trusted token issuer or an interactive sign-in that the suite does not drive.",
  gap: "Observable over the wire, with no conformance case yet.",
} as const;
export type Untested = keyof typeof UNTESTED;

export interface Requirement {
  id: string;
  doc: string;
  section: string;
  party: "server" | "client" | "implementer";
  /** A verbatim excerpt of the specification, compared after collapsing whitespace. */
  quote: string;
  /** A plain restatement, for excerpts that do not read well alone (table cells). */
  summary?: string;
  untested?: Untested;
}

export const REQUIREMENTS_FILE = join(SPEC_DIR, "requirements.json");
export const MATRIX_FILE = "requirements.md";

const KEY_WORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/g;
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const docPrefix = (doc: string): string => (doc === "README.md" ? "00" : doc.slice(0, 2));

export function loadRequirements(): Requirement[] {
  const file = JSON.parse(readFileSync(REQUIREMENTS_FILE, "utf8")) as { spec_version: string; requirements: Requirement[] };
  if (file.spec_version !== P.SPEC_VERSION) throw new Error(`requirements.json is for spec ${file.spec_version}, not ${P.SPEC_VERSION}`);
  return file.requirements;
}

/** Requirement ID → the cases that cover it, in run order. */
export function coverage(): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const c of ALL_CASES) for (const id of c.covers) by.set(id, [...(by.get(id) ?? []), c.id]);
  return by;
}

interface Doc {
  text: string;
  /** Offsets where an informative stretch starts and ends (a non-normative section, or Conformance language). */
  informative: [number, number][];
}

function readDoc(name: string): Doc {
  const raw = readFileSync(join(SPEC_DIR, name), "utf8");
  const text = collapse(raw);
  const informative: [number, number][] = [];
  let pos = 0;
  let open: { level: number; from: number } | undefined;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("#")) continue;
    const at = text.indexOf(collapse(line), pos);
    if (at < 0) continue;
    pos = at + 1;
    const level = line.length - line.replace(/^#+/, "").length;
    if (open && level <= open.level) {
      informative.push([open.from, at]);
      open = undefined;
    }
    if (!open && /non-normative|^#+ (Conformance language|Requirements and coverage)/.test(line)) open = { level, from: at };
  }
  if (open) informative.push([open.from, text.length]);
  return { text, informative };
}

export function specDocs(): string[] {
  return readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md") && f !== MATRIX_FILE)
    .sort((a, b) => docPrefix(a).localeCompare(docPrefix(b)));
}

/** Every problem with the catalogue and the cases' `covers`; empty when all is well. */
export function validateRequirements(): string[] {
  const problems: string[] = [];
  const reqs = loadRequirements();
  const cover = coverage();
  const docs = new Map(specDocs().map((d) => [d, readDoc(d)]));
  const seen = new Set<string>();
  const spans = new Map<string, [number, number][]>();

  for (const r of reqs) {
    if (!/^R\d\d-\d\d$/.test(r.id)) problems.push(`${r.id}: IDs look like R03-12`);
    if (seen.has(r.id)) problems.push(`${r.id}: used twice`);
    seen.add(r.id);
    const doc = docs.get(r.doc);
    if (!doc) {
      problems.push(`${r.id}: unknown document ${r.doc}`);
      continue;
    }
    if (r.id.slice(1, 3) !== docPrefix(r.doc)) problems.push(`${r.id}: the ID's document number does not match ${r.doc}`);
    const quote = collapse(r.quote);
    let at = doc.text.indexOf(quote);
    if (at < 0) problems.push(`${r.id}: its quote is no longer in ${r.doc}; update the quote, or retire the requirement`);
    for (; at >= 0; at = doc.text.indexOf(quote, at + 1)) spans.set(r.doc, [...(spans.get(r.doc) ?? []), [at, at + quote.length]]);
    const cases = cover.get(r.id) ?? [];
    if (r.untested && !(r.untested in UNTESTED)) problems.push(`${r.id}: unknown untested reason "${r.untested}"`);
    if (r.untested && cases.length) problems.push(`${r.id}: marked untested (${r.untested}) but covered by ${cases.join(", ")}`);
    if (!r.untested && !cases.length) problems.push(`${r.id}: no conformance case covers it; add one, or say why with "untested"`);
  }

  for (const [name, doc] of docs) {
    const covered = spans.get(name) ?? [];
    for (const m of doc.text.matchAll(KEY_WORD)) {
      const at = m.index;
      if (doc.text[at - 1] === '"') continue;
      if (doc.informative.some(([a, b]) => at >= a && at < b)) continue;
      if (!covered.some(([a, b]) => at >= a && at < b)) {
        problems.push(`${name}: "${doc.text.slice(Math.max(0, at - 60), at + 40)}" has ${m[0]} but no requirement in requirements.json quotes it`);
      }
    }
  }

  for (const c of ALL_CASES) {
    for (const id of c.covers) if (!seen.has(id)) problems.push(`case ${c.id}: covers ${id}, which is not in requirements.json`);
    if (c.placeholder && c.covers.length) problems.push(`case ${c.id}: a placeholder covers nothing`);
    if (!c.placeholder && !c.covers.length) problems.push(`case ${c.id}: covers no requirement`);
    // A case that skips before it checks anything verifies nothing, so it may not count as coverage.
    const alwaysSkips = /^[^{]*\{\s*(?:const \w+ = await ctx\.discovery\(\);\s*)?ctx\.skip\(/.test(c.run.toString());
    if (alwaysSkips && !c.placeholder) problems.push(`case ${c.id}: always skips; mark it placeholder and move its requirements to "untested"`);
  }
  return problems;
}

export function requirementCounts(): { total: number; tested: number; untested: Record<Untested, number> } {
  const reqs = loadRequirements();
  const untested = Object.fromEntries(Object.keys(UNTESTED).map((k) => [k, 0])) as Record<Untested, number>;
  for (const r of reqs) if (r.untested) untested[r.untested]++;
  return { total: reqs.length, tested: reqs.filter((r) => !r.untested).length, untested };
}

const cell = (s: string): string => s.replace(/\|/g, "\\|");

/** spec/v0.1/requirements.md, in full. */
export function renderMatrix(): string {
  const reqs = loadRequirements();
  const cover = coverage();
  const counts = requirementCounts();
  const out: string[] = [
    "# Requirements and conformance coverage",
    "",
    "<!-- Generated by schemas/generate.ts from requirements.json and the conformance cases. Do not edit. -->",
    "",
    `Every numbered requirement of OpenMessageBoard ${P.SPEC_VERSION}, quoted from the specification, with the`,
    "[conformance](../../conformance) cases that check it. A requirement no case checks says why.",
    "",
    "| | Requirements |",
    "|---|---:|",
    `| Checked by at least one conformance case | ${counts.tested} |`,
    ...(Object.keys(UNTESTED) as Untested[]).map((k) => `| Not checked: \`${k}\` | ${counts.untested[k]} |`),
    `| **Total** | **${counts.total}** |`,
    "",
    "| Reason | Meaning |",
    "|---|---|",
    ...(Object.keys(UNTESTED) as Untested[]).map((k) => `| \`${k}\` | ${UNTESTED[k]} |`),
    "",
    "What this catalogue covers, and what it does not: [README](README.md#requirements-and-coverage).",
  ];
  for (const doc of specDocs()) {
    const rows = reqs.filter((r) => r.doc === doc);
    if (!rows.length) continue;
    out.push("", `## ${doc === "README.md" ? "README" : doc.replace(/\.md$/, "")}`, "", `Source: [${doc}](${doc})`, "", "| ID | On | Requirement | Checked by |", "|---|---|---|---|");
    for (const r of rows) {
      const cases = cover.get(r.id) ?? [];
      const text = r.summary ? `${cell(r.summary)}` : `“${cell(collapse(r.quote))}”`;
      out.push(`| <a id="${r.id.toLowerCase()}"></a>${r.id} | ${r.party} | ${text} | ${cases.length ? cases.map((c) => `\`${c}\``).join(", ") : `*${r.untested}*`} |`);
    }
  }
  return out.join("\n") + "\n";
}
