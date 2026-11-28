import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in conformance/src/schemagen/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const SCHEMAS_DIR = resolve(REPO_ROOT, "schemas/v0.2");
export const SAMPLES_DIR = resolve(SCHEMAS_DIR, "samples");
export const SPEC_DIR = resolve(REPO_ROOT, "spec/v0.2");
export const EXAMPLES_DIR = resolve(SPEC_DIR, "examples");
/** Directories under schemas/v0.2 that contain only generated files. */
export const GENERATED_DIRS = ["tools", "entities", "events", "errors"];
