// Rehype plugin for documents rendered from spec/v0.1: repository-relative links become site or GitHub links,
// BCP 14 key words are marked up, and tables get a scroll container.
import path from "node:path";

export const REPO = "https://github.com/different-ai/openmessageboard";
const SPEC_DIR = "spec/v0.1";
const KEYWORDS = /\b(MUST NOT|SHALL NOT|SHOULD NOT|NOT RECOMMENDED|MUST|SHALL|SHOULD|REQUIRED|RECOMMENDED|MAY|OPTIONAL)\b/g;
const SKIP = new Set(["code", "pre", "a", "script", "style"]);

/** Map a link written inside a spec document to where it lives on the site, or on GitHub. */
export function resolveSpecHref(href, fromDir = SPEC_DIR) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [rawPath, hash = ""] = href.split("#");
  const frag = hash ? `#${hash}` : "";
  const target = path.posix.normalize(path.posix.join(fromDir, rawPath));
  const isDir = rawPath.endsWith("/");
  if (target.startsWith(`${SPEC_DIR}/`) || target === SPEC_DIR) {
    const rel = target.slice(SPEC_DIR.length + 1).replace(/\/$/, "");
    if (rel === "" || rel === "README.md") return `/spec/v0.1/${frag}`;
    if (rel === "examples" || rel === "examples/README.md") return `/spec/v0.1/examples/${frag}`;
    const example = rel.match(/^examples\/(.+)\.json$/);
    if (example) return `/spec/v0.1/examples/#${example[1]}`;
    if (/^[\w-]+\.md$/.test(rel)) return `/spec/v0.1/${rel.replace(/\.md$/, "")}/${frag}`;
  }
  const looksLikeFile = !isDir && /\.[a-z0-9]+$/i.test(target);
  return `${REPO}/${looksLikeFile ? "blob" : "tree"}/main/${target.replace(/\/$/, "")}${frag}`;
}

function markKeywords(node) {
  if (!node.children) return;
  const out = [];
  for (const child of node.children) {
    if (child.type === "element") {
      if (!SKIP.has(child.tagName)) markKeywords(child);
      out.push(child);
      continue;
    }
    if (child.type !== "text" || !KEYWORDS.test(child.value)) {
      out.push(child);
      continue;
    }
    KEYWORDS.lastIndex = 0;
    let last = 0;
    for (const m of child.value.matchAll(KEYWORDS)) {
      if (m.index > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
      out.push({ type: "element", tagName: "span", properties: { className: ["kw"] }, children: [{ type: "text", value: m[0] }] });
      last = m.index + m[0].length;
    }
    if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
  }
  node.children = out;
}

function walk(node, visit) {
  if (!node.children) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type !== "element") continue;
    const replaced = visit(child);
    if (replaced) node.children[i] = replaced;
    walk(replaced ? child : child, visit);
  }
}

export function rehypeSpec() {
  return (tree, file) => {
    const filePath = file?.path ?? file?.history?.[0] ?? "";
    const at = filePath.replaceAll("\\", "/").lastIndexOf(`/${SPEC_DIR}/`);
    if (at === -1) return;
    walk(tree, (el) => {
      if (el.tagName === "a" && typeof el.properties?.href === "string") {
        const href = resolveSpecHref(el.properties.href);
        el.properties.href = href;
        if (/^https?:/.test(href)) el.properties.rel = ["noopener"];
      }
      if (el.tagName === "table") {
        return { type: "element", tagName: "div", properties: { className: ["table-wrap"] }, children: [el] };
      }
    });
    markKeywords(tree);
  };
}
