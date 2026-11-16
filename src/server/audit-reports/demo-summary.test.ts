import { describe, expect, it } from "vitest";
import { checkOutputText } from "@/server/analyzers/output-rules";
import { getAppPolicy } from "@/server/policy";
import { shortTitle, summaryFromView } from "./demo-summary";
import { auditRecord, benchmarkProfile, diagnosis, fix, item, viewInput } from "./test-support";
import { buildReportView } from "./view";

/** The demo seed's stand-in for the model writes from one audit's own report only. */

const i1 = item(1);
const i2 = item(2);

function audit(name: string, fixes: Parameters<typeof fix>[2][], hidden: string[] = []) {
  return buildReportView(
    viewInput({
      items: [i1, i2],
      findings: [
        diagnosis(i1),
        diagnosis(i2, { primary_failure_mode: "F_premature_ruleout", reachability: "out_of_reach" }),
        ...fixes.map((f, n) => fix(n % 2 ? i2 : i1, n, f)),
        fix(i2, 9, { fix: "A rejected fix about 401 and 403 responses." }, { state: "rejected" }),
      ],
      audit: auditRecord({ name, report: { builtAt: "2026-11-12T12:00:00.000Z", sections: hidden.map((id) => ({ id, hidden: true })) } }),
    }),
  );
}

describe("summaryFromView", () => {
  it("states this audit's counts and the titles of its accepted fixes, with owner labels", () => {
    const text = summaryFromView(
      audit("Late October, all decided", [
        { owner: "instructions", fix: "Add a fast-fail 5xx rule to the incident RCA instructions. Then cite the record." },
        { owner: "customer_memory", fix: "Record the cart-page memory." },
      ]),
    );
    expect(text).toContain('The audit "Late October, all decided" reviewed 2 investigations, and a person accepted 4 findings.');
    expect(text).toContain("- Primary failure modes: Ruled out too early (1), Wrong component (1).");
    expect(text).toContain("- Fixes by owner: Customer memory or runbook content (1), Instruction and skill package (1).");
    expect(text).toContain("- Customer memory or runbook content, INCIDENT-2: Record the cart-page memory.");
    // The first sentence of the fix, grouped by owner label
    expect(text).toContain("- Instruction and skill package, INCIDENT-1: Add a fast-fail 5xx rule to the incident RCA instructions.");
    expect(text).not.toContain("Then cite the record.");
    expect(text).toContain("Incidents in this report: INCIDENT-1 and INCIDENT-2.");
    // Rejected fixes and owner IDs never appear
    expect(text).not.toMatch(/401|customer_memory|instructions,/);
  });

  it("writes a different summary for an audit with other fixes", () => {
    const a = summaryFromView(audit("A", [{ owner: "instructions", fix: "Fix about fast-fail 5xx." }]));
    const b = summaryFromView(audit("B", [{ owner: "aws_service", fix: "Fix about the caller identity check." }]));
    expect(a).toContain("fast-fail 5xx");
    expect(a).not.toContain("caller identity");
    expect(b).toContain("caller identity");
    expect(b).not.toContain("fast-fail");
  });

  it("reads only shown, shareable sections", () => {
    const text = summaryFromView(audit("Hidden fixes", [{ owner: "instructions", fix: "Secret fix." }], ["fixes", "fixes-by-owner"]));
    expect(text).not.toContain("Secret fix.");
    expect(text).not.toMatch(/Run metrics|Scorecard/);
  });

  it("keeps to the profile's narrative limit and the report's output rules", () => {
    const many = Array.from({ length: 30 }, (_, n) => ({ owner: "customer_access", fix: `Grant read access to data source ${n} so the agent can query it during the run, and record which role it uses in the memory index.` }));
    const v = audit("Many fixes", many);
    const text = summaryFromView(v);
    expect(text).toContain("- And 18 more in the table below.");
    expect(text.length).toBeLessThan(benchmarkProfile().report.narrativeMaxChars);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(checkOutputText(text, getAppPolicy().policy.outputRules, "report").filter((x) => x.severity === "error")).toEqual([]);
  });
});

describe("shortTitle", () => {
  it("keeps the first sentence and cuts a long one at a word", () => {
    expect(shortTitle("One. Two.")).toBe("One.");
    const long = `${"word ".repeat(60)}end`;
    const s = shortTitle(long);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(161);
    expect(s).not.toMatch(/ …$/);
  });
});
