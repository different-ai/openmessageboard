/**
 * Validates schemas/v0.1/samples (valid must pass, invalid must fail), checks the
 * worked exchanges in spec/v0.1/examples against the schemas, and fails if the
 * generated schemas or spec tables are stale.
 *
 * Run from the repository root:
 *   conformance/node_modules/.bin/tsx --conditions=source schemas/check.ts
 */
import { main } from "../conformance/src/schemagen/check.ts";

process.exitCode = main();
