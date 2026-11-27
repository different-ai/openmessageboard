import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import { rehypeSpec } from "./src/lib/rehype-spec.mjs";

// A static site: every page is built from spec/v0.1 and served by Cloudflare as assets (wrangler.jsonc).
export default defineConfig({
  site: "https://openmessageboard.com",
  trailingSlash: "always",
  build: { format: "directory" },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  markdown: {
    // The remark/rehype pipeline, because rehypeSpec rewrites the specification's repository links.
    // Straight quotes stay straight: the specification quotes wire values and regular expressions.
    processor: unified({ rehypePlugins: [rehypeSpec], smartypants: false }),
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, wrap: false },
  },
});
