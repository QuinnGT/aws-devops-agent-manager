import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_RUNS_DIR } from "../../../test/helpers/fixtures";
import { env } from "@/server/env";
import { getAppPolicy } from "@/server/policy";
import { loadPolicyFromDirs } from "@/server/policy/loader";
import { outputRulesSection } from "@/server/policy/sections/output-rules";
import { cap, condensedTrace } from "./condensed-trace";
import { bodyLines, deployedVsRead } from "./deployed-vs-read";
import { classifyIndex, memoryReads, type MemoryReadsSettings } from "./memory-reads";
import { normalizeBundle, pySplitLines } from "./normalize";
import { checkAgentOutput, checkOutputText } from "./output-rules";
import { pyRegex, pyRound } from "./py";
import { ANALYZER_IDS, JOURNAL_ONLY_ANALYZERS, bundleDigest, canonicalJson, runAnalyzers } from "./registry";
import { runMetrics } from "./run-metrics";
import { apiFixtureBundle, markdownBundle } from "./testing";

const policy = () => getAppPolicy().policy;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("Python compatibility helpers", () => {
  it("rounds like Python's round(x, 1), ties to even on the exact value", () => {
    expect(pyRound(0.25, 1)).toBe(0.2);
    expect(pyRound(0.75, 1)).toBe(0.8);
    expect(pyRound(0.35, 1)).toBe(0.3); // 0.35 is stored as 0.34999...
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(34.416666, 1)).toBe(34.4);
    expect(pyRound(-0.25, 1)).toBe(-0.2);
  });

  it("treats Unicode letters as word characters for \\b, as Python does", () => {
    expect(pyRegex(String.raw`\b401\b`).test("é401")).toBe(false);
    expect(/\b401\b/.test("é401")).toBe(true);
    expect(pyRegex(String.raw`\b401\b`).test("status 401 returned")).toBe(true);
  });

  it("splits lines on the same boundaries as str.splitlines()", () => {
    expect(pySplitLines("a\nb\u2028c\r\nd\n")).toEqual(["a", "b", "c", "d"]);
    expect(pySplitLines("")).toEqual([]);
  });
});

describe("normalizeBundle on API records", () => {
  const b = normalizeBundle(apiFixtureBundle());

  it("reads message blocks into text, thinking, tool calls and results", () => {
    expect(b.records).toHaveLength(113);
    expect(b.rootExecutionId).toBe("dd57cf48-883b-4f78-bc32-5ad9de66e225");
    const first = b.records[0]!;
    expect(first).toMatchObject({ n: 1, isMessage: true, role: "user", structured: true, hasText: true });
    expect(first.text).toContain("chat-tool-use-best-practices");
    const calls = b.records.flatMap((r) => r.toolUses);
    expect(calls).toHaveLength(50);
    expect(calls[0]).toMatchObject({ name: "fs_read", inputComplete: true });
    const results = b.records.flatMap((r) => r.toolResults);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(b.records.filter((r) => r.thinking.length).length).toBeGreaterThan(0);
  });

  it("keeps utilization JSON as data", () => {
    const u = b.records.find((r) => r.recordType === "utilization")!;
    expect(u.isMessage).toBe(false);
    expect((u.data as { data: { context_window: { utilization: number } } }).data.context_window.utilization).toBe(1.6);
  });
});

describe("run metrics", () => {
  it("computes the run metrics for an API journal", () => {
    const m = runMetrics(normalizeBundle(apiFixtureBundle()));
    expect(m).toMatchObject({
      incident: "fb2f686b-612c-498c-8dc9-f1b7f1b84df1",
      execution: "dd57cf48-883b-4f78-bc32-5ad9de66e225",
      records_header: null,
      records_parsed: 113,
      start_utc: "2026-10-23T18:28:33.057Z",
      end_utc: "2026-10-23T18:39:13.171Z",
      span_min: 10.7,
      first_summary_min: null,
      n_inv_summaries: 0,
      max_ctx_pct: 10.7,
      max_compactions: 0,
    });
    expect(m.types).toEqual({ message: 62, utilization: 51 });
    expect(m.tools.fs_read).toBeGreaterThan(0);
    expect(m.subagents).toContain("analyze-privatelink-setup");
    expect(m.summary.calls).toBe(50);
    expect(m.summary.tool_calls_by_name).toMatchObject({ fs_read: 21, subagent: 10, subagent_wait: 9 });
    expect(m.summary.mem_reads).toBe(21);
    expect(m.summary.subagent_calls).toBe(10);
    expect(m.summary.unstructured_messages).toBe(0);
    expect(m.summary.tool_errors).toBe(0);
    expect(m.summary.model_min + m.summary.tool_min + m.summary.subwait_min).toBeCloseTo(m.summary.dur_min, 0);
  });

  it("finds the prompt, CMDB section, summaries and error classes in an imported journal", () => {
    const text = `# INCIDENT-7 — Full DevOps Agent Investigation Journal

_Execution: exe-7 · Retrieved from prod · 6 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-7
**Description:** checkout down
## CMDB / Service
- **Primary CMDB Role:** \`cart\`

=== Output Format ===

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Checking.

## Record 3 — message (2026-10-19 07:02:00.000000+00:00)

**role: user**

HTTP 403 Forbidden: AccessDenied for role reader

## Record 4 — message (2026-10-19 07:03:00.000000+00:00)

**role: assistant**

Writing the summary.

## Record 5 — investigation_summary_md (2026-10-19 07:04:30.000000+00:00)

# Investigation Summary

## Confidence
High, from logs.

## Key Gaps
None.

## Record 6 — utilization (2026-10-19 07:05:00.000000+00:00)

\`\`\`json
{"data": {"context_window": {"utilization": 12.5, "compaction_count": 1}, "tools": [{"name": "a", "tool_use_count": 2}, {"name": "b", "tool_use_count": 5}]}}
\`\`\`
`;
    const m = runMetrics(normalizeBundle(markdownBundle(text, policy(), sha(text))));
    expect(m).toMatchObject({
      incident: "INCIDENT-7",
      execution: "exe-7",
      records_header: 6,
      records_parsed: 6,
      span_min: 5,
      first_summary_min: 4.5,
      finalize_min: 1.5,
      cmdb_section: "- **Primary CMDB Role:** `cart`",
      description_field: "checkout down",
      confidence_section: "High, from logs.",
      max_ctx_pct: 12.5,
      max_compactions: 1,
      tool_calls_lead: 7,
      assistant_msgs: 2,
      n_inv_summaries: 1,
    });
    expect(Object.keys(m.tools)).toEqual(["b", "a"]);
    expect(m.err_signal_msgs).toMatchObject({ http_403: 1, http_401: 0, error_word: 0 });
    expect(m.auth_err_examples).toEqual([{ rec: 3, snip: "HTTP 403 Forbidden: AccessDenied for role reader" }]);
    expect(m.summary.unstructured_messages).toBe(4);
  });
});

describe("memory reads", () => {
  // The app's own defaults, whatever overlay a run has on.
  const settings = (): MemoryReadsSettings => loadPolicyFromDirs([env().policyDir]).policy.analyzers.memoryReads;
  // Rules the way a space with its own memory names would configure them, in front of the generic ones.
  const custom = (): MemoryReadsSettings => ({
    ...settings(),
    failpatContent: "# Failure patterns",
    failpatName: "failure-patterns",
    classes: [
      { kind: "directives", anyNamePrefix: "tips-" },
      { kind: "patterns", anyNameIn: ["runbooks/"] },
      ...settings().classes,
    ],
  });

  it("finds requested memory paths and index listings in an API journal", () => {
    const m = memoryReads(normalizeBundle(apiFixtureBundle()), settings());
    expect(m.memory_file_paths).toHaveLength(11);
    expect(m.memory_file_paths[0]).toEqual([2, "/aidevops/memory/chat-tool-use-best-practices/INDEX.md"]);
    const kinds = Object.keys(m.indexes_read);
    expect(kinds.some((k) => k.startsWith("other-dir:categories/"))).toBe(true);
    expect(m.file_not_found).toEqual([]);
    expect(m.failpat_listed_in_index).toBe(false);
  });

  it("names an index listing by the first rule in the settings that matches", () => {
    const e = (name: string, target = `${name}.md`, desc: string | null = null) => ({ rec: 1, name, target, desc });
    expect(classifyIndex([e("tips-x")], custom())).toBe("directives");
    expect(classifyIndex([e("runbooks/"), e("roles/")], custom())).toBe("patterns");
    expect(classifyIndex([e("deps/", "deps/INDEX.md"), e("flows/", "flows/INDEX.md")], custom())).toBe("other-dir:deps/,flows/");
    const monitors = Array.from({ length: 11 }, (_, i) => e(`m${i}`, `m${i}.md`, "Read when this monitor fires"));
    expect(classifyIndex(monitors, custom())).toBe("monitors");
    expect(classifyIndex(monitors.slice(0, 10), custom())).toBe("other:m0,m1,m2");
  });

  it("knows no space's memory names by default", () => {
    const e = (name: string, target = `${name}.md`) => ({ rec: 1, name, target, desc: null });
    expect(settings().failpatContent).toBe("");
    expect(settings().failpatName).toBe("");
    expect(settings().classes.map((c) => c.kind)).toEqual(["other-dir", "monitors"]);
    expect(classifyIndex([e("tips-x")], settings())).toBe("other:tips-x");
    expect(classifyIndex([e("deps/", "deps/INDEX.md")], settings())).toBe("other-dir:deps/");
  });

  it("tracks the failure-pattern memory only when the settings name one", () => {
    const text = `## Record: message
**Created:** 2026-10-12 18:00:00+00:00

**Role:** user

**Tool result** (success):
\`\`\`
     1\t- [failure-patterns](./failure-patterns.md): Patterns seen in past incidents
     2\t- [roles](./roles.md): Who to page
\`\`\`

---
## Record: message
**Created:** 2026-10-12 18:00:01+00:00

**Role:** user

**Tool result** (success):
\`\`\`
     1\t# Failure patterns
     2\tAnchoring on the last change.
\`\`\`
`;
    const b = normalizeBundle(markdownBundle(text, policy(), sha(text)));
    expect(memoryReads(b, custom())).toMatchObject({ failpat_listed_in_index: true, failpat_content_records: [2] });
    expect(memoryReads(b, settings())).toMatchObject({ failpat_listed_in_index: false, failpat_content_records: [] });
  });
});

describe("condensed trace", () => {
  it("caps text and skips utilization records", () => {
    expect(cap("  abc  ", 5)).toEqual({ text: "abc", cut: 0 });
    expect(cap("abcdefgh", 3)).toEqual({ text: "abc …[+5 chars]", cut: 5 });
    const t = condensedTrace(normalizeBundle(apiFixtureBundle()));
    expect(t.entries.some((e) => e.recordType === "utilization")).toBe(false);
    expect(t.entries[0]).toMatchObject({ n: 1, kind: "prompt", label: "PROMPT", time: "2026-10-23 18:28:33" });
    const asst = t.entries.find((e) => e.kind === "assistant" && e.text.includes("CALL fs_read"));
    expect(asst?.text).toContain('CALL fs_read {"file_path":');
    expect(t.entries.filter((e) => e.kind === "tool-result").every((e) => e.text.length <= 600 + 30)).toBe(true);
  });
});

describe("output rules", () => {
  const p = () => policy().outputRules;

  it("flags unmasked account IDs and masks them in the excerpt, allowing the placeholder", () => {
    const v = checkOutputText("Role arn:aws:iam::123456789012:role/x and 111122223333 and ****9012", p(), "agent-output");
    expect(v.map((x) => x.ruleId)).toEqual(["unmasked-account-id"]);
    expect(v[0]!.excerpt).toContain("xxxxxxxx9012");
    expect(v[0]!.excerpt).not.toContain("123456789012");
  });

  it("requires a DESTRUCTIVE label near pod and deployment operations", () => {
    const missing = checkOutputText("Step 2\n```\nkubectl -n wms delete pod api-1\n```\n**Risks:** brief dip. Non-destructive.", p(), "agent-output");
    expect(missing.map((x) => x.ruleId)).toEqual(["destructive-label"]);
    const labeled = checkOutputText("```\nkubectl -n wms delete pod api-1\n```\n**Advisory:** DESTRUCTIVE but reversible.", p(), "agent-output");
    expect(labeled).toEqual([]);
    const restart = checkOutputText("Run kubectl rollout restart deployment api", p(), "agent-output");
    expect(restart.map((x) => x.ruleId)).toEqual(["destructive-label"]);
  });

  it("applies report-only rules to reports and forbidden conclusions to agent output only", () => {
    expect(checkOutputText("A — B", p(), "report").map((x) => x.ruleId)).toEqual(["report-dashes"]);
    expect(checkOutputText("A — B", p(), "agent-output")).toEqual([]);
    expect(checkOutputText("This was a false positive.", p(), "agent-output").map((x) => x.severity)).toEqual(["warning"]);
    expect(checkOutputText("This was a false positive.", p(), "report")).toEqual([]);
    expect(checkOutputText("No operational mitigation action is warranted.", p(), "agent-output").map((x) => x.ruleId)).toEqual(["forbidden-no-action"]);
  });

  it("checks only agent output records", () => {
    const text = `## Record: message
**Created:** 2026-10-12 18:00:00+00:00

**Role:** user

**Tool result** (success):
\`\`\`
account 123456789012
\`\`\`

---
## Record: mitigation_summary_md
**Created:** 2026-10-12 18:10:00+00:00

kubectl delete pod x in account 210987654321
`;
    const out = checkAgentOutput(normalizeBundle(markdownBundle(text, policy(), sha(text))), p());
    expect(out.checkedRecords).toBe(1);
    expect(out.counts).toEqual({ "unmasked-account-id": 1, "destructive-label": 1 });
    expect(out.violations.every((v) => v.n === 2 && v.recordType === "mitigation_summary_md")).toBe(true);
    expect(out.errors).toBe(2);
  });

  it("policy rejects rules with bad patterns or missing require-near fields", () => {
    expect(outputRulesSection.schema.safeParse({ rules: [{ id: "a", description: "d", kind: "forbid", pattern: "(" }] }).success).toBe(false);
    expect(outputRulesSection.schema.safeParse({ rules: [{ id: "a", description: "d", kind: "require-near", pattern: "x" }] }).success).toBe(false);
    expect(outputRulesSection.schema.safeParse({ rules: [] }).success).toBe(true);
  });
});

describe("deployed vs read", () => {
  const memoryBody = [
    "---",
    "name: overview",
    "---",
    "# Tool-use best practices for chat sessions",
    "Covers common errors, output management, and effective usage patterns.",
    "Always page large results instead of reading them whole at once.",
  ].join("\n");

  it("keeps meaningful lines from the start of the body, without frontmatter", () => {
    expect(bodyLines(memoryBody)).toEqual([
      "# Tool-use best practices for chat sessions",
      "Covers common errors, output management, and effective usage patterns.",
      "Always page large results instead of reading them whole at once.",
    ]);
    expect(bodyLines("| --- | --- |\nshort\n... (truncated, 9 total chars)\nthis line comes after the cut marker")).toEqual([]);
  });

  it("matches a package file to the body the agent received", () => {
    const text = `## Record: message
**Created:** 2026-10-12 18:00:00+00:00

**Role:** assistant

**Tool call:** \`fs_read\`
\`\`\`json
{"file_path": "/aidevops/memory/tips/overview.md"}
\`\`\`

---
## Record: message
**Created:** 2026-10-12 18:00:01+00:00

**Role:** user

**Tool result** (success):
\`\`\`
     1\t# Tool-use best practices for chat sessions
     2\tCovers common errors, output management, and effective usage patterns.
     3\tAlways page large results instead of reading them whole at once.
\`\`\`
`;
    const b = normalizeBundle(markdownBundle(text, policy(), sha(text)));
    const out = deployedVsRead(b, [
      { assetType: "memory", name: "tips", path: "overview.md", body: memoryBody },
      { assetType: "memory", name: "tips", path: "other.md", body: "# Something else entirely here\nA line long enough to be compared with." },
      { assetType: "memory", name: "tips", path: "INDEX.md", body: "- [overview](./overview.md)" },
      { assetType: "skill", name: "triage", path: "SKILL.md", body: "# Triage skill body line one\nTriage skill body line two, long enough." },
      {
        assetType: "memory",
        name: "tips",
        path: "changed.md",
        body: "# Tool-use best practices for chat sessions\nCovers common errors, output management, and effective usage patterns.\nA new third line that the deployed body does not have.",
      },
    ]);
    const by = Object.fromEntries(out.files.map((f) => [f.path, f]));
    expect(by["overview.md"]).toMatchObject({ deployedPath: "/aidevops/memory/tips/overview.md", read: true, readAt: [1], verdict: "matches", returnedAt: 2, pkg: 1, ret: 1 });
    expect(by["other.md"]).toMatchObject({ read: false, verdict: "not-read" });
    expect(by["INDEX.md"]).toBeUndefined();
    expect(by["SKILL.md"]).toMatchObject({ deployedPath: "/aidevops/skills/user/triage/SKILL.md", verdict: "not-read" });
    expect(by["changed.md"]).toMatchObject({ verdict: "different", packageOnly: ["A new third line that the deployed body does not have."] });
    expect(out.stores).toEqual([{ store: "tips", referenced: true }]);
    expect(out.counts).toMatchObject({ matches: 1, different: 1, "not-read": 2 });
  });
});

describe("registry", () => {
  it("lists every analyzer and runs the journal-only ones", () => {
    expect(JOURNAL_ONLY_ANALYZERS).toEqual(["run-metrics", "memory-reads", "condensed-trace", "output-rules"]);
    expect(ANALYZER_IDS).toContain("deployed-vs-read");
    const res = runAnalyzers(apiFixtureBundle(), JOURNAL_ONLY_ANALYZERS, { policy: policy() });
    expect(res.map((r) => r.analyzer)).toEqual(JOURNAL_ONLY_ANALYZERS);
    expect(new Set(res.map((r) => r.inputDigest)).size).toBe(4);
  });

  it("digests the same content the same way regardless of key order, and differently when content changes", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    const b1 = apiFixtureBundle();
    const d1 = bundleDigest(normalizeBundle(b1), b1);
    const b2 = apiFixtureBundle();
    const first = b2.records[0]!;
    b2.records[0] = { ...first, content: { kind: "text", text: "changed" } };
    expect(bundleDigest(normalizeBundle(b2), b2)).not.toBe(d1);
    const b3 = apiFixtureBundle();
    expect(bundleDigest(normalizeBundle(b3), b3)).toBe(d1);
  });
});

describe("output rules on the live-run journals (record-created export format)", () => {
  const files = readdirSync(LIVE_RUNS_DIR).filter((x) => x.endsWith(".md")).sort();
  const read = (f: string) => readFileSync(path.join(LIVE_RUNS_DIR, f), "utf8");
  const check = (text: string) => checkAgentOutput(normalizeBundle(markdownBundle(text, policy(), sha(text))), policy().outputRules);
  // The same journal with `extra` added under the investigation summary's heading.
  const withSummaryLine = (text: string, extra: string) => {
    const edited = text.replace("# Investigation Summary\n", `# Investigation Summary\n\n${extra}\n`);
    expect(edited).not.toBe(text);
    return edited;
  };

  it("check the summaries and findings of every journal", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const out = check(read(f));
      expect(out.checkedRecords, f).toBeGreaterThan(0);
      expect(out.violations.length, f).toBe(Object.values(out.counts).reduce((a, b) => a + b, 0));
      // The sample runs follow the rules; another dataset may not.
      if (!process.env.DAM_LIVE_RUNS_DIR) expect(out.counts, f).toEqual({});
    }
  });

  it("flag an unmasked account ID, an unlabeled destructive step and a forbidden conclusion", () => {
    const text = read(files[0]!);
    const before = check(text).counts;
    const gained = (extra: string, rule: string) => (check(withSummaryLine(text, extra)).counts[rule] ?? 0) - (before[rule] ?? 0);
    expect(gained("The failing role is in account 123456789012.", "unmasked-account-id")).toBe(1);
    expect(gained("Run kubectl delete pod checkout-api-0 to clear it.", "destructive-label")).toBe(1);
    expect(gained("DESTRUCTIVE: run kubectl delete pod checkout-api-0 to clear it.", "destructive-label")).toBe(0);
    expect(gained("No action is needed.", "forbidden-no-action")).toBe(1);
  });
});
