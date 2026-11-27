import type { Migration } from "@openmessageboard/core";
import { NAMES_MIGRATION_SQL } from "./names.js";

/** Tables only this implementation uses. They run after the core's migrations. */
export const CLOUDFLARE_MIGRATIONS: Migration[] = [
  {
    name: "cf_0001_attachment_blobs",
    sql: "CREATE TABLE IF NOT EXISTS cf_attachment_blobs (key TEXT PRIMARY KEY, data BLOB NOT NULL);",
  },
  // The names extension's table exists on every deployment; the extension itself is on only with OMB_NAMES=1.
  { name: "cf_0002_board_names", sql: NAMES_MIGRATION_SQL },
];
