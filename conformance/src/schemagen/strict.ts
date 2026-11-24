import type { z } from "zod";

/** Returns the first JSON path where `a` and `b` differ, or null when they are equal. */
export function firstDifference(a: unknown, b: unknown, path = "$"): string | null {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (ao[k] === undefined && bo[k] === undefined) continue;
    const d = firstDifference(ao[k], bo[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/**
 * Validates `value` with a zod schema and also rejects keys the schema does not
 * declare (zod strips unknown keys silently; fixtures and samples must not carry them).
 */
export function strictCheck(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (!result.success) {
    return result.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "$"}: ${i.message}`);
  }
  const diff = firstDifference(JSON.parse(JSON.stringify(result.data)), value);
  return diff ? [`${diff}: not declared by the schema (unknown key or transformed value)`] : [];
}
