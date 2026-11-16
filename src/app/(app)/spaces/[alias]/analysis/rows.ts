/**
 * Table rows for the analysis list: the latest run-metrics output reduced to
 * the columns the table shows. Pure; the page adds the rendered time.
 */

export interface AnalysisRowInput {
  taskId: string;
  incidentId: string | null;
  title: string | null;
  source: "api" | "import";
  records: number;
  metrics: Record<string, unknown> | null;
  metricsAt: Date | null;
}

export interface AnalysisRow {
  taskId: string;
  href: string;
  /** Incident ID, else task ID */
  name: string;
  /** True when `name` is the task ID (shown in monospace) */
  nameIsTaskId: boolean;
  title: string;
  source: "api" | "import";
  records: number;
  spanMin: number | null;
  firstSummaryMin: number | null;
  leadToolCalls: number | null;
  subagents: number | null;
  maxContextPct: number | null;
  /** HTTP 401 plus 403 signals; null when the metrics have neither */
  authErrorSignals: number | null;
  analyzed: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function toAnalysisRow(r: AnalysisRowInput, base: string): AnalysisRow {
  const m = r.metrics ?? {};
  const errs = (m.err_signal_msgs && typeof m.err_signal_msgs === "object" ? m.err_signal_msgs : {}) as Record<string, unknown>;
  const e401 = num(errs.http_401);
  const e403 = num(errs.http_403);
  return {
    taskId: r.taskId,
    href: `${base}/${encodeURIComponent(r.taskId)}`,
    name: r.incidentId ?? r.taskId,
    nameIsTaskId: r.incidentId === null,
    title: r.title ?? "",
    source: r.source,
    records: r.records,
    spanMin: num(m.span_min),
    firstSummaryMin: num(m.first_summary_min),
    leadToolCalls: num(m.tool_calls_lead),
    subagents: Array.isArray(m.subagents) ? m.subagents.length : null,
    maxContextPct: num(m.max_ctx_pct),
    authErrorSignals: e401 !== null || e403 !== null ? (e401 ?? 0) + (e403 ?? 0) : null,
    analyzed: r.metricsAt !== null,
  };
}

/** Whole numbers as they are, others to `digits` places; empty for no value. */
export function fmtMetric(n: number | null, digits = 1): string {
  if (n === null) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}
