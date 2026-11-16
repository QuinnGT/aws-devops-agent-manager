import type { z } from "zod";
import type { incidentIdRuleSchema } from "@/server/spaces/settings-schema";

/**
 * Local incident ID matching for exports. It follows the same rule shape as
 * the shared extractIncidentId in src/server/spaces/incident-id.ts (a regex
 * plus the task field to search).
 */

export type IncidentIdRule = z.output<typeof incidentIdRuleSchema>;

interface TaskFields {
  title?: unknown;
  description?: unknown;
  reference?: unknown;
}

export function incidentFieldValue(task: TaskFields, field: IncidentIdRule["field"]): string | null {
  const pick = (v: unknown) => (typeof v === "string" ? v : null);
  switch (field) {
    case "title":
      return pick(task.title);
    case "description":
      return pick(task.description);
    case "reference.referenceId":
    case "reference.title": {
      const ref = task.reference;
      if (typeof ref !== "object" || ref === null) return null;
      return pick((ref as Record<string, unknown>)[field === "reference.referenceId" ? "referenceId" : "title"]);
    }
  }
}

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    try {
      regexCache.set(pattern, new RegExp(pattern));
    } catch {
      regexCache.set(pattern, null);
    }
  }
  return regexCache.get(pattern) ?? null;
}

/** Throws when the rule's regex does not compile, so an export fails with a clear message. */
export function assertValidRule(rule: IncidentIdRule): void {
  if (!compile(rule.regex)) throw new Error(`The incident ID rule's regex does not compile: ${rule.regex}`);
}

/** Named group `id`, else the first capture group, else the whole match. */
export function matchIncidentId(text: string | null | undefined, pattern: string): string | null {
  if (!text) return null;
  const re = compile(pattern);
  if (!re) return null;
  const m = re.exec(text);
  if (!m) return null;
  const id = m.groups?.id ?? m[1] ?? m[0];
  return id ? id.trim() || null : null;
}

export function extractIncidentIdLocal(task: TaskFields, rule: IncidentIdRule | null | undefined): string | null {
  if (!rule) return null;
  return matchIncidentId(incidentFieldValue(task, rule.field), rule.regex);
}
