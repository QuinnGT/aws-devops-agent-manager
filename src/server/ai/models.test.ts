import { describe, expect, it } from "vitest";
import { isModelId, resolveAuditModels } from "./models";

const profile = (review?: string, report?: string) => ({ review: { modelId: review }, report: { modelId: report } }) as unknown as Parameters<typeof resolveAuditModels>[0];
const settings = (review: string | null, report: string | null = null) => ({ inference: { mode: "space" as const, region: null, reviewModelId: review, reportModelId: report } });

describe("resolveAuditModels", () => {
  it("has no model when nothing is chosen", () => {
    expect(resolveAuditModels(profile(), settings(null))).toEqual({ review: { id: null, source: null }, report: { id: null, source: null } });
  });

  it("prefers the audit's choice, then the space default, then policy", () => {
    expect(resolveAuditModels(profile("p"), settings("s"), { reviewModelId: "a" }).review).toEqual({ id: "a", source: "audit" });
    expect(resolveAuditModels(profile("p"), settings("s")).review).toEqual({ id: "s", source: "space" });
    expect(resolveAuditModels(profile("p"), settings(null)).review).toEqual({ id: "p", source: "policy" });
    expect(resolveAuditModels(profile("p"), settings(null), { reviewModelId: "" }).review).toEqual({ id: "p", source: "policy" });
  });

  it("uses the review model for the report unless a report model is set", () => {
    expect(resolveAuditModels(profile(), settings("s")).report).toEqual({ id: "s", source: "review-model" });
    expect(resolveAuditModels(profile(undefined, "pr"), settings("s")).report).toEqual({ id: "pr", source: "policy" });
    expect(resolveAuditModels(profile(), settings("s", "sr")).report).toEqual({ id: "sr", source: "space" });
    expect(resolveAuditModels(profile(), settings("s", "sr"), { reportModelId: "ar" }).report).toEqual({ id: "ar", source: "audit" });
  });
});

describe("isModelId", () => {
  it("accepts model IDs, inference profile IDs and ARNs", () => {
    expect(isModelId("us.anthropic.example-model-v1:0")).toBe(true);
    expect(isModelId("arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.example")).toBe(true);
    expect(isModelId("")).toBe(false);
    expect(isModelId("a b")).toBe(false);
    expect(isModelId("x;rm")).toBe(false);
  });
});
