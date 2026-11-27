import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// The specification is read from the repository at build time, so the site cannot drift from spec/v0.1.
const spec = defineCollection({
  loader: glob({ pattern: "*.md", base: "../spec/v0.1", generateId: ({ entry }) => entry.replace(/\.md$/, "") }),
});

export const collections = { spec };
