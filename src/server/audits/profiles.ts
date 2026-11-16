import { getAppPolicy, readPolicyFile, type LoadedPolicy, type Policy } from "@/server/policy";
import { auditProfileSchema, type AuditProfile } from "@/server/policy/sections/audits";
import { policyForSpace } from "@/server/journals/policy";
import { getSpaceById } from "@/server/spaces/queries";
import { AuditRequestError } from "./errors";

/**
 * Audit profiles from policy. A space's policy is the app defaults overlaid
 * with its history repository's policy directory (the journals module's
 * policyForSpace, which also tells the reviewer which directories to read
 * prompts and schemas from). An audit keeps the profile it was created with
 * in audits.profile_snapshot; read it back with snapshotProfile.
 */

export interface ProfileOption {
  id: string;
  label: string;
  description: string;
  cohorts: { id: string; label: string }[];
  inputs: { kind: string; label: string; required: boolean }[];
  isDefault: boolean;
}

/** Loaded policy (with its digest and directories) for a space. */
export async function loadedPolicyForSpace(spaceId: string): Promise<LoadedPolicy> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new AuditRequestError("not-found", "The space is not registered.");
  return policyForSpace(space);
}

export function listProfiles(policy: Pick<Policy, "audits">): ProfileOption[] {
  const a = policy.audits;
  return Object.entries(a.profiles).map(([id, p]) => ({
    id,
    label: p.label,
    description: p.description,
    cohorts: p.cohorts.map((c) => ({ id: c.id, label: c.label })),
    inputs: p.inputs.map((i) => ({ kind: i.kind, label: i.label, required: i.required })),
    isDefault: id === a.defaultProfile,
  }));
}

export function getProfile(policy: Pick<Policy, "audits">, profileId: string | null | undefined): { id: string; profile: AuditProfile } {
  const id = profileId ?? policy.audits.defaultProfile;
  const profile = policy.audits.profiles[id];
  if (!profile) throw new AuditRequestError("invalid", `There is no audit profile "${id}" in this space's policy.`);
  return { id, profile };
}

/** The profile an audit was created with. Parsing fills defaults for fields added after the snapshot was taken. */
export function snapshotProfile(snapshot: unknown): AuditProfile {
  const parsed = auditProfileSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error("The audit's profile snapshot does not match the profile schema.");
  return parsed.data;
}

/** Label of a profile ID in the app policy, for lists; the snapshot's label wins when it parses. */
export function profileLabel(profileId: string, snapshot: unknown): string {
  const parsed = auditProfileSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data.label;
  return getAppPolicy().policy.audits.profiles[profileId]?.label ?? profileId;
}

/** Compile a policy regex. Policy is reviewed configuration, but a typo must give a clear error, not a crash. */
export function policyRegex(pattern: string, flags = "", what = "pattern"): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new AuditRequestError("invalid", `The profile's ${what} is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The capture a pattern names: group `name`, else group 1, else null. */
export function captureOf(m: RegExpExecArray | null, name: string): string | null {
  if (!m) return null;
  const v = m.groups?.[name] ?? m[1];
  return v === undefined ? null : v;
}

/** Incident ID from a captured number and the profile's template ("INCIDENT-{id}"). */
export function incidentIdFor(profile: Pick<AuditProfile, "incidentIdTemplate">, captured: string): string {
  return profile.incidentIdTemplate.replaceAll("{id}", captured);
}

/** The profile's output schema (JSON), read from the policy directories, or null when it is missing or not JSON. */
export function readOutputSchema(profile: Pick<AuditProfile, "review">, policyDirs: string[]): Record<string, unknown> | null {
  const text = readPolicyFile(policyDirs, profile.review.outputSchema);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
