import type { Migration } from "@openmessageboard/core";

/** Tables only this implementation uses. They run after the core's migrations. */
export const CLOUDFLARE_MIGRATIONS: Migration[] = [
  {
    name: "cf_0001_attachment_blobs",
    sql: "CREATE TABLE IF NOT EXISTS cf_attachment_blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL);",
  },
];
