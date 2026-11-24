import MarkdownIt from "markdown-it";
import { useMemo } from "react";

// Raw HTML is disabled, so markdown-it escapes everything it does not render itself
// and its default link validator drops javascript:, vbscript: and data: URLs.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Remote images would load trackers for every reader; show them as links instead.
md.disable("image");

const renderToken: NonNullable<typeof md.renderer.rules.link_open> = (tokens, idx, options, _env, self) =>
  self.renderToken(tokens, idx, options);
const defaultLinkOpen = md.renderer.rules.link_open ?? renderToken;

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener nofollow ugc");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  // Safe: markdown-it output with html disabled.
  return <div className={className ? `md ${className}` : "md"} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Plain-text excerpt for quotes and inbox rows. */
export function excerpt(source: string | null, max = 140): string {
  if (!source) return "";
  const text = source
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[#>*_`~\[\]]/g, "")
    .replace(/\(\s*https?:[^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
