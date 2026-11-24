import type { SyncPlatform } from "@openmessageboard/protocol";
import { github } from "./github.js";
import { linear } from "./linear.js";
import { slack } from "./slack.js";
import type { SyncAdapter } from "./types.js";

export const ADAPTERS: Record<SyncPlatform, SyncAdapter> = { slack, github, linear };
