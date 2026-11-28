/**
 * Writes schemas/v0.2/** from the protocol zod schemas and refreshes the
 * generated tables in spec/v0.2/*.md. Run from the repository root:
 *
 *   conformance/node_modules/.bin/tsx --conditions=source schemas/generate.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatedFiles } from "./build.ts";
import { GENERATED_DIRS, REPO_ROOT, SCHEMAS_DIR, SPEC_DIR } from "./paths.ts";
import { MATRIX_FILE, renderMatrix } from "./requirements.ts";
import { applyTables, SPEC_TABLES } from "./spec-tables.ts";

export function generate(): { written: number; removed: string[]; tables: string[] } {
  const files = generatedFiles();
  let written = 0;
  for (const [file, contents] of files) {
    const target = join(SCHEMAS_DIR, file);
    mkdirSync(dirname(target), { recursive: true });
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current !== contents) {
      writeFileSync(target, contents);
      written++;
    }
  }
  const removed: string[] = [];
  for (const dir of GENERATED_DIRS) {
    const full = join(SCHEMAS_DIR, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      const rel = `${dir}/${name}`;
      if (name.endsWith(".json") && !files.has(rel)) {
        rmSync(join(full, name));
        removed.push(rel);
      }
    }
  }
  const tables: string[] = [];
  const specFiles = new Set(Object.values(SPEC_TABLES).map((t) => t.file));
  for (const file of specFiles) {
    const path = join(SPEC_DIR, file);
    if (!existsSync(path)) continue;
    const before = readFileSync(path, "utf8");
    const { text, found } = applyTables(file, before);
    tables.push(...found.map((n) => `${file}#${n}`));
    if (text !== before) writeFileSync(path, text);
  }
  const matrixPath = join(SPEC_DIR, MATRIX_FILE);
  const matrix = renderMatrix();
  if (!existsSync(matrixPath) || readFileSync(matrixPath, "utf8") !== matrix) writeFileSync(matrixPath, matrix);
  tables.push(MATRIX_FILE);
  return { written, removed, tables };
}

export function main(): void {
  const result = generate();
  console.log(`schemas: ${result.written} file(s) written to ${relative(REPO_ROOT, SCHEMAS_DIR)}`);
  if (result.removed.length) console.log(`schemas: removed stale ${result.removed.join(", ")}`);
  console.log(`spec tables refreshed: ${result.tables.join(", ") || "none found"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
