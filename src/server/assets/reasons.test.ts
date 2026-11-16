import { describe, expect, it } from "vitest";
import { addReasonJob, ADD_REASON_QUEUE, jobs } from "./jobs";
import { addReasonRequest, canAddReason, formatReasonNote, parseReasonNotes, safeHttpUrl } from "./reasons";

const base = {
  spaceId: "6f1f7a1e-4a7b-4c11-9a51-2f0e6b6a9c10",
  assetId: "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b",
  commit: "a".repeat(40),
  reason: "v2 audit",
};

describe("addReasonRequest", () => {
  it("accepts a reason with an optional http(s) link and trims it", () => {
    expect(addReasonRequest.parse({ ...base, reason: "  v2 audit  ", link: "" })).toMatchObject({ reason: "v2 audit", link: null });
    expect(addReasonRequest.parse({ ...base, link: "https://example.com/report" }).link).toBe("https://example.com/report");
  });

  it("rejects empty or long reasons, other link schemes and malformed IDs", () => {
    expect(addReasonRequest.safeParse({ ...base, reason: "   " }).success).toBe(false);
    expect(addReasonRequest.safeParse({ ...base, reason: "x".repeat(2001) }).success).toBe(false);
    expect(addReasonRequest.safeParse({ ...base, link: "javascript:alert(1)" }).success).toBe(false);
    expect(addReasonRequest.safeParse({ ...base, link: "ftp://example.com/x" }).success).toBe(false);
    expect(addReasonRequest.safeParse({ ...base, commit: "HEAD" }).success).toBe(false);
    expect(addReasonRequest.safeParse({ ...base, assetId: "../etc" }).success).toBe(false);
  });
});

describe("reason notes", () => {
  const actor = { email: "alex@example.com" };
  const at = new Date("2026-11-11T10:00:00.000Z");

  it("round-trips a reason, including multiple lines and blank lines", () => {
    const note = formatReasonNote({ reason: "Turned off for the\n\nv2 audit", link: "https://example.com/r", reasonId: "11111111-1111-4111-8111-111111111111" }, actor, at);
    // git strips trailing whitespace from note lines
    const stored = note
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
    expect(parseReasonNotes(stored)).toEqual([
      { reason: "Turned off for the\n\nv2 audit", link: "https://example.com/r", addedBy: "alex@example.com", addedAt: at.toISOString(), raw: stored },
    ]);
  });

  it("splits appended notes and keeps notes written outside the app", () => {
    const a = formatReasonNote({ reason: "first", link: null, reasonId: "11111111-1111-4111-8111-111111111111" }, actor, at);
    const b = formatReasonNote({ reason: "second", link: null, reasonId: "22222222-2222-4222-8222-222222222222" }, actor, at);
    expect(parseReasonNotes(`${a}\n\n${b}`).map((n) => n.reason)).toEqual(["first", "second"]);
    expect(parseReasonNotes("hand-written note\n\nanother")).toMatchObject([{ reason: "hand-written note" }, { reason: "another" }]);
  });

  it("only links http and https URLs", () => {
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("accepts reasons only for changes made outside the app", () => {
    expect(canAddReason({ changeSource: "console" })).toBe(true);
    expect(canAddReason({ changeSource: "agent" })).toBe(true);
    expect(canAddReason({ changeSource: "app" })).toBe(false);
  });
});

describe("assets jobs", () => {
  it("defines assets.add-reason and lists it for the worker", () => {
    expect(ADD_REASON_QUEUE).toBe("assets.add-reason");
    expect(jobs.map((j) => j.name)).toEqual(["assets.add-reason"]);
    expect(addReasonJob.input.safeParse({ ...base, link: null }).success).toBe(false); // needs reasonId
    expect(addReasonJob.input.safeParse({ ...base, link: null, reasonId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
  });
});
