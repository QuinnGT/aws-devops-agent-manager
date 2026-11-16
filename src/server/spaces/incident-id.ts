import type { IncidentIdRule } from "./settings-schema";

/**
 * Incident ID extraction: the incident ID rule is a per-space regex plus the
 * task field it reads.
 * Pure and dependency-free so it runs on the server and in the settings
 * page's live tester. Other modules import extractIncidentId.
 */

export type { IncidentIdRule } from "./settings-schema";

/** The task fields a rule can read. Accepts StoredTask, an API Task, or a sample. */
export interface IncidentIdTaskFields {
  title?: string | null;
  description?: string | null;
  /** Task reference: { referenceId, title, ... }, or the same object as a JSON string */
  reference?: unknown;
}

/** Longest pattern an Admin may save. */
export const MAX_INCIDENT_REGEX_LENGTH = 500;
/** Only this much of a field is searched, to bound regex run time on long descriptions. */
export const MAX_INCIDENT_FIELD_LENGTH = 10_000;

const compiled = new Map<string, RegExp | null>();

/** Compile a rule's pattern, or return the reason it can't be used. */
export function compileIncidentRegex(pattern: string): { ok: true; regex: RegExp } | { ok: false; error: string } {
  if (pattern.length === 0) return { ok: false, error: "Enter a pattern." };
  if (pattern.length > MAX_INCIDENT_REGEX_LENGTH) {
    return { ok: false, error: `Use at most ${MAX_INCIDENT_REGEX_LENGTH} characters.` };
  }
  try {
    return { ok: true, regex: new RegExp(pattern) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The pattern is not a valid regular expression." };
  }
}

function cachedRegex(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern) ?? null;
  const c = compileIncidentRegex(pattern);
  const re = c.ok ? c.regex : null;
  if (compiled.size > 100) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

function referenceObject(reference: unknown): Record<string, unknown> | null {
  let r = reference;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  return typeof r === "object" && r !== null && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
}

/** The text a rule searches, or null when the task has no value in that field. */
export function incidentFieldValue(field: IncidentIdRule["field"], task: IncidentIdTaskFields): string | null {
  let v: unknown;
  switch (field) {
    case "title":
      v = task.title;
      break;
    case "description":
      v = task.description;
      break;
    case "reference.referenceId":
      v = referenceObject(task.reference)?.referenceId;
      break;
    case "reference.title":
      v = referenceObject(task.reference)?.title;
      break;
  }
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_INCIDENT_FIELD_LENGTH) : null;
}

/**
 * Extract the incident ID from a task with a space's rule.
 *
 * The ID is the named group `id` when the pattern has one, otherwise the first
 * capture group, otherwise (a pattern with no groups) the whole match. Returns
 * null when there is no rule, the pattern doesn't compile, the field is empty,
 * nothing matches, or the chosen group is empty.
 */
export function extractIncidentId(rule: IncidentIdRule | null | undefined, task: IncidentIdTaskFields): string | null {
  if (!rule) return null;
  const re = cachedRegex(rule.regex);
  if (!re) return null;
  const value = incidentFieldValue(rule.field, task);
  if (value === null) return null;
  re.lastIndex = 0;
  const m = re.exec(value);
  if (!m) return null;
  let id: string | undefined;
  if (m.groups && "id" in m.groups) id = m.groups.id;
  else if (m.length > 1) id = m[1];
  else id = m[0];
  const t = id?.trim();
  return t ? t : null;
}
