import { cpLength, cpSlice, type NormBundle, type NormRecord } from "./normalize";
import { minutesBetween, pyRegex, pyRound } from "./py";
import type { Analyzer } from "./types";

/**
 * Run metrics: tool calls by name, error classes, subagents, skills, the time
 * split and the time to the first summary. The snake_case output fields keep
 * the names of the reference audit's metrics file (sample-data/audit/metrics.json);
 * the `summary` object holds the time split, rounds and tool calls by name.
 *
 * It reads records, not markdown, so:
 *  - `prompt_chars` counts the prompt text only (not the "**role: user**"
 *    marker or the blank lines around it), and `auth_err_examples[].snip`
 *    starts at the text instead of at the role marker.
 *  - start_utc and end_utc are ISO 8601 strings with "Z" (not a naive
 *    isoformat with microseconds).
 *  - "Messages with a role" means messages with text. A markdown export puts
 *    the role marker only on messages with text; messages holding only
 *    thinking and tool calls are exported as JSON and have no role.
 */

export const RUN_METRICS_DEFAULTS = {
  /** Error classes counted in tool results */
  errorPatterns: [
    ["http_401", String.raw`\b401\b|Unauthorized`, "i"],
    ["http_403", String.raw`\b403\b|Forbidden|AccessDenied|access denied|not authorized`, "i"],
    ["http_404", String.raw`\b404\b`, ""],
    ["http_5xx", String.raw`\b50[0234]\b`, ""],
    ["timeout", String.raw`timed out|timeout`, "i"],
    ["no_matching_role", String.raw`No matching role found`, "i"],
    ["error_word", String.raw`"error"|\berror:|Error:|"isError": true|ToolError|Exception`, "i"],
    ["large_result", String.raw`## Large Tool Result`, ""],
  ] as [string, string, string][],
  authExample: String.raw`\b401\b|\b403\b|Unauthorized|Forbidden|AccessDenied|No matching role`,
  authExampleLimit: 12,
  snippetChars: 220,
  /** Section of the prompt holding the CMDB fields */
  cmdbSection: String.raw`## CMDB / Service\s*(.*?)\n=== Output Format`,
  descriptionField: String.raw`\*\*Description:\*\*(.*?)\n`,
  confidenceHeading: "Confidence",
  investigationSummaryType: "investigation_summary_md",
  mitigationSummaryType: "mitigation_summary_md",
  utilizationType: "utilization",
  findingType: "finding",
  /** Tool classes for the time split */
  parentQueryTools: ["invoke_user_tool", "use_aws"],
  memoryReadTool: "fs_read",
  toolSearchTool: "search_user_tools",
  subagentTool: "subagent",
  /** User text that announces a finished subagent (time waiting on subagents, not on tools) */
  subagentNotice: String.raw`^The background Task subagent assigned to task`,
};

export interface RunMetricsOutput {
  incident: string;
  execution: string | null;
  records_header: number | null;
  records_parsed: number;
  start_utc: string | null;
  end_utc: string | null;
  span_min: number | null;
  first_summary_min: number | null;
  finalize_min: number | null;
  types: Record<string, number>;
  prompt_chars: number;
  cmdb_section: string | null;
  description_field: string | null;
  max_ctx_pct: number | null;
  max_compactions: number | null;
  tools: Record<string, number>;
  tool_calls_lead: number;
  skills: string[];
  subagents: string[];
  n_inv_summaries: number;
  n_mit_summaries: number;
  confidence_section: string | null;
  assistant_msgs: number;
  err_signal_msgs: Record<string, number>;
  auth_err_examples: { rec: number; snip: string }[];
  /** Time split, rounds and tool-call counts */
  summary: {
    dur_min: number;
    model_min: number;
    tool_min: number;
    subwait_min: number;
    rounds: number;
    calls: number;
    calls_per_round: number;
    tool_calls_by_name: Record<string, number>;
    parent_queries: number;
    subagent_calls: number;
    thinking_chars: number;
    mem_reads: number;
    skill_loads: number;
    tool_search: number;
    tool_errors: number;
    first_hyp_min: number | null;
    first_cause_min: number | null;
    root_min: number | null;
    max_ctx: number;
    /** Messages whose tool calls are known from blocks; imported text messages lose their tool calls */
    structured_messages: number;
    unstructured_messages: number;
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function section(md: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = pyRegex(String.raw`^#+\s*` + esc + String.raw`\s*$(.*?)(?=^#+\s|\Z)`, "ms").exec(md);
  return m ? m[1]!.trim() : null;
}

const userWithText = (r: NormRecord) => r.isMessage && r.role === "user" && r.hasText;
const assistantWithText = (r: NormRecord) => r.isMessage && r.role === "assistant" && r.hasText;

export function runMetrics(b: NormBundle, d = RUN_METRICS_DEFAULTS): RunMetricsOutput {
  const recs = b.records;
  const types: Record<string, number> = {};
  for (const r of recs) types[r.recordType] = (types[r.recordType] ?? 0) + 1;
  const t0 = recs[0]?.createdAt ?? null;
  const t1 = recs[recs.length - 1]?.createdAt ?? null;

  const promptRec = recs.find(userWithText) ?? null;
  const prompt = promptRec?.text ?? "";
  const cmdb = pyRegex(d.cmdbSection, "s").exec(prompt);
  // The script searched the rendered block, which always ended with a newline.
  const desc = pyRegex(d.descriptionField).exec(prompt + "\n");

  const utils: Obj[] = [];
  for (const r of recs) {
    if (r.recordType !== d.utilizationType) continue;
    const data = isObj(r.data) ? r.data.data : undefined;
    if (isObj(data)) utils.push(data);
  }
  const ctxVals = utils.map((u) => (isObj(u.context_window) ? num(u.context_window.utilization) : null)).filter((x): x is number => x !== null);
  const compVals = utils.map((u) => (isObj(u.context_window) ? (num(u.context_window.compaction_count) ?? 0) : null)).filter((x): x is number => x !== null);
  const finalTools = new Map<string, number>();
  const skills = new Set<string>();
  const subagents = new Set<string>();
  for (const u of utils) {
    for (const t of Array.isArray(u.tools) ? u.tools : []) {
      if (!isObj(t) || typeof t.name !== "string") continue;
      finalTools.set(t.name, Math.max(finalTools.get(t.name) ?? 0, num(t.tool_use_count) ?? 0));
    }
    const bundles = isObj(u.skills) && Array.isArray(u.skills.bundles) ? u.skills.bundles : [];
    for (const s of bundles) if (isObj(s) && typeof s.name === "string") skills.add(s.name);
    for (const s of Array.isArray(u.subagents) ? u.subagents : []) if (isObj(s) && typeof s.id === "string") subagents.add(s.id);
  }
  const toolsSorted = [...finalTools.entries()].sort((a, b) => b[1] - a[1]);

  const invMd = recs.filter((r) => r.recordType === d.investigationSummaryType);
  const mitMd = recs.filter((r) => r.recordType === d.mitigationSummaryType);
  const finalMd = invMd.length ? invMd[invMd.length - 1]!.text : "";
  const firstSum = invMd[0]?.createdAt ?? null;
  let lastAsstBefore: Date | null = null;
  for (const r of recs) {
    if (firstSum && r.createdAt.getTime() >= firstSum.getTime()) break;
    if (assistantWithText(r)) lastAsstBefore = r.createdAt;
  }

  const errPatterns = d.errorPatterns.map(([k, p, f]) => [k, pyRegex(p, f)] as const);
  const errs: Record<string, number> = Object.fromEntries(errPatterns.map(([k]) => [k, 0]));
  const authRe = pyRegex(d.authExample);
  const ws = pyRegex(String.raw`\s+`, "g");
  const examples: { rec: number; snip: string }[] = [];
  for (const r of recs) {
    if (r === promptRec || !userWithText(r)) continue;
    for (const [k, p] of errPatterns) if (p.test(r.text)) errs[k]! += 1;
    if (authRe.test(r.text)) examples.push({ rec: r.n, snip: cpSlice(r.text.trim().replace(ws, " "), d.snippetChars) });
  }

  return {
    incident: b.task.incidentId ?? b.task.taskId,
    execution: b.importHeader?.execution ?? b.rootExecutionId,
    records_header: b.importHeader?.records ?? null,
    records_parsed: recs.length,
    start_utc: t0?.toISOString() ?? null,
    end_utc: t1?.toISOString() ?? null,
    span_min: t0 && t1 ? minutesBetween(t0, t1) : null,
    first_summary_min: t0 && firstSum ? minutesBetween(t0, firstSum) : null,
    finalize_min: firstSum && lastAsstBefore ? minutesBetween(lastAsstBefore, firstSum) : null,
    types,
    prompt_chars: cpLength(prompt),
    cmdb_section: cmdb ? cmdb[1]!.trim() : null,
    description_field: desc ? desc[1]!.trim() : null,
    max_ctx_pct: ctxVals.length ? Math.max(...ctxVals) : null,
    max_compactions: compVals.length ? Math.max(...compVals) : null,
    tools: Object.fromEntries(toolsSorted),
    tool_calls_lead: toolsSorted.reduce((s, [, n]) => s + n, 0),
    skills: [...skills].sort(),
    subagents: [...subagents].sort(),
    n_inv_summaries: invMd.length,
    n_mit_summaries: mitMd.length,
    confidence_section: section(finalMd, d.confidenceHeading),
    assistant_msgs: recs.filter(assistantWithText).length,
    err_signal_msgs: errs,
    auth_err_examples: examples.slice(0, d.authExampleLimit),
    summary: summarize(b, d),
  };
}

/** Where the wall-clock time went, plus tool-call counts. */
function summarize(b: NormBundle, d: typeof RUN_METRICS_DEFAULTS): RunMetricsOutput["summary"] {
  const recs = b.records;
  const t0 = recs[0]?.createdAt.getTime() ?? 0;
  const notice = pyRegex(d.subagentNotice);
  const promptRec = recs.find(userWithText) ?? null;
  let dur = 0,
    model = 0,
    tool = 0,
    subwait = 0,
    last = 0;
  let rounds = 0,
    calls = 0,
    parentQueries = 0,
    subagentCalls = 0,
    thinking = 0,
    memReads = 0,
    skillLoads = 0,
    toolSearch = 0,
    toolErrors = 0,
    structured = 0,
    unstructured = 0,
    maxCtx = 0;
  let firstHyp: number | null = null,
    firstCause: number | null = null,
    root: number | null = null;
  const byName = new Map<string, number>();

  for (const r of recs) {
    const t = (r.createdAt.getTime() - t0) / 1000;
    dur = t;
    if (r.isMessage) {
      if (r.structured) structured++;
      else unstructured++;
      if (r.role === "assistant") {
        model += t - last;
        if (r.toolUses.length) {
          rounds++;
          calls += r.toolUses.length;
        }
        for (const th of r.thinking) thinking += th.length;
        for (const u of r.toolUses) {
          byName.set(u.name, (byName.get(u.name) ?? 0) + 1);
          if (d.parentQueryTools.includes(u.name)) parentQueries++;
          else if (u.name === d.memoryReadTool) memReads++;
          else if (u.name === d.toolSearchTool) toolSearch++;
          else if (u.name === d.subagentTool) subagentCalls++;
          if (u.name.includes("skill")) skillLoads++;
        }
      } else if (r.toolResults.length || (!r.structured && r.role === "user" && r !== promptRec && !notice.test(r.text.trimStart()))) {
        tool += t - last;
        toolErrors += r.toolResults.filter((x) => x.status === "error").length;
      } else {
        subwait += t - last;
      }
      last = t;
    } else if (r.recordType === d.utilizationType) {
      const data = isObj(r.data) && isObj(r.data.data) ? r.data.data : null;
      const u = data && isObj(data.context_window) ? num(data.context_window.utilization) : null;
      if (u !== null) maxCtx = Math.max(maxCtx, u);
    } else if (r.recordType === d.findingType && isObj(r.data)) {
      const ft = r.data.finding_type;
      firstHyp ??= t;
      if ((ft === "cause" || ft === "root_cause") && firstCause === null) firstCause = t;
      if (ft === "root_cause" && root === null) root = t;
    }
  }
  const m = (s: number) => pyRound(s / 60, 1);
  return {
    dur_min: m(dur),
    model_min: m(model),
    tool_min: m(tool),
    subwait_min: m(subwait),
    rounds,
    calls,
    calls_per_round: pyRound(calls / Math.max(rounds, 1), 1),
    tool_calls_by_name: Object.fromEntries([...byName.entries()].sort((a, b) => b[1] - a[1])),
    parent_queries: parentQueries,
    subagent_calls: subagentCalls,
    thinking_chars: thinking,
    mem_reads: memReads,
    skill_loads: skillLoads,
    tool_search: toolSearch,
    tool_errors: toolErrors,
    first_hyp_min: firstHyp === null ? null : m(firstHyp),
    first_cause_min: firstCause === null ? null : m(firstCause),
    root_min: root === null ? null : m(root),
    max_ctx: maxCtx,
    structured_messages: structured,
    unstructured_messages: unstructured,
  };
}

export const runMetricsAnalyzer: Analyzer<RunMetricsOutput> = {
  id: "run-metrics",
  version: "1.0.0",
  label: "Run metrics",
  description: "Tool calls by name, error classes, subagents, skills, time split and time to first summary",
  requires: [],
  configDigest: () => "",
  run: (b) => runMetrics(b),
};
