import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import type { SchemaEngine } from "@openmessageboard/core";
import { DRAFT_07_META_SCHEMA } from "./json-schema-draft-07.js";

/**
 * Registered data schemas on Workers: `@cfworker/json-schema` (through the MCP SDK) interprets schemas instead of
 * compiling them to code, which Workers forbid. A schema is checked against the draft-07 meta-schema before it's
 * registered. Problems come back as one message, at the path "/".
 */
const validator = new CfWorkerJsonSchemaValidator({ draft: "7", shortcircuit: false });
const metaSchema = validator.getValidator(DRAFT_07_META_SCHEMA);

export const cfWorkerSchemas: SchemaEngine = {
  check(schema) {
    const r = metaSchema(schema);
    if (!r.valid) throw new Error(r.errorMessage);
    validator.getValidator(schema);
  },
  compile(schema) {
    const validate = validator.getValidator(schema);
    return (data) => {
      const r = validate(data);
      return r.valid ? [] : [{ path: "/", message: r.errorMessage }];
    };
  },
};
