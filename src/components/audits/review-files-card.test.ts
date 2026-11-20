import { describe, expect, it } from "vitest";
import type { ImportResult } from "@/server/audits/handoff-import";
import { resultText } from "./review-files-card";

const imported: ImportResult = { path: "r.zip: INCIDENT-1/review.json", incidentId: "INCIDENT-1", itemId: "i1", status: "imported", reason: null, note: null, findings: 4, carried: 0, replaced: false, citations: { checked: 9, failed: 0 } };

describe("import results", () => {
  it("says what an imported review became", () => {
    expect(resultText(imported)).toEqual({ tone: "success", title: "INCIDENT-1: imported, 4 findings", body: null });
  });

  it("says when a review replaced one and kept decisions", () => {
    expect(resultText({ ...imported, replaced: true, carried: 2 }).title).toBe("INCIDENT-1: imported, 4 findings, replaced the earlier review, 2 decisions kept");
    expect(resultText({ ...imported, replaced: true }).title).toBe("INCIDENT-1: imported, 4 findings, replaced the earlier review");
  });

  it("warns about failed citations and passes on a note", () => {
    const r = resultText({ ...imported, citations: { checked: 9, failed: 2 }, note: "No manifest.json came with this review." });
    expect(r.tone).toBe("warning");
    expect(r.body).toBe("2 citations failed the check, and the findings that rely on them are flagged for a person to read. No manifest.json came with this review.");
  });

  it("gives the reason a review was refused", () => {
    const refused: ImportResult = { ...imported, status: "refused", reason: "The journal changed after these review files were made.", findings: 0, citations: null };
    expect(resultText(refused)).toEqual({ tone: "destructive", title: "INCIDENT-1: refused", body: "The journal changed after these review files were made." });
    expect(resultText({ ...refused, incidentId: null, path: "evil.zip" }).title).toBe("evil.zip: refused");
  });
});
