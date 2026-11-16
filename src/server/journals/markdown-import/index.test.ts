import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { journalImportSection } from "@/server/policy/sections/journal-import";
import { BENCHMARK_JOURNALS_DIR, LIVE_RUNS_DIR, benchmarkExpected } from "../../../../test/helpers/fixtures";
import { importHeaderOf, importedRecordRawOf, MarkdownImportError, parseJournalMarkdown } from "./index";

const policy = () => getAppPolicy().policy;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const FORMAT_A = `# Journal Log: INCIDENT-1


---
## Record: mitigation_summary_md
**Created:** 2026-10-12 18:36:05.759000+00:00


# Mitigation Summary

No change.

---
## Record: message
**Created:** 2026-10-12 18:33:49.426000+00:00

**Role:** assistant

<details><summary>Thinking (12 chars)</summary>

check the map

</details>

Reading the index.

**Tool call:** \`fs_read\`
\`\`\`json
{
  "file_path": "/aidevops/memory/store-a/INDEX.md"
}
\`\`\`

**Tool call:** \`invoke_user_tool\`
\`\`\`json
{
  "arguments": {
    "query": "sum(rate(x[5m]))"
  },
  "tool_name": "co...
\`\`\`

---
## Record: message
**Created:** 2026-10-12 18:33:49.426000+00:00

**Role:** user

**Tool result** (success):
\`\`\`
     1\t- [deps/](./deps/INDEX.md): 2 files
\`\`\`

---
## Record: message
**Created:** 2026-10-12 18:30:00.000000+00:00

TITLE: INCIDENT-1, DESCRIPTION: x
Title: INC-1: Orders stuck

---
`;

const FORMAT_B = `# INCIDENT-2 — Full DevOps Agent Investigation Journal

_Execution: exe-ops1-abc · Retrieved from prod · 4 records across 1 pages_


## Record 1 — message (2026-10-19 07:49:21.933000+00:00)

**role: user**

TITLE: INCIDENT-2
Title: INC-2: Cart broken

## Record 2 — utilization (2026-10-19 07:49:38.651000+00:00)

\`\`\`json
{
  "data": {
    "context_window": { "utilization": 5.1, "compaction_count": 0 },
    "tools": [{ "name": "fs_read", "tool_use_count": 7 }]
  }
}
\`\`\`

## Record 3 — message (2026-10-19 07:49:40+00:00)

\`\`\`json
{
  "id": "m3",
  "role": "assistant",
  "content": [
    { "thinking": "look", "type": "thinking" },
    { "id": "t1", "tool_name": "fs_read", "input": { "file_path": "/aidevops/memory/x/INDEX.md" }, "type": "tool_use" }
  ]
}
\`\`\`

## Record 4 — message (2026-10-19 07:49:40.500123+00:00)

**role: assistant**

Done.
`;

describe("parseJournalMarkdown, format record-created", () => {
  const text = FORMAT_A;
  const r = parseJournalMarkdown(text, policy(), { sourceSha256: sha(text), fileName: "INCIDENT-1-journal.md" });

  it("detects the format and reads the header", () => {
    expect(r.format).toBe("record-created");
    expect(r.task.incidentId).toBe("INCIDENT-1");
    expect(r.task.title).toBe("INC-1: Orders stuck");
    expect(importHeaderOf(r.task.raw)).toEqual({ incident: "INCIDENT-1", execution: null, records: null, pages: null });
    expect(r.warnings).toEqual([]);
  });

  it("orders newest-first exports ascending and keeps the file order on equal times", () => {
    expect(r.records.map((x) => x.recordType)).toEqual(["message", "message", "message", "mitigation_summary_md"]);
    expect(r.records.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    // The two records at 18:33:49.426 stay in file order (assistant, then user).
    const roles = r.records.map((x) => (x.content.kind === "markdown" ? x.content.role : undefined));
    expect(roles).toEqual([null, "assistant", "user", null]);
  });

  it("removes the created line, role marker and separator from the text", () => {
    const summary = r.records[3]!;
    expect(summary.content).toEqual({ kind: "markdown", text: "# Mitigation Summary\n\nNo change.", role: null });
    const prompt = r.records[0]!;
    expect(prompt.content.kind === "markdown" && prompt.content.text).toBe("TITLE: INCIDENT-1, DESCRIPTION: x\nTitle: INC-1: Orders stuck");
  });

  it("recovers thinking, tool calls (complete and cut off) and tool results as blocks", () => {
    const asst = r.records[1]!.content;
    expect(asst.kind).toBe("markdown");
    if (asst.kind !== "markdown") return;
    expect(asst.text.startsWith("<details><summary>Thinking")).toBe(true);
    expect(asst.json).toEqual({
      role: "assistant",
      recovered: "markdown",
      content: [
        { type: "thinking", thinking: "check the map" },
        { type: "text", text: "Reading the index." },
        { type: "tool_use", tool_name: "fs_read", input: { file_path: "/aidevops/memory/store-a/INDEX.md" }, input_complete: true },
        { type: "tool_use", tool_name: "invoke_user_tool", input: {}, input_complete: false },
      ],
    });
    const user = r.records[2]!.content;
    expect(user.kind === "markdown" && user.json).toEqual({
      role: "user",
      recovered: "markdown",
      content: [{ type: "tool_result", status: "success", content: [{ text: "     1\t- [deps/](./deps/INDEX.md): 2 files" }] }],
    });
  });

  it("synthesizes stable IDs from the source SHA and seq", () => {
    const again = parseJournalMarkdown(text, policy(), { sourceSha256: sha(text), fileName: "x.md" });
    expect(again.records.map((x) => x.recordId)).toEqual(r.records.map((x) => x.recordId));
    expect(r.records[0]!.recordId).toBe(sha(`${sha(text)}:1`));
    const other = parseJournalMarkdown(text, policy(), { sourceSha256: sha("other"), fileName: "x.md" });
    expect(other.records[0]!.recordId).not.toBe(r.records[0]!.recordId);
    expect(r.task.taskId).toBe(`import-${sha(text).slice(0, 32)}`);
    expect(r.executions[0]!.executionId).toBe(`import-${sha(text).slice(0, 32)}`);
    expect(r.records.every((x) => x.taskId === r.task.taskId && x.executionId === r.executions[0]!.executionId)).toBe(true);
  });

  it("keeps the source block and line in raw", () => {
    const raw = importedRecordRawOf(r.records[3]!.raw);
    expect(raw?.line).toBe(5);
    expect(raw?.block.startsWith("## Record: mitigation_summary_md\n**Created:**")).toBe(true);
    expect(raw?.n).toBeNull();
  });

  it("sets task and execution times from the first and last records", () => {
    expect(r.task.createdAt?.toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(r.task.updatedAt?.toISOString()).toBe("2026-10-12T18:36:05.759Z");
  });
});

describe("parseJournalMarkdown, format numbered-record", () => {
  const text = FORMAT_B;
  const r = parseJournalMarkdown(text, policy(), { sourceSha256: sha(text), fileName: "INCIDENT-2_full_journal.md" });

  it("reads the header, record numbers and times", () => {
    expect(r.format).toBe("numbered-record");
    expect(r.task.incidentId).toBe("INCIDENT-2");
    expect(r.task.taskId).toBe("import-exe-ops1-abc");
    expect(r.executions[0]!.executionId).toBe("exe-ops1-abc");
    expect(importHeaderOf(r.executions[0]!.raw)).toEqual({ incident: "INCIDENT-2", execution: "exe-ops1-abc", records: 4, pages: 1 });
    expect(r.records.map((x) => importedRecordRawOf(x.raw)?.n)).toEqual([1, 2, 3, 4]);
    expect(r.records[2]!.createdAt.toISOString()).toBe("2026-10-19T07:49:40.000Z");
  });

  it("reports dropped sub-millisecond digits", () => {
    expect(r.records[3]!.createdAt.toISOString()).toBe("2026-10-19T07:49:40.500Z");
    expect(r.warnings).toEqual(["1 record time(s) had digits below one millisecond; they were dropped"]);
  });

  it("parses fenced JSON records and takes the role of JSON-only messages from the JSON", () => {
    const util = r.records[1]!.content;
    expect(util.kind === "markdown" && util.json).toEqual({
      data: { context_window: { utilization: 5.1, compaction_count: 0 }, tools: [{ name: "fs_read", tool_use_count: 7 }] },
    });
    const jsonOnly = r.records[2]!.content;
    expect(jsonOnly.kind === "markdown" && jsonOnly.role).toBe("assistant");
    const marked = r.records[3]!.content;
    expect(marked).toEqual({ kind: "markdown", text: "Done.", role: "assistant" });
  });

  it("warns when the header's record count differs", () => {
    const cut = text.slice(0, text.indexOf("## Record 4"));
    const p = parseJournalMarkdown(cut, policy(), { sourceSha256: sha(cut), fileName: "x.md" });
    expect(p.records).toHaveLength(3);
    expect(p.warnings).toContain("The header lists 4 records but 3 were found");
  });
});

describe("parseJournalMarkdown, errors and options", () => {
  it("rejects text with no record headings", () => {
    expect(() => parseJournalMarkdown("# Notes\n\nnothing here", policy(), { sourceSha256: sha("n"), fileName: "n.md" })).toThrow(MarkdownImportError);
  });

  it("rejects a bad SHA and an unknown forced format", () => {
    expect(() => parseJournalMarkdown(FORMAT_B, policy(), { sourceSha256: "abc", fileName: "x.md" })).toThrow(/SHA-256/);
    expect(() => parseJournalMarkdown(FORMAT_B, policy(), { sourceSha256: sha("x"), fileName: "x.md", format: "nope" })).toThrow(/Unknown/);
  });

  it("uses the incident hint when the header has none, and accepts CRLF line endings", () => {
    const text = "## Record: message\r\n**Created:** 2026-10-12 18:00:00+00:00\r\n\r\nhello\r\n";
    const p = parseJournalMarkdown(text, policy(), { sourceSha256: sha(text), fileName: "x.md", incidentIdHint: "INCIDENT-9" });
    expect(p.task.incidentId).toBe("INCIDENT-9");
    expect(p.records[0]!.content).toEqual({ kind: "markdown", text: "hello", role: null });
    expect(p.warnings).toContain("The document header did not match the format's header pattern");
  });

  it("policy rejects a pattern that does not compile", () => {
    const bad = journalImportSection.schema.safeParse({ formats: [{ id: "x", recordHeading: "^## (" }] });
    expect(bad.success).toBe(false);
    const dup = journalImportSection.schema.safeParse({ formats: [{ id: "x", recordHeading: "a" }, { id: "x", recordHeading: "b" }] });
    expect(dup.success).toBe(false);
  });
});

describe("the benchmark journals (format numbered-record)", () => {
  it("parse cleanly, with as many records as each header lists", () => {
    const dirs = readdirSync(BENCHMARK_JOURNALS_DIR).filter((d) => d.startsWith("INCIDENT-")).sort();
    expect(dirs.length).toBeGreaterThan(0);
    const expected = benchmarkExpected();
    if (expected) expect(dirs).toEqual(expected.incidentIds);
    for (const d of dirs) {
      const buf = readFileSync(path.join(BENCHMARK_JOURNALS_DIR, d, `${d}_full_journal.md`));
      const p = parseJournalMarkdown(buf.toString("utf8"), policy(), { sourceSha256: createHash("sha256").update(buf).digest("hex"), fileName: d });
      expect(p.format).toBe("numbered-record");
      expect(p.warnings).toEqual([]);
      expect(p.task.incidentId).toBe(d);
      expect(p.records.length).toBe(importHeaderOf(p.task.raw)?.records);
      if (expected) expect(p.records.length).toBe(expected.journals[d]!.records);
      expect(p.records.map((x) => importedRecordRawOf(x.raw)?.n)).toEqual(p.records.map((x) => x.seq));
    }
  });
});

describe("the live-run journals (format record-created)", () => {
  it("parse cleanly and recover the records, tool calls and tool results the text shows", () => {
    const files = readdirSync(LIVE_RUNS_DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    // The sample set has the four runs INCIDENT-20201 to INCIDENT-20204.
    if (!process.env.DAM_LIVE_RUNS_DIR) expect(files).toHaveLength(4);
    let records = 0;
    let calls = 0;
    let results = 0;
    const shown = { records: 0, calls: 0, results: 0 };
    for (const f of files) {
      const buf = readFileSync(path.join(LIVE_RUNS_DIR, f));
      const text = buf.toString("utf8");
      const p = parseJournalMarkdown(text, policy(), { sourceSha256: createHash("sha256").update(buf).digest("hex"), fileName: f });
      expect(p.format).toBe("record-created");
      expect(p.warnings).toEqual([]);
      records += p.records.length;
      for (const r of p.records) {
        const blocks = r.content.kind === "markdown" ? (r.content.json as { content?: { type: string }[] } | undefined)?.content : undefined;
        calls += blocks?.filter((b) => b.type === "tool_use").length ?? 0;
        results += blocks?.filter((b) => b.type === "tool_result").length ?? 0;
      }
      // What the markdown shows, counted without the parser: a heading per record, a line per call, a line per result.
      shown.records += (text.match(/^## Record: /gm) ?? []).length;
      shown.calls += (text.match(/^\*\*Tool call:\*\*/gm) ?? []).length;
      shown.results += (text.match(/^\*\*Tool result\*\*/gm) ?? []).length;
    }
    expect(calls).toBeGreaterThan(0);
    expect({ records, calls, results }).toEqual(shown);
  });
});
