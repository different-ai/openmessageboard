import type { ServerInfo } from "@openmessageboard/protocol";
import type { CaseResult } from "./harness.ts";

export interface Report {
  runner: { name: string; version: string };
  spec_version: string;
  server: { url: string; implementation: ServerInfo["implementation"] | null; profiles_claimed: string[] };
  profiles_tested: string[];
  started_at: string;
  duration_ms: number;
  summary: { pass: number; fail: number; skip: number };
  results: CaseResult[];
}

const LABEL = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;

export function formatResult(r: CaseResult, verbose: boolean): string {
  const secs = (r.duration_ms / 1000).toFixed(1);
  const lines = [`${LABEL[r.status]}  ${r.id.padEnd(36)} ${r.title} (${secs} s)`];
  if (r.reason) lines.push(`      ${r.status === "fail" ? "reason" : "why"}: ${r.reason.replace(/\n/g, "\n      ")}`);
  if (verbose || r.status !== "pass") for (const n of r.notes) lines.push(`      note: ${n}`);
  return lines.join("\n");
}

/** Header, a recap of failures, and the counts (per-case lines are printed as cases finish). */
export function formatReport(report: Report): string {
  const out: string[] = [];
  const impl = report.server.implementation;
  out.push(`server: ${report.server.url}${impl ? ` (${impl.name} ${impl.version})` : ""}`);
  out.push(`claims: ${report.server.profiles_claimed.join(", ") || "unknown"} · tested: ${report.profiles_tested.join(", ")}`);
  const failed = report.results.filter((r) => r.status === "fail");
  if (failed.length) {
    out.push("", "Failures:");
    for (const r of failed) out.push(`  ${r.id}: ${(r.reason ?? "").split("\n")[0]}`);
  }
  const s = report.summary;
  out.push("", `${s.pass} passed, ${s.fail} failed, ${s.skip} skipped in ${(report.duration_ms / 1000).toFixed(1)} s`);
  return out.join("\n");
}
