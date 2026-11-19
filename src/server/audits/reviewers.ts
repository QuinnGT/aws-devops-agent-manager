import { resolveAuditModels, type AuditModelChoice } from "@/server/ai/models";
import type { Policy } from "@/server/policy";
import { REVIEW_RUNNERS, type AuditProfile, type ReviewRunner } from "@/server/policy/sections/audits";
import type { SpaceSettings } from "@/server/spaces/settings-schema";
import { AuditRequestError } from "./errors";

/**
 * Who writes an audit's reviews. Pure.
 *
 * The audit form offers the runners in `policy.audits.reviewers`, each with its
 * label, description and options; every label, value and default comes from
 * that policy. The audit's choice is written into its profile snapshot as
 * `review.runner` and `review.runnerOptions`, so a later policy change does not
 * change a started audit. A runner left out of policy is not offered, and the
 * server refuses it.
 */

export interface ReviewerOption {
  id: string;
  label: string;
  description: string;
  default: string;
  values: { id: string; label: string; description: string }[];
}

export interface ReviewerEntry {
  id: ReviewRunner;
  label: string;
  description: string;
  options: ReviewerOption[];
}

/** The runners the policy offers, in the order of REVIEW_RUNNERS. */
export function listReviewers(policy: Pick<Policy, "audits">): ReviewerEntry[] {
  const out: ReviewerEntry[] = [];
  for (const id of REVIEW_RUNNERS) {
    const e = policy.audits.reviewers[id];
    if (!e) continue;
    out.push({
      id,
      label: e.label,
      description: e.description,
      options: Object.entries(e.options).map(([oid, o]) => ({
        id: oid,
        label: o.label,
        description: o.description,
        default: o.default,
        values: o.values.map((v) => ({ id: v.id, label: v.label, description: v.description })),
      })),
    });
  }
  return out;
}

/** The runner a new audit starts with: the profile's default when it is offered, else the first one offered. */
export function defaultRunner(offered: readonly ReviewerEntry[], profile: Pick<AuditProfile, "review">): ReviewRunner {
  const wanted = profile.review.runner;
  if (!offered.length || offered.some((o) => o.id === wanted)) return wanted;
  return offered[0]!.id;
}

/** The value an option starts with: the profile's own setting when it is one of the values, else the policy's default. */
function startingValue(option: ReviewerOption, profile: Pick<AuditProfile, "review">): string {
  const preset = profile.review.runnerOptions?.[option.id];
  return preset !== undefined && option.values.some((v) => v.id === preset) ? preset : option.default;
}

/** The option values a runner starts with, for the form's preselection. */
export function startingOptions(entry: ReviewerEntry, profile: Pick<AuditProfile, "review">): Record<string, string> {
  return Object.fromEntries(entry.options.map((o) => [o.id, startingValue(o, profile)]));
}

export interface ReviewerChoice {
  runner?: string | null;
  runnerOptions?: Record<string, string> | null;
}

export interface ResolvedReviewer {
  runner: ReviewRunner;
  /** Every option of the runner, chosen or default */
  runnerOptions: Record<string, string>;
}

/**
 * The runner and option values for an audit, checked against policy. The
 * request is untrusted: the runner must be offered, an option must be one the
 * runner has, and its value one of that option's values. Options left out take
 * their default. Throws AuditRequestError("invalid").
 */
export function resolveReviewer(policy: Pick<Policy, "audits">, profile: Pick<AuditProfile, "review">, choice: ReviewerChoice = {}): ResolvedReviewer {
  const offered = listReviewers(policy);
  const runner = (choice.runner?.trim() || defaultRunner(offered, profile)) as ReviewRunner;
  const given = Object.entries(choice.runnerOptions ?? {});
  if (!offered.length) {
    // Nothing is offered, so the profile's own runner stands and takes no options.
    if (runner !== profile.review.runner) throw new AuditRequestError("invalid", `The reviewer "${runner}" is not offered in this space's policy.`);
    if (given.length) throw new AuditRequestError("invalid", "This space's policy offers no reviewer options.");
    return { runner, runnerOptions: { ...(profile.review.runnerOptions ?? {}) } };
  }
  const entry = offered.find((o) => o.id === runner);
  if (!entry) throw new AuditRequestError("invalid", `The reviewer "${runner}" is not offered in this space's policy.`);
  for (const [key, value] of given) {
    const option = entry.options.find((o) => o.id === key);
    if (!option) throw new AuditRequestError("invalid", `${entry.label} has no option "${key}".`);
    if (!option.values.some((v) => v.id === value)) {
      throw new AuditRequestError("invalid", `"${value}" is not a choice for ${option.label}. Choose ${option.values.map((v) => v.label).join(", ")}.`);
    }
  }
  const chosen = Object.fromEntries(given);
  return { runner, runnerOptions: Object.fromEntries(entry.options.map((o) => [o.id, chosen[o.id] ?? startingValue(o, profile)])) };
}

/** The profile with the audit's reviewer written in, as stored in audits.profile_snapshot. */
export function withReviewer(profile: AuditProfile, r: ResolvedReviewer): AuditProfile {
  return { ...profile, review: { ...profile.review, runner: r.runner, runnerOptions: r.runnerOptions } };
}

/**
 * The review and report models for an audit. Only the Bedrock runner reviews
 * with a model, so for the others the space and policy review models are left
 * out: the report model then comes from the audit's own choice, the space's
 * report default or the policy's, and is empty when none is set.
 */
export function modelsForRunner(
  runner: string,
  profile: Pick<AuditProfile, "review" | "report">,
  settings: Pick<SpaceSettings, "inference"> | null | undefined,
  choice: AuditModelChoice,
): ReturnType<typeof resolveAuditModels> {
  if (runner === "ai-sdk") return resolveAuditModels(profile, settings, choice);
  const noReviewModel = { ...profile, review: { ...profile.review, modelId: undefined } };
  const spaceSettings = settings ? { ...settings, inference: { ...settings.inference, reviewModelId: null } } : settings;
  return resolveAuditModels(noReviewModel, spaceSettings, { reportModelId: choice.reportModelId });
}

export interface ReviewerView {
  runner: string;
  /** The policy's label, or the runner ID when the policy no longer offers it */
  label: string;
  /** One line per option: "Model tier: Smart" */
  options: { id: string; label: string; valueLabel: string }[];
}

/** An audit's reviewer in words, for the audit page. Labels come from the policy now; an ID the policy dropped is shown as it is. */
export function reviewerView(policy: Pick<Policy, "audits">, review: Pick<AuditProfile["review"], "runner" | "runnerOptions">): ReviewerView {
  const entry = listReviewers(policy).find((e) => e.id === review.runner);
  const options = Object.entries(review.runnerOptions ?? {}).map(([id, value]) => {
    const option = entry?.options.find((o) => o.id === id);
    return { id, label: option?.label ?? id, valueLabel: option?.values.find((v) => v.id === value)?.label ?? value };
  });
  return { runner: review.runner, label: entry?.label ?? review.runner, options };
}
