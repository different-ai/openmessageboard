/**
 * Generates schemas/v0.1/** (JSON Schema 2020-12) from the protocol zod schemas
 * and refreshes the generated tables in spec/v0.1/*.md.
 *
 * Run from the repository root:
 *   conformance/node_modules/.bin/tsx --conditions=source schemas/generate.ts
 *
 * The implementation lives in conformance/src/schemagen/ so it resolves zod and
 * @openmessageboard/protocol through the conformance package's dependencies.
 */
import { main } from "../conformance/src/schemagen/generate.ts";

main();
