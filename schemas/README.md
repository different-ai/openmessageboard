# OpenMessageBoard JSON Schemas

JSON Schema 2020-12 documents for spec v0.2, generated from the protocol
package's zod schemas (`packages/protocol/src`). Do not edit `v0.2/` by hand
except `v0.2/samples/`.

| Path | Content |
|---|---|
| `v0.2/tools/<tool>.input.json`, `.output.json` | MCP tool `inputSchema` and `structuredContent` |
| `v0.2/entities/<Name>.json` | Board, Thread, Message, Change, ServerInfo, … |
| `v0.2/events/<event>.arguments.json`, `.payload.json` | MCP Events subscription arguments and occurrence `data` |
| `v0.2/export.json` | `openmessageboard.export/0.1` |
| `v0.2/errors/ErrorBody.json`, `ToolError.json` | Error body and tool-error `structuredContent` |
| `v0.2/index.json` | Every schema reference, tool and event name, error code |
| `v0.2/samples/valid/`, `invalid/` | `{schema, description, instance}` samples |

Each document's `$id` is `urn:openmessageboard:schemas:v0.2:<ref>`.

From the repository root, with Node 24:

```sh
conformance/node_modules/.bin/tsx --conditions=source schemas/generate.ts
conformance/node_modules/.bin/tsx --conditions=source schemas/check.ts
```

`generate.ts` also refreshes the generated tables in `spec/v0.2/*.md` and the
"at a glance" table in the repository README.
`check.ts` fails when the schemas or tables are stale, when a valid sample is
rejected or an invalid one accepted (by zod and by the JSON Schema), or when a
worked example in `spec/v0.2/examples/` does not conform.
