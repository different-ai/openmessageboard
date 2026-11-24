import type { CaseDef } from "../harness.ts";
import { automationCases, filterCases } from "./automation.ts";
import { channelCases } from "./channels.ts";
import { coreAccessCases } from "./core-access.ts";
import { contractCase, coreConversationCases } from "./core-conversation.ts";
import { eventCases } from "./events.ts";
import { liveCases } from "./live.ts";
import { otherCases } from "./other.ts";
import { profileCases } from "./profiles.ts";
import { taskCases } from "./tasks.ts";

/** Every case in run order. The slow expiry scenario (live/events access-ends) runs last. */
export const ALL_CASES: CaseDef[] = [
  ...coreAccessCases,
  ...coreConversationCases,
  ...profileCases,
  ...filterCases,
  ...taskCases,
  ...channelCases,
  ...liveCases.filter((c) => c.id !== "live.access-ends"),
  ...eventCases.filter((c) => c.id !== "events.webhook-terminated"),
  ...automationCases,
  ...otherCases,
  ...liveCases.filter((c) => c.id === "live.access-ends"),
  ...eventCases.filter((c) => c.id === "events.webhook-terminated"),
  contractCase,
];
