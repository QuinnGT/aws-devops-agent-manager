import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { exportSections } from "./content";
import { checkExport } from "./gate";
import { renderReportHtml } from "./html";
import { markdownToSafeHtml } from "./markdown-html";
import { mdText, renderReportMarkdown, shiftHeadings } from "./report-md";
import { auditRecord, diagnosis, fix, item, viewInput } from "./test-support";
import type { ReportView } from "./types";
import { buildReportView, finalizeProblems, sectionsFor } from "./view";

const rules = getAppPolicy().policy.outputRules;
const at = new Date("2026-11-13T08:00:00.000Z");
const i1 = item(1);
const i2 = item(2);

function view(over: Parameters<typeof viewInput>[0] = {}): ReportView {
  return buildReportView(
    viewInput({
      items: [i1, i2],
      findings: [diagnosis(i1), diagnosis(i2, { primary_failure_mode: "E_symptom_stop" }), fix(i1, 0), fix(i2, 0, { owner: "aws_service", fix: "Return the summary." })],
      evidence: { "INCIDENT-1": { score: "2/5" }, "INCIDENT-2": { score: "1/5" } },
      analyzerRuns: { "task-1": { "run-metrics": { analyzer: "run-metrics", version: "1.0.0", output: { span_min: 12.5 }, createdAt: "2026-11-11T00:00:00.000Z" } } },
      audit: auditRecord({
        report: {
          builtAt: "2026-11-12T12:00:00.000Z",
          sections: [{ id: "summary", narrative: "The agent **missed** the cache tier in 2 of 2 investigations.", narrativeSource: "person" }],
        },
      }),
      ...over,
    }),
  );
}

describe("the report view", () => {
  it("has the profile's sections in order with audience, content and flags", () => {
    const v = view();
    expect(v.sections.map((s) => [s.id, s.audience, s.content.type])).toEqual([
      ["summary", "shareable", "narrative"],
      ["failure-modes", "shareable", "count-table"],
      ["reachability", "shareable", "count-table"],
      ["fixes-by-owner", "shareable", "count-table"],
      ["fixes", "shareable", "findings-table"],
      ["incidents", "shareable", "incident-list"],
      ["run-metrics", "internal", "metrics-table"],
      ["scorecard-fairness", "internal", "count-table"],
    ]);
    expect(v.sections[0]!.content).toEqual({
      type: "narrative",
      text: "The agent **missed** the cache tier in 2 of 2 investigations.",
      source: "person",
      canDraft: true,
      draftedAt: null,
      approved: null,
      needsApproval: false,
      draftedBeforeDecisions: false,
    });
    expect(v.stale).toBe(false);
    expect(v.counts).toMatchObject({ items: 2, findings: { accepted: 4, rejected: 0, proposed: 0 }, acceptedByKind: { diagnosis: 2, fix: 2 } });
    expect(v.finalize).toEqual({ allowed: true, problems: [], issues: [] });
    expect(v.readOnly).toBe(false);
  });

  it("is stale when findings or items changed after builtAt, and only narratives with text carry the flag", () => {
    const later = new Date("2026-11-12T12:00:01.000Z");
    const v = view({ inputsChangedAt: later, findings: [diagnosis(i1, {}, { updatedAt: later }), diagnosis(i2, {}, { updatedAt: new Date("2026-11-12T11:00:00.000Z") })] });
    expect(v.stale).toBe(true);
    expect(v.changedSinceBuilt).toBe(1);
    expect(v.sections.filter((s) => s.stale).map((s) => s.id)).toEqual(["summary"]);
    expect(view({ inputsChangedAt: new Date("2026-11-12T11:59:59.000Z") }).stale).toBe(false);
    // Never built: nothing to be stale against
    expect(view({ audit: auditRecord(), inputsChangedAt: new Date() }).stale).toBe(false);
  });

  it("shows who changed a section and the latest export per audience", () => {
    const v = view({
      audit: auditRecord({ report: { builtAt: at.toISOString(), sections: [{ id: "fixes", hidden: true, updatedBy: "alex@example.com", updatedAt: at.toISOString() }] } }),
      exports: [
        { at: "2026-11-12T10:00:00.000Z", actor: "a@example.com", audience: "shareable", result: "denied", fileName: null, ruleIds: ["unmasked-account-id"] },
        { at: "2026-11-12T11:00:00.000Z", actor: "b@example.com", audience: "shareable", result: "ok", fileName: "x.html", ruleIds: [] },
      ],
    });
    expect(v.sections.find((s) => s.id === "fixes")).toMatchObject({ hidden: true, updatedBy: "alex@example.com", updatedAt: at.toISOString() });
    expect(v.lastExports).toEqual({ internal: null, shareable: expect.objectContaining({ actor: "b@example.com", result: "ok" }) });
  });

  it("filters sections by audience and hidden flag", () => {
    const v = view({ audit: auditRecord({ report: { builtAt: at.toISOString(), sections: [{ id: "fixes", hidden: true }, { id: "summary", narrative: "Text", narrativeSource: "model" }] } }) });
    expect(sectionsFor(v, "shareable").map((s) => s.id)).toEqual(["summary", "failure-modes", "reachability", "fixes-by-owner", "incidents"]);
    expect(sectionsFor(v, "internal").map((s) => s.id)).toEqual(["summary", "failure-modes", "reachability", "fixes-by-owner", "incidents", "run-metrics", "scorecard-fairness"]);
    // An empty narrative is left out of an export
    const empty = view({ audit: auditRecord() });
    expect(exportSections(empty, "shareable")).toMatchObject({ omitted: [{ id: "summary", reason: "empty-narrative" }] });
  });

  it("says why an audit can't be finalized", () => {
    const pending = item(3, { state: "reviewing" });
    const failed = item(4, { state: "failed" });
    expect(finalizeProblems({ state: "reviewing" }, [i1, pending, failed], [diagnosis(i1, {}, { state: "proposed" }), diagnosis(item(5, { state: "skipped" }), {}, { state: "proposed" })])).toEqual([
      "2 investigations are not reviewed or skipped yet: INCIDENT-3, INCIDENT-4.",
      "1 finding is still proposed. Accept or reject each one first.",
    ]);
    expect(finalizeProblems({ state: "reviewing" }, [], [])).toEqual(["The audit has no investigations."]);
    expect(finalizeProblems({ state: "finalized" }, [i1], [])).toEqual(["The audit is already finalized."]);
    expect(finalizeProblems({ state: "cancelled" }, [i1], [])).toEqual(["The audit was cancelled."]);
    expect(finalizeProblems({ state: "reviewing" }, [i1, item(6, { state: "skipped" })], [diagnosis(i1, {}, { state: "rejected" })])).toEqual([]);
    expect(view({ audit: auditRecord({ state: "finalized" }) }).readOnly).toBe(true);
  });
});

describe("safe markdown for the export", () => {
  it("drops raw HTML, turns links into text and images into alt text, and moves headings down", () => {
    const html = markdownToSafeHtml('# Top\n\n<script>alert(1)</script>\n\n<img src="https://x.example/a.png" onerror="alert(1)">\n\nRead [the docs](https://evil.example/x "t") or https://evil.example/y ![chart](https://evil.example/c.png)\n\n[js](javascript:alert(1))', { headingOffset: 2 });
    expect(html).toContain("<h3>Top</h3>");
    expect(html).not.toMatch(/<script|<img|<a\b|href=|src=|onerror|javascript:/i);
    expect(html).toContain("Read the docs or https://evil.example/y chart");
  });

  it("keeps tables, lists and code, with only safe attributes", () => {
    const html = markdownToSafeHtml("| a | b |\n|:--|--:|\n| 1 | 2 |\n\n3. three\n\n- [x] done\n\n`x<y`");
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<li>[x] done</li>");
    expect(html).toContain("<code>x&lt;y</code>");
  });
});

describe("the HTML export", () => {
  const hostile = () =>
    view({
      findings: [
        diagnosis(i1, { one_line: '<script>alert("x")</script> and [click](https://evil.example/p)', ground_truth: "a & b <b>bold</b>" }),
        fix(i1, 0, { fix: "<img src=x onerror=alert(1)> fix" }),
      ],
      audit: auditRecord({
        report: { builtAt: at.toISOString(), sections: [{ id: "summary", narrative: "See [the dashboard](https://evil.example/d).\n\n<script>steal()</script>", narrativeSource: "model" }] },
      }),
    });

  it("is self-contained: no scripts, no external URLs or fonts, a CSP that blocks requests", () => {
    for (const audience of ["internal", "shareable"] as const) {
      const { html } = renderReportHtml(hostile(), audience, at);
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`);
      expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<a\b|url\(|@import|@font-face/i);
      // No tag carries a src, href or event handler attribute
      expect(html).not.toMatch(/<[a-z][^>]*\s(?:src|href|on\w+)=/i);
      // The only URLs are the finding's own text, escaped
      expect(html.match(/https?:\/\/[^\s<"]+/g) ?? []).toEqual(["https://evil.example/p)"]);
    }
  });

  it("escapes every value from findings", () => {
    const { html } = renderReportHtml(hostile(), "shareable", at);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; and [click](https://evil.example/p)");
    expect(html).toContain("a &amp; b &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; fix");
    expect(html).toContain("<p>See the dashboard.</p>");
    expect(html).not.toContain("steal()");
  });

  it("leaves internal and hidden sections out of the shareable export", () => {
    const v = view({ audit: auditRecord({ report: { builtAt: at.toISOString(), sections: [{ id: "summary", narrative: "Summary text", narrativeSource: "person" }, { id: "fixes", hidden: true }] } }) });
    const shareable = renderReportHtml(v, "shareable", at);
    expect(shareable.sections).toEqual(["summary", "failure-modes", "reachability", "fixes-by-owner", "incidents"]);
    expect(shareable.html).not.toMatch(/Run metrics|Scorecard fairness|Internal: do not share/);
    expect(shareable.html).not.toContain("<h2>Fixes</h2>");
    const internal = renderReportHtml(v, "internal", at);
    expect(internal.sections).toEqual(["summary", "failure-modes", "reachability", "fixes-by-owner", "incidents", "run-metrics", "scorecard-fairness"]);
    expect(internal.html).toContain("<h2>Run metrics</h2>");
    expect(internal.html).toContain('<p class="banner">Internal: do not share outside the team.</p>');
    expect(internal.html).toContain("<td>INCIDENT-2</td><td class=\"num\">No output</td>");
    expect(internal.html).toContain('<tfoot><tr><td>Median</td><td class="num">12.5</td>');
  });

  it("renders count tables with zero rows and a total", () => {
    const { html } = renderReportHtml(view(), "shareable", at);
    expect(html).toContain('<tr><td>Wrong component</td><td class="num">1</td></tr>');
    expect(html).toContain('<tr class="zero"><td>Evidence out of reach</td><td class="num">0</td></tr>');
    expect(html).toContain('<tfoot><tr><td>Total</td><td class="num">2</td></tr></tfoot>');
    expect(html).toContain("<h3>INCIDENT-1: Investigated the gateway instead of the cache.</h3><dl><dt>Score</dt><dd>2/5</dd>");
    expect(html).toContain("<title>Journal audit: Late October low scores</title>");
  });
});

describe("the output-rules gate", () => {
  it("refuses an export with an unmasked account ID and says where it is", () => {
    const v = view({ findings: [diagnosis(i1, { ground_truth: "Role arn:aws:iam::123456789012:role/x was denied." }), fix(i1, 0, { fix: "Use 111122223333 in examples." })] });
    const gate = checkExport(v, "shareable", rules, ["error"], at);
    expect(gate.blocking).toEqual([
      expect.objectContaining({
        ruleId: "unmasked-account-id",
        severity: "error",
        sectionId: "incidents",
        sectionTitle: "Incidents",
        location: "INCIDENT-1",
        incident: "INCIDENT-1",
        excerpt: expect.stringContaining("xxxxxxxx9012"),
      }),
    ]);
    expect(gate.blocking[0]!.excerpt).not.toContain("123456789012");
  });

  it("locates matches by paragraph and table row", () => {
    const v = view({
      findings: [diagnosis(i1), fix(i1, 0), fix(i2, 0, { fix: "Ask for 210987654321 access." })],
      audit: auditRecord({ report: { builtAt: at.toISOString(), sections: [{ id: "summary", narrative: "First paragraph.\n\nSecond with 123456789012.", narrativeSource: "person" }] } }),
    });
    const where = checkExport(v, "internal", rules, ["error"], at).blocking.map((x) => [x.sectionId, x.location, x.incident]);
    expect(where).toEqual([
      ["summary", "Paragraph 2", null],
      ["fixes", "Row 2", "INCIDENT-2"],
    ]);
  });

  it("checks only the sections the export includes", () => {
    const narrative = { builtAt: at.toISOString(), sections: [{ id: "summary", narrative: "Fine text.", narrativeSource: "person" as const }] };
    const v = view({
      audit: auditRecord({ report: narrative }),
      analyzerRuns: { "task-1": { "run-metrics": { analyzer: "run-metrics", version: "1", output: { span_min: 123456789012 }, createdAt: at.toISOString() } } },
    });
    expect(checkExport(v, "shareable", rules, ["error"], at).blocking).toEqual([]);
    expect(checkExport(v, "internal", rules, ["error"], at).blocking.map((x) => [x.ruleId, x.sectionId, x.location, x.incident])).toEqual([
      ["unmasked-account-id", "run-metrics", "Row 1", "INCIDENT-1"],
      ["unmasked-account-id", "run-metrics", "Median row", null],
    ]);
  });

  it("refuses dashes in narrative text, and blocks warnings only when the profile says so", () => {
    const v = view({ audit: auditRecord({ report: { builtAt: at.toISOString(), sections: [{ id: "summary", narrative: 'Most misses were fixable \u2014 see below. Policy had "Action": "*".', narrativeSource: "model" }] } }) });
    const gate = checkExport(v, "shareable", rules, ["error"], at);
    expect(gate.blocking.map((x) => [x.ruleId, x.sectionId, x.location])).toEqual([["report-dashes", "summary", "Paragraph 1"]]);
    expect(gate.warnings.map((x) => x.ruleId)).toEqual(["iam-wildcard"]);
    expect(checkExport(v, "shareable", rules, ["error", "warning"], at).blocking.map((x) => x.ruleId).sort()).toEqual(["iam-wildcard", "report-dashes"]);
  });
});

describe("report.md", () => {
  it("has the same sections as markdown tables and blocks", () => {
    const md = renderReportMarkdown(view(), "internal", at);
    expect(md.startsWith("# Journal audit: Late October low scores\n\nGenerated 2026-11-13.\n\n> Internal: do not share outside the team.\n\n## Summary\n\nThe agent **missed**")).toBe(true);
    expect(md).toContain("## Primary failure modes\n\n| Primary failure mode | Count |\n| --- | ---: |\n| Evidence out of reach | 0 |\n");
    expect(md).toContain("| Wrong component | 1 |\n| Stopped at the symptom | 1 |\n");
    expect(md).toContain("| Evidence out of reach | 0 |");
    expect(md).toContain("| Total | 2 |");
    expect(md).toContain("## Fixes\n\n| Incident | Owner | Fix |\n| --- | --- | --- |\n| INCIDENT-1 | Instruction and skill package | Check the cache tier before the gateway. |\n");
    expect(md).toContain("### INCIDENT-1: Investigated the gateway instead of the cache.\n\n- Score: 2/5\n- Primary failure mode: Wrong component\n");
    expect(md).toContain("## Run metrics (internal)\n\n| Incident | Run span (min) |");
    expect(md).toContain("| INCIDENT-2 | No output |");
    expect(md).toContain("| Median | 12.5 |");
    const shareable = renderReportMarkdown(view(), "shareable", at);
    expect(shareable).not.toMatch(/Run metrics|Scorecard fairness|Internal:/);
  });

  it("escapes finding text so it can't become a link, HTML or a broken table", () => {
    const md = renderReportMarkdown(view({ findings: [fix(i1, 0, { fix: "Run <script>x</script> | see [docs](https://evil.example) *now*\nnext" })] }), "internal", at);
    expect(md).toContain("| INCIDENT-1 | Instruction and skill package | Run \\<script\\>x\\</script\\> \\| see \\[docs\\](https://evil.example) \\*now\\* next |");
    expect(mdText("a_b & `c` ~d~")).toBe("a\\_b &amp; \\`c\\` \\~d\\~");
  });

  it("moves narrative headings below the section heading, outside code fences", () => {
    expect(shiftHeadings("# A\n```\n# not a heading\n```\n### B\n####### seven", 2)).toBe("### A\n```\n# not a heading\n```\n##### B\n####### seven");
    expect(shiftHeadings("##### deep", 2)).toBe("###### deep");
  });
});
