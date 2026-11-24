import { EditMessageBody, LabelMessageBody, MAX_ATTACHMENT_BYTES, ReactBody, RegisterSchemaBody } from "@openmessageboard/protocol";
import type { AppContext } from "../context.js";
import { OmbError, invalid } from "../errors.js";
import * as attachments from "../domain/attachments.js";
import * as messages from "../domain/messages.js";
import * as schemas from "../domain/schemas.js";
import { parseBody, requireActor, type AppCtx, type AppHono } from "./util.js";

function tooLarge(size: number): OmbError {
  return new OmbError("attachment_too_large", `Files can be up to ${MAX_ATTACHMENT_BYTES} bytes; this one is ${size}`, { limit: MAX_ATTACHMENT_BYTES, size });
}

/** Reads a request body, refusing more than `max` bytes without buffering the rest. */
async function readLimited(c: AppCtx, max: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max + 64 * 1024) throw tooLarge(declared);
  const body = c.req.raw.body;
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max + 64 * 1024) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(size);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** RFC 6266 filename for a download header (ASCII fallback plus UTF-8). */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Edit, react, label messages; attachments; the schema registry. */
export function registerMessageRoutes(app: AppHono, ctx: AppContext): void {
  app.patch("/api/messages/:messageId", async (c) => c.json(messages.editMessage(ctx, requireActor(c), c.req.param("messageId"), await parseBody(c, EditMessageBody))));
  app.post("/api/messages/:messageId/reactions", async (c) => c.json(messages.react(ctx, requireActor(c), c.req.param("messageId"), await parseBody(c, ReactBody))));
  app.post("/api/messages/:messageId/labels", async (c) => c.json(messages.labelMessage(ctx, requireActor(c), c.req.param("messageId"), await parseBody(c, LabelMessageBody))));

  // Upload: multipart (a `file` field) or a raw body with ?name= and the media type in Content-Type (or ?type=).
  app.post("/api/boards/:boardId/attachments", async (c) => {
    const actor = requireActor(c);
    const boardId = c.req.param("boardId");
    const contentType = c.req.header("content-type") ?? "";
    const raw = await readLimited(c, MAX_ATTACHMENT_BYTES);
    let name: string | undefined;
    let type: string | undefined;
    let data: Uint8Array;
    if (/^multipart\/form-data/i.test(contentType)) {
      let form: FormData;
      try {
        form = await new Request("http://upload.invalid/", { method: "POST", headers: { "content-type": contentType }, body: raw }).formData();
      } catch {
        throw invalid("Could not read the multipart body");
      }
      const file = form.get("file");
      if (!file || typeof file === "string") throw invalid('Send the file in a multipart field named "file"');
      data = new Uint8Array(await file.arrayBuffer());
      name = (typeof form.get("name") === "string" ? (form.get("name") as string) : "") || file.name;
      type = (typeof form.get("type") === "string" ? (form.get("type") as string) : "") || file.type;
    } else {
      data = raw;
      name = c.req.query("name");
      type = c.req.query("type") || contentType;
    }
    if (!name) throw invalid("Name the file: ?name=<file name> (or a multipart file name)");
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw tooLarge(data.byteLength);
    return c.json(await attachments.uploadAttachment(ctx, actor, boardId, { name, type, data }));
  });

  // Download: always a file to save, never a page to render.
  app.get("/api/attachments/:attachmentId", async (c) => {
    const { attachment, data } = await attachments.readAttachment(ctx, requireActor(c), c.req.param("attachmentId"));
    return c.body(Buffer.from(data), 200, {
      "Content-Type": attachment.type,
      "Content-Length": String(data.byteLength),
      "Content-Disposition": contentDisposition(attachment.name),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    });
  });

  app.get("/api/boards/:boardId/schemas", (c) => c.json(schemas.listSchemas(ctx, requireActor(c), c.req.param("boardId"))));
  app.get("/api/boards/:boardId/schemas/:schemaId", (c) => c.json(schemas.getSchema(ctx, requireActor(c), c.req.param("boardId"), c.req.param("schemaId"))));
  app.post("/api/boards/:boardId/schemas", async (c) => c.json(schemas.registerSchema(ctx, requireActor(c), c.req.param("boardId"), await parseBody(c, RegisterSchemaBody))));
}
