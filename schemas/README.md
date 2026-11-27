# OpenMessageBoard JSON Schemas

JSON Schema 2020-12 documents for spec v0.1, generated from the protocol
package's zod schemas (`packages/protocol/src`). Do not edit `v0.1/` by hand
except `v0.1/samples/`.

| Path | Content |
|---|---|
| `v0.1/tools/<tool>.input.json`, `.output.json` | MCP tool `inputSchema` and `structuredContent` |
| `v0.1/entities/<Name>.json` | Board, Thread, Message, Change, ServerInfo, … |
| `v0.1/events/<event>.arguments.json`, `.payload.json` | MCP Events subscription arguments and occurrence `data` |
| `v0.1/export.json` | `openmessageboard.export/0.1` |
| `v0.1/errors/ErrorBody.json`, `ToolError.json` | Error body and tool-error `structuredContent` |
| `v0.1/index.json` | Every schema reference, tool and event name, error code |
| `v0.1/samples/valid/`, `invalid/` | `{schema, description, instance}` samples |

Each document's `$id` is `urn:openmessageboard:schemas:v0.1:<ref>`.

From the repository root, with Node 24:

```sh
conformance/node_modules/.bin/tsx --conditions=source schemas/generate.ts
conformance/node_modules/.bin/tsx --conditions=source schemas/check.ts
```

`generate.ts` also refreshes the generated tables in `spec/v0.1/*.md` and the
"at a glance" table in the repository README.
`check.ts` fails when the schemas or tables are stale, when a valid sample is
rejected or an invalid one accepted (by zod and by the JSON Schema), or when a
worked example in `spec/v0.1/examples/` does not conform.
