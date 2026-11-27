import type { DB } from "../index.js";

import * as m0001_0 from "./0001_core.js";
import * as m0002_1 from "./0002_integrations.js";
import * as m0003_2 from "./0003_sync.js";
import * as m0004_3 from "./0004_oauth_choice.js";
import * as m0005_4 from "./0005_plans.js";
import * as m0006_5 from "./0006_channels_and_grants.js";
import * as m0006_6 from "./0006_profiles_scoped_tokens.js";
import * as m0007_7 from "./0007_tasks_v2.js";
import * as m0008_8 from "./0008_message_features.js";
import * as m0009_9 from "./0009_schedules_watchers.js";
import * as m0010_10 from "./0010_event_dialect.js";
import * as m0011_11 from "./0011_neutral_sign_in.js";
import * as m0012_12 from "./0012_subscriptions.js";

export interface Migration {
  name: string;
  sql?: string;
  up?: (db: DB) => void;
  /** `false` runs the migration with foreign keys off (a table rebuild); `foreign_key_check` must pass before commit. */
  foreignKeys?: boolean;
}

/** Every core migration, in order. A static list so bundlers (Workers) include them. */
export const MIGRATIONS: Migration[] = [
  { name: "0001_core", ...m0001_0 },
  { name: "0002_integrations", ...m0002_1 },
  { name: "0003_sync", ...m0003_2 },
  { name: "0004_oauth_choice", ...m0004_3 },
  { name: "0005_plans", ...m0005_4 },
  { name: "0006_channels_and_grants", ...m0006_5 },
  { name: "0006_profiles_scoped_tokens", ...m0006_6 },
  { name: "0007_tasks_v2", ...m0007_7 },
  { name: "0008_message_features", ...m0008_8 },
  { name: "0009_schedules_watchers", ...m0009_9 },
  { name: "0010_event_dialect", ...m0010_10 },
  { name: "0011_neutral_sign_in", ...m0011_11 },
  { name: "0012_subscriptions", ...m0012_12 },
];
