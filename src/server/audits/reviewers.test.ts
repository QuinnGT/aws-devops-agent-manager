import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { benchmarkProfile } from "@/server/review/test-support";
import { defaultRunner, listReviewers, modelsForRunner, resolveReviewer, reviewerView, startingOptions, withReviewer } from "./reviewers";

const { policy } = getAppPolicy();
const profile = benchmarkProfile();
const settings = { inference: { mode: "space" as const, region: null, reviewModelId: "space-review", reportModelId: "space-report" } };

/** The shipped policy with a different `reviewers` block. */
const withReviewers = (reviewers: Record<string, unknown>) => ({ audits: { ...policy.audits, reviewers } }) as unknown as typeof policy;

describe("listReviewers", () => {
  it("lists the runners the policy offers, with their labels and options", () => {
    const list = listReviewers(policy);
    expect(list.map((r) => r.id)).toEqual(["ai-sdk", "handoff", "devops-agent-chat"]);
    expect(list[1]).toMatchObject({ label: "Review files", options: [] });
    const chat = list[2]!;
    expect(chat.options).toHaveLength(1);
    expect(chat.options[0]).toMatchObject({ id: "modelTier", default: "smart" });
    expect(chat.options[0]!.values.map((v) => v.id)).toEqual(["smart", "balanced", "fast"]);
  });

  it("leaves out a runner the policy does not list", () => {
    const only = withReviewers({ handoff: { label: "Files", description: "", options: {} } });
    expect(listReviewers(only).map((r) => r.id)).toEqual(["handoff"]);
  });
});

describe("resolveReviewer", () => {
  it("starts from the profile's runner and the policy's option defaults", () => {
    expect(resolveReviewer(policy, profile)).toEqual({ runner: "ai-sdk", runnerOptions: {} });
    expect(resolveReviewer(policy, profile, { runner: "devops-agent-chat" })).toEqual({ runner: "devops-agent-chat", runnerOptions: { modelTier: "smart" } });
    expect(resolveReviewer(policy, profile, { runner: "handoff", runnerOptions: null })).toEqual({ runner: "handoff", runnerOptions: {} });
  });

  it("takes a chosen option value and fills the rest with defaults", () => {
    expect(resolveReviewer(policy, profile, { runner: "devops-agent-chat", runnerOptions: { modelTier: "fast" } }).runnerOptions).toEqual({ modelTier: "fast" });
  });

  it("starts an option at the profile's own value when it is one of the values", () => {
    const p = { review: { ...profile.review, runner: "devops-agent-chat" as const, runnerOptions: { modelTier: "balanced" } } };
    expect(resolveReviewer(policy, p)).toEqual({ runner: "devops-agent-chat", runnerOptions: { modelTier: "balanced" } });
    const bad = { review: { ...p.review, runnerOptions: { modelTier: "nope" } } };
    expect(resolveReviewer(policy, bad).runnerOptions).toEqual({ modelTier: "smart" });
    expect(startingOptions(listReviewers(policy)[2]!, p)).toEqual({ modelTier: "balanced" });
  });

  it("refuses a runner the policy does not offer", () => {
    expect(() => resolveReviewer(policy, profile, { runner: "claude-agent-sdk" })).toThrow('The reviewer "claude-agent-sdk" is not offered');
    const only = withReviewers({ handoff: { label: "Files", description: "", options: {} } });
    expect(() => resolveReviewer(only, profile, { runner: "ai-sdk" })).toThrow("not offered");
  });

  it("refuses an option the runner does not have, and a value that is not one of its values", () => {
    expect(() => resolveReviewer(policy, profile, { runner: "handoff", runnerOptions: { modelTier: "smart" } })).toThrow('Review files has no option "modelTier"');
    expect(() => resolveReviewer(policy, profile, { runner: "devops-agent-chat", runnerOptions: { modelTier: "turbo" } })).toThrow('"turbo" is not a choice for Model tier. Choose Smart, Balanced, Fast.');
    expect(() => resolveReviewer(policy, profile, { runner: "devops-agent-chat", runnerOptions: { constructor: "x" } })).toThrow("has no option");
  });

  it("falls back to the first runner offered when the profile's own is not offered", () => {
    const only = withReviewers({ handoff: { label: "Files", description: "", options: {} } });
    expect(defaultRunner(listReviewers(only), profile)).toBe("handoff");
    expect(resolveReviewer(only, profile).runner).toBe("handoff");
  });

  it("keeps the profile's runner and takes no options when the policy offers none", () => {
    const none = withReviewers({});
    expect(resolveReviewer(none, profile)).toEqual({ runner: "ai-sdk", runnerOptions: {} });
    expect(() => resolveReviewer(none, profile, { runner: "handoff" })).toThrow("not offered");
    expect(() => resolveReviewer(none, profile, { runnerOptions: { a: "b" } })).toThrow("offers no reviewer options");
  });

  it("writes the choice into the profile", () => {
    const p = withReviewer(profile, { runner: "handoff", runnerOptions: {} });
    expect(p.review).toMatchObject({ runner: "handoff", runnerOptions: {} });
    expect(profile.review.runner).toBe("ai-sdk");
  });
});

describe("modelsForRunner", () => {
  it("resolves both models for the Bedrock runner", () => {
    const m = modelsForRunner("ai-sdk", profile, settings, { reviewModelId: "audit-review" });
    expect(m.review).toEqual({ id: "audit-review", source: "audit" });
    expect(m.report).toEqual({ id: "space-report", source: "space" });
  });

  it("gives no review model to another runner, and no report model unless one is set", () => {
    const p = { ...profile, review: { ...profile.review, modelId: "policy-review" } };
    const none = modelsForRunner("handoff", p, { inference: { ...settings.inference, reportModelId: null } }, { reviewModelId: "typed" });
    expect(none).toEqual({ review: { id: null, source: null }, report: { id: null, source: null } });
    const set = modelsForRunner("devops-agent-chat", p, settings, { reportModelId: "audit-report" });
    expect(set.review).toEqual({ id: null, source: null });
    expect(set.report).toEqual({ id: "audit-report", source: "audit" });
  });
});

describe("reviewerView", () => {
  it("names the runner and its options from the policy", () => {
    expect(reviewerView(policy, { runner: "devops-agent-chat", runnerOptions: { modelTier: "fast" } })).toEqual({
      runner: "devops-agent-chat",
      label: "DevOps Agent chat",
      options: [{ id: "modelTier", label: "Model tier", valueLabel: "Fast" }],
    });
    expect(reviewerView(policy, { runner: "handoff" })).toMatchObject({ label: "Review files", options: [] });
  });

  it("shows an ID the policy no longer offers as it is", () => {
    expect(reviewerView(withReviewers({}), { runner: "handoff", runnerOptions: { x: "y" } })).toEqual({ runner: "handoff", label: "handoff", options: [{ id: "x", label: "x", valueLabel: "y" }] });
  });
});

describe("handoff policy", () => {
  it("has limits and a README path", () => {
    const h = policy.audits.handoff;
    expect(h.readme).toBe("prompts/handoff-readme.md");
    expect(h.import).toMatchObject({ maxUploadBytes: 26214400, maxZipEntries: 2000, maxReviewBytes: 2097152, maxLabelChars: 80 });
    expect(h.import.maxEntryBytes).toBeGreaterThan(h.import.maxReviewBytes);
  });
});
