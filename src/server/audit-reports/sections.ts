import type { AuditProfile } from "@/server/policy/sections/audits";
import type {
  ColumnHead,
  ComputedContent,
  CountRow,
  CountTableContent,
  FindingsTableContent,
  IncidentBlock,
  IncidentListContent,
  LabeledValue,
  MetricsTableContent,
  ReportFinding,
  ReportInputs,
  ReportItem,
  ReportSectionConfig,
} from "./types";

/**
 * Computed report sections: counts
 * and tables across incidents, built in code from accepted findings and
 * analyzer output. Pure. One function per `report.sections[].kind` except
 * "narrative". Every value is untrusted text; renderers escape it.
 */

type Extractor = AuditProfile["findings"][number];

/** How an incident is named in tables: its incident ID, else the task ID. */
export function incidentName(x: { incidentId: string | null; taskId: string }): string {
  return x.incidentId ?? x.taskId;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Natural order: INCIDENT-9 before INCIDENT-10. */
export function compareIncidents(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A dotted path into a JSON value ("tools.by_name.search"); array indexes are plain segments. */
export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = Object.prototype.hasOwnProperty.call(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Readable labels of a profile label set (failureModes or fixOwners), by ID. */
export function labelSet(profile: AuditProfile, source: "failureModes" | "fixOwners" | undefined): Map<string, string> | null {
  if (!source) return null;
  return new Map(profile[source].map((x) => [x.id, x.label]));
}

/** Value labels for a column: a profile label set or the section's own map. */
export function columnLabelMap(profile: AuditProfile, spec: "failureModes" | "fixOwners" | Record<string, string> | undefined): Map<string, string> | null {
  if (!spec) return null;
  return typeof spec === "string" ? labelSet(profile, spec) : new Map(Object.entries(spec));
}

function scalarText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return null;
}

/** Values of a field for counting: one key per array element, none for a missing or empty value. */
export function countKeys(v: unknown): string[] {
  const one = (x: unknown): string | null => {
    const s = scalarText(x);
    if (s !== null) return s.trim() === "" ? null : s;
    if (x && typeof x === "object") return JSON.stringify(x);
    return null;
  };
  if (Array.isArray(v)) return [...new Set(v.map(one).filter((s): s is string => s !== null))];
  const s = one(v);
  return s === null ? [] : [s];
}

/**
 * A finding value as display text. Arrays join with ", ". An object with a
 * numeric `record` is a record citation and reads "R<n>" (the system's
 * convention for record numbers); other objects show as compact JSON.
 */
export function displayValue(v: unknown, labels?: Map<string, string> | null): string {
  if (Array.isArray(v)) {
    return v
      .map((x) => displayValue(x, labels))
      .filter((s) => s !== "")
      .join(", ");
  }
  const s = scalarText(v);
  if (s !== null) return labels?.get(s) ?? s;
  if (v && typeof v === "object") {
    const rec = (v as { record?: unknown }).record;
    if (typeof rec === "number" && Number.isInteger(rec)) return `R${rec}`;
    return JSON.stringify(v);
  }
  return "";
}

/** A metric value as display text: numbers rounded to two decimals, null when there is none. */
export function displayMetric(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : null;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => displayMetric(x) ?? "").join(", ");
  return JSON.stringify(v);
}

function extractorFor(profile: AuditProfile, kind: string | undefined): Extractor | null {
  return profile.findings.find((f) => f.kind === kind) ?? null;
}

/** The enum values the review output schema allows for an extractor's field, in schema order. */
export function schemaEnum(schema: unknown, extractor: Extractor | null, field: string): string[] | null {
  if (!extractor || !schema || typeof schema !== "object") return null;
  const props = (node: unknown): Record<string, unknown> | null => {
    const p = node && typeof node === "object" ? (node as { properties?: unknown }).properties : undefined;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  };
  let base = props(schema);
  if (extractor.from !== "$") {
    const arr = base?.[extractor.from];
    const items = arr && typeof arr === "object" ? (arr as { items?: unknown }).items : undefined;
    base = props(items);
  }
  const node = base?.[field] as { enum?: unknown; items?: { enum?: unknown } } | undefined;
  const values = Array.isArray(node?.enum) ? node.enum : Array.isArray(node?.items?.enum) ? node.items.enum : null;
  if (!values) return null;
  return values.filter((x): x is string => typeof x === "string");
}

function header(section: ReportSectionConfig, id: string, profile?: AuditProfile): string {
  return section.headers?.[id] ?? (profile ? extractorFor(profile, section.findingKind)?.fieldLabels?.[id] : undefined) ?? id;
}

/**
 * Value labels for a finding field the section gives no labels for, as the
 * audit pages read them: the extractor's valueLabels for the field, then the
 * profile's failure modes, fix owners and cohorts. So an owner reads "Customer
 * memory or runbook content", never "customer_memory".
 */
export function defaultValueLabels(profile: AuditProfile, kind: string | undefined, field: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (id: string, label: string) => {
    if (!out.has(id)) out.set(id, label);
  };
  for (const [id, label] of Object.entries(extractorFor(profile, kind)?.valueLabels?.[field] ?? {})) add(id, label);
  for (const x of [...profile.failureModes, ...profile.fixOwners, ...profile.cohorts]) add(x.id, x.label);
  return out;
}

function findingsOfKind(inputs: ReportInputs, kind: string | undefined): ReportFinding[] {
  return inputs.findings
    .filter((f) => f.kind === kind)
    .sort((a, b) => compareIncidents(incidentName(a), incidentName(b)) || a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
}

/** count-table: accepted findings of `findingKind` counted by `field`; every known value listed, then unknown values, then findings without one. */
export function countTable(section: ReportSectionConfig, inputs: ReportInputs): CountTableContent {
  const { profile } = inputs;
  const field = section.field ?? "";
  const findings = findingsOfKind(inputs, section.findingKind);
  const labels = labelSet(profile, section.labels) ?? (section.valueLabels ? new Map(Object.entries(section.valueLabels)) : defaultValueLabels(profile, section.findingKind, field));
  const known = section.labels
    ? profile[section.labels].map((x) => x.id)
    : section.valueLabels
      ? Object.keys(section.valueLabels)
      : (schemaEnum(inputs.outputSchema, extractorFor(profile, section.findingKind), field) ?? []);

  const counts = new Map<string, number>();
  let missing = 0;
  for (const f of findings) {
    const keys = countKeys(f.values[field]);
    if (!keys.length) missing++;
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const knownSet = new Set(known);
  const rows: CountRow[] = known.map((value) => ({ value, label: labels?.get(value) ?? value, count: counts.get(value) ?? 0, known: true }));
  const unknown = [...counts.keys()].filter((k) => !knownSet.has(k)).sort((a, b) => counts.get(b)! - counts.get(a)! || compareIncidents(a, b));
  for (const value of unknown) rows.push({ value, label: labels?.get(value) ?? value, count: counts.get(value)!, known: false });
  if (missing) rows.push({ value: null, label: profile.report.missingValueLabel, count: missing, known: false });
  return { type: "count-table", findingKind: section.findingKind ?? "", field, header: header(section, field, profile), total: findings.length, rows };
}

/** findings-table: one row per accepted finding of `findingKind`, cells from `columns` (default: the extractor's fields). */
export function findingsTable(section: ReportSectionConfig, inputs: ReportInputs): FindingsTableContent {
  const extractor = extractorFor(inputs.profile, section.findingKind);
  const columnIds = section.columns ?? extractor?.fields ?? [];
  const labelsBy = new Map(columnIds.map((c) => [c, columnLabelMap(inputs.profile, section.columnLabels?.[c]) ?? defaultValueLabels(inputs.profile, section.findingKind, c)]));
  const columns: ColumnHead[] = columnIds.map((id) => ({ id, header: header(section, id, inputs.profile) }));
  const rows = findingsOfKind(inputs, section.findingKind).map((f) => ({
    findingId: f.id,
    incident: incidentName(f),
    title: f.title,
    cells: columnIds.map((c) => displayValue(getPath(f.values, c), labelsBy.get(c))),
  }));
  return { type: "findings-table", findingKind: section.findingKind ?? "", columns, rows };
}

/** incident-list: one block per incident with an accepted finding of `findingKind`: its title, evidence fields (the score) and the diagnosis. */
export function incidentList(section: ReportSectionConfig, inputs: ReportInputs): IncidentListContent {
  const { profile } = inputs;
  const extractor = extractorFor(profile, section.findingKind);
  const fieldIds = section.columns ?? extractor?.fields ?? [];
  const evidenceLabels = new Map<string, string>();
  for (const input of profile.inputs) for (const [id, f] of Object.entries(input.fields)) if (!evidenceLabels.has(id)) evidenceLabels.set(id, f.label);
  const evidenceIds = section.evidenceFields ?? [...evidenceLabels.keys()];
  const labelsBy = new Map(fieldIds.map((c) => [c, columnLabelMap(profile, section.columnLabels?.[c]) ?? defaultValueLabels(profile, section.findingKind, c)]));

  const seen = new Set<string>();
  const incidents: IncidentBlock[] = [];
  for (const f of findingsOfKind(inputs, section.findingKind)) {
    // One block per investigation: the first finding of the kind (a "$" extractor makes exactly one)
    if (seen.has(f.auditItemId)) continue;
    seen.add(f.auditItemId);
    const ev = f.incidentId ? (inputs.evidence[f.incidentId] ?? {}) : {};
    const evidence: LabeledValue[] = evidenceIds
      .map((id) => ({ id, label: section.headers?.[id] ?? evidenceLabels.get(id) ?? id, value: ev[id] ?? "" }))
      .filter((e) => e.value.trim() !== "");
    const fields: LabeledValue[] = fieldIds
      .map((id) => ({ id, label: header(section, id, profile), value: displayValue(getPath(f.values, id), labelsBy.get(id)) }))
      .filter((e) => e.value.trim() !== "");
    incidents.push({ incident: incidentName(f), taskId: f.taskId, findingId: f.id, title: f.title, evidence, fields });
  }
  return { type: "incident-list", findingKind: section.findingKind ?? "", incidents };
}

/** The median of the finite numbers in `xs`, or null when there are none. */
export function median(xs: unknown[]): number | null {
  const nums = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

/** metrics-table: the latest output of `analyzer` per investigation (skipped ones left out), `columns` as dotted paths, with each column's median. */
export function metricsTable(section: ReportSectionConfig, inputs: ReportInputs): MetricsTableContent {
  const analyzer = section.analyzer ?? "";
  const paths = section.columns ?? [];
  const items = inputs.items.filter((i) => i.state !== "skipped").sort((a: ReportItem, b: ReportItem) => compareIncidents(incidentName(a), incidentName(b)));
  const runs = items.map((i) => inputs.analyzerRuns[i.taskId]?.[analyzer]);
  return {
    type: "metrics-table",
    analyzer,
    columns: paths.map((id) => ({ id, header: header(section, id) })),
    rows: items.map((i, n) => {
      const run = runs[n];
      return {
        incident: incidentName(i),
        taskId: i.taskId,
        analyzerVersion: run?.version ?? null,
        cells: paths.map((p) => (run ? displayMetric(getPath(run.output, p)) : null)),
        missing: !run,
      };
    }),
    medians: paths.map((p) => displayMetric(median(runs.map((r) => (r ? getPath(r.output, p) : undefined))))),
  };
}

/** The computed content of a section, or null for a narrative section. */
export function computeSection(section: ReportSectionConfig, inputs: ReportInputs): ComputedContent | null {
  switch (section.kind) {
    case "count-table":
      return countTable(section, inputs);
    case "findings-table":
      return findingsTable(section, inputs);
    case "incident-list":
      return incidentList(section, inputs);
    case "metrics-table":
      return metricsTable(section, inputs);
    case "narrative":
      return null;
  }
}
