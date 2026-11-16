import { describe, expect, it } from "vitest";
import type { JournalBundle, StoredRecord, StoredTask } from "@/lib/journal/types";
import { parseRecordContent } from "@/lib/journal/types";
import { getAppPolicy } from "@/server/policy";
import { renderJournalMarkdown, renderRecordBody } from "./render";
import { templateSetFor } from "./templates/load";

/**
 * The default templates must reproduce the record-created export markdown
 * (one file per investigation): newest record first,
 * "# Journal Log: <incident>", then per record "---", "## Record: <type>",
 * "**Created:** <Python datetime>" and the body.
 */

const templates = () => templateSetFor(getAppPolicy());

const task: StoredTask = {
  taskId: "task-1",
  incidentId: "INCIDENT-1",
  title: "INCIDENT-1",
  taskType: "INVESTIGATION",
  status: "COMPLETED",
  priority: "HIGH",
  reference: null,
  createdAt: new Date("2026-10-12T19:19:00Z"),
  updatedAt: null,
  source: "api",
  raw: {},
};

let seq = 0;
function rec(recordType: string, createdAt: string, content: unknown): StoredRecord {
  seq++;
  return {
    recordId: `r${seq}`,
    executionId: "exec-1",
    taskId: "task-1",
    seq,
    recordType,
    createdAt: new Date(createdAt),
    content: parseRecordContent(typeof content === "string" ? content : JSON.stringify(content)),
    raw: { content },
  };
}

const longResult = "x".repeat(2500);
const records: StoredRecord[] = [
  rec("ui_investigation_summary", "2026-10-12T19:20:00.100Z", {
    type: "ui_investigation_summary",
    content: {
      id: "root",
      type: "container",
      props: { layout: "vertical" },
      text: null,
      children: [
        { id: "t", type: "title", props: { level: 1 }, text: "Investigation starting…", children: [] },
        { id: "x", type: "text", props: {}, text: "The investigation is starting. This summary will update as it progresses.", children: [] },
        { id: "c", type: "chart", props: { chartType: "line" }, text: null, children: [] },
      ],
    },
  }),
  rec("message", "2026-10-12T19:20:01.000Z", {
    id: "m1",
    role: "user",
    content: [{ text: "TITLE: INCIDENT-1, DESCRIPTION: Test\n", type: "text" }],
    user_reference: null,
  }),
  rec("utilization", "2026-10-12T19:20:01.500Z", { metadata: { version: "0.1" }, data: {} }),
  rec("message", "2026-10-12T19:20:02.250Z", {
    id: "m2",
    role: "assistant",
    content: [
      { thinking: "Let me look", signature: "sig", type: "thinking" },
      { text: "Reading the file.", type: "text" },
      { id: "tu1", tool_name: "fs_read", input: { file_path: "/aidevops/memory/INDEX.md", note: "café — ok" }, type: "tool_use" },
    ],
  }),
  rec("message", "2026-10-12T19:20:03.300Z", {
    id: "m3",
    role: "user",
    content: [{ id: "tu1", content: [{ text: longResult }], status: "success", type: "tool_result" }],
  }),
  rec("finding", "2026-10-12T19:20:04.400Z", { type: "finding", id: "f1", title: "Pool exhaustion", description: "The pool ran out." }),
  rec("investigation_gap", "2026-10-12T19:20:05.500Z", { type: "investigation_gap", id: "gap-1", title: "Alert mismatch — kept in scope" }),
  rec("investigation_summary", "2026-10-12T19:20:06.000Z", { type: "investigation_summary", symptoms: [] }),
  rec("investigation_summary_md", "2026-10-12T19:20:06.600Z", "# Investigation Summary\n\n## Symptoms\n"),
  rec("message", "2026-10-12T19:20:07.700Z", "Final answer."),
];

const frame = (type: string, created: string, body: string) => `\n---\n## Record: ${type}\n**Created:** ${created}\n\n${body}\n`;

describe("journal markdown (record-created format)", () => {
  it("renders records newest first with the export frame and bodies", () => {
    const bundle: JournalBundle = { spaceId: "s", task, executions: [], records };
    const expected =
      "# Journal Log: INCIDENT-1\n\n" +
      frame("message", "2026-10-12 19:20:07.700000+00:00", "\nFinal answer.") +
      frame("investigation_summary_md", "2026-10-12 19:20:06.600000+00:00", "\n# Investigation Summary\n\n## Symptoms\n") +
      frame(
        "investigation_gap",
        "2026-10-12 19:20:05.500000+00:00",
        '{\n  "type": "investigation_gap",\n  "id": "gap-1",\n  "title": "Alert mismatch \\u2014 kept in scope"\n}',
      ) +
      frame("finding", "2026-10-12 19:20:04.400000+00:00", "**Pool exhaustion**\n\nThe pool ran out.") +
      frame(
        "message",
        "2026-10-12 19:20:03.300000+00:00",
        "**Role:** user\n\n**Tool result** (success):\n```\n" + "x".repeat(2000) + "\n... (truncated, 2500 total chars)\n```",
      ) +
      frame(
        "message",
        "2026-10-12 19:20:02.250000+00:00",
        "**Role:** assistant\n\n<details><summary>Thinking (11 chars)</summary>\n\nLet me look\n\n</details>\n\nReading the file.\n\n" +
          '**Tool call:** `fs_read`\n```json\n{\n  "file_path": "/aidevops/memory/INDEX.md",\n  "note": "caf\\u00e9 \\u2014 ok"\n}\n```',
      ) +
      frame("message", "2026-10-12 19:20:01+00:00", "**Role:** user\n\nTITLE: INCIDENT-1, DESCRIPTION: Test\n") +
      frame(
        "ui_investigation_summary",
        "2026-10-12 19:20:00.100000+00:00",
        "# Investigation starting…\n\nThe investigation is starting. This summary will update as it progresses.",
      );
    expect(renderJournalMarkdown(bundle, templates())).toBe(expected);
  });

  it("starts the file like an exported journal", () => {
    const md = renderJournalMarkdown({ spaceId: "s", task, executions: [], records: [records[8]!] }, templates());
    expect(md.startsWith("# Journal Log: INCIDENT-1\n\n\n---\n## Record: investigation_summary_md\n**Created:** 2026-10-12 19:20:06.600000+00:00\n\n\n# Investigation Summary")).toBe(true);
  });

  it("falls back to the task ID when there is no incident ID", () => {
    const md = renderJournalMarkdown({ spaceId: "s", task: { ...task, incidentId: null }, executions: [], records: [] }, templates());
    expect(md).toBe("# Journal Log: task-1\n\n");
  });

  it("renders a record body for the UI without the frame", () => {
    expect(renderRecordBody(records[5]!, templates())).toBe("**Pool exhaustion**\n\nThe pool ran out.");
  });

  it("uses the fallback template for record types with unsafe names", () => {
    const r = rec("../_document", "2026-10-12T19:20:00Z", { a: 1 });
    expect(renderRecordBody(r, templates())).toBe('{\n  "a": 1\n}');
  });
});
