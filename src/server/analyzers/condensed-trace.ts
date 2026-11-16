import { cpLength, cpSlice, type NormBundle, type NormRecord } from "./normalize";
import type { Analyzer } from "./types";

/**
 * Condensed trace: a reviewable trace with assistant messages and
 * agent-authored records in full (capped) and tool results as short previews.
 *
 * The prompt is the first user message with text, assistant tool calls are
 * listed by name with a short input preview, and the output is a list of
 * entries (`traceToMarkdown` renders them as one markdown document).
 */

export const CONDENSED_TRACE_DEFAULTS = {
  caps: { prompt: 6000, assistant: 4000, tool: 600, agent_record: 3000, summary: 12000, other: 800 },
  /** Characters of each tool call input shown after the tool name */
  toolInputPreview: 170,
  skipTypes: ["utilization"],
  /** ui_investigation_summary records are kept only among the last N records */
  keepLastUiSummaries: { type: "ui_investigation_summary", lastN: 8 },
  summaryTypes: ["investigation_summary_md", "mitigation_summary_md"],
  /** JSON twins of the summary records */
  twinTypes: ["investigation_summary", "mitigation_summary"],
  agentRecordTypes: ["finding", "observation", "investigation_gap", "symptom", "plan"],
};

export type TraceKind = "prompt" | "assistant" | "tool-result" | "summary" | "agent-record" | "other";

export interface TraceEntry {
  n: number;
  kind: TraceKind;
  /** PROMPT, ASSISTANT, TOOL-RESULT or the record type in capitals */
  label: string;
  recordType: string;
  /** UTC, "YYYY-MM-DD HH:MM:SS" */
  time: string;
  text: string;
  /** Characters cut by the cap (0 when the text is complete) */
  truncatedChars: number;
}

export interface CondensedTraceOutput {
  incident: string;
  title: string | null;
  records: number;
  entries: TraceEntry[];
  /** Total characters of entry text, for comparing trace sizes */
  chars: number;
}

/** Strip, then cut to n characters with a note of what was cut. */
export function cap(s: string, n: number): { text: string; cut: number } {
  const t = s.trim();
  const len = cpLength(t);
  if (len <= n) return { text: t, cut: 0 };
  return { text: `${cpSlice(t, n)} …[+${len - n} chars]`, cut: len - n };
}

function utc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function assistantText(r: NormRecord, previewChars: number): string {
  const lines: string[] = [];
  if (r.structured) {
    const text = r.textBlocks.join("\n\n").trim();
    if (text) lines.push(text);
    for (const u of r.toolUses) {
      let input = "";
      try {
        input = JSON.stringify(u.input) ?? "";
      } catch {
        input = "";
      }
      lines.push(`CALL ${u.name} ${cpSlice(input, previewChars)}`.trimEnd());
    }
    return lines.join("\n");
  }
  return r.text;
}

export function condensedTrace(b: NormBundle, d = CONDENSED_TRACE_DEFAULTS): CondensedTraceOutput {
  const recs = b.records;
  const prompt = recs.find((r) => r.isMessage && r.role === "user" && r.hasText) ?? null;
  const entries: TraceEntry[] = [];
  const push = (r: NormRecord, kind: TraceKind, label: string, body: string, limit: number) => {
    const c = cap(body, limit);
    entries.push({ n: r.n, kind, label, recordType: r.recordType, time: utc(r.createdAt), text: c.text, truncatedChars: c.cut });
  };
  recs.forEach((r, i) => {
    if (d.skipTypes.includes(r.recordType)) return;
    if (r.recordType === d.keepLastUiSummaries.type && i < recs.length - d.keepLastUiSummaries.lastN) return;
    if (r.isMessage) {
      if (r === prompt) push(r, "prompt", "PROMPT", r.text, d.caps.prompt);
      else if (r.role === "assistant") push(r, "assistant", "ASSISTANT", assistantText(r, d.toolInputPreview), d.caps.assistant);
      else push(r, "tool-result", "TOOL-RESULT", r.text, d.caps.tool);
    } else if (d.summaryTypes.includes(r.recordType)) {
      push(r, "summary", r.recordType.toUpperCase(), r.text, d.caps.summary);
    } else if (d.twinTypes.includes(r.recordType)) {
      return;
    } else if (d.agentRecordTypes.includes(r.recordType)) {
      push(r, "agent-record", r.recordType.toUpperCase(), r.text, d.caps.agent_record);
    } else {
      push(r, "other", r.recordType.toUpperCase(), r.text, d.caps.other);
    }
  });
  return {
    incident: b.task.incidentId ?? b.task.taskId,
    title: b.task.title,
    records: recs.length,
    entries,
    chars: entries.reduce((s, e) => s + e.text.length, 0),
  };
}

/** The trace as one markdown document, one section per entry ("### R<n> <LABEL> <time>"). */
export function traceToMarkdown(t: CondensedTraceOutput): string {
  const head = `# ${t.incident}${t.title ? ` ${t.title}` : ""}\n\n${t.records} records`;
  return [head, ...t.entries.map((e) => `### R${e.n} ${e.label} ${e.time}\n${e.text}`)].join("\n\n");
}

export const condensedTraceAnalyzer: Analyzer<CondensedTraceOutput> = {
  id: "condensed-trace",
  version: "1.0.0",
  label: "Condensed trace",
  description: "A reviewable trace with capped previews per record kind",
  requires: [],
  configDigest: () => "",
  run: (b) => condensedTrace(b),
};
