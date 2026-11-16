import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CitationCheck } from "@/server/audits/contract";

/**
 * Comparison of app reviews with reference reviews written by hand: the
 * reference reviews are the set the app's reviews are compared with
 * (sample-data/audit/reviews holds the sample set). Compares primary failure
 * mode, failure modes (Jaccard overlap), reachability, scorecard fairness,
 * fix owners (Jaccard overlap) and both citation check results. Field names are the benchmark profile's.
 *
 * The reference reviews wrote record numbers as strings ("R76", sometimes
 * "R48, R55" or "R167 (...)"). convertReferenceReview turns them into the
 * benchmark schema's shape; the citation check of a reference review runs on
 * the raw file, so every R<number> in it is checked.
 */

const FIRST_R = /\bR(\d{1,7})\b/;

function firstRecord(v: unknown): number | null {
  if (Number.isInteger(v)) return v as number;
  if (typeof v !== "string") return null;
  const m = FIRST_R.exec(v);
  return m ? Number(m[1]) : null;
}

function allRecords(s: unknown): number[] {
  if (typeof s !== "string") return [];
  return [...new Set([...s.matchAll(/\bR(\d{1,7})\b/g)].map((m) => Number(m[1])))];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A reference review in the benchmark schema's shape: record strings become the
 * first record number they name, `incident_created_kst` becomes
 * `incident_created`, "not determinable" and "not applicable" become the enum
 * values, each fix gets `evidence` from the records its text cites, and
 * `citations` is added (empty). Unknown keys are kept as they are.
 */
export function convertReferenceReview(raw: unknown): Obj {
  if (!isObj(raw)) return {};
  const out: Obj = structuredClone(raw);
  for (const key of ["summaries", "blocking_errors"]) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map((x) => (isObj(x) ? { ...x, record: firstRecord(x.record) } : x));
  }
  for (const [k, v] of Object.entries(out)) if (k.endsWith("_record") && typeof v === "string") out[k] = firstRecord(v);
  if (isObj(out.timing)) {
    const t: Obj = { ...out.timing };
    if ("incident_created_kst" in t && !("incident_created" in t)) {
      t.incident_created = t.incident_created_kst;
      delete t.incident_created_kst;
    }
    if (typeof t.decisive_evidence_existed_at_run_time === "string") {
      t.decisive_evidence_existed_at_run_time = t.decisive_evidence_existed_at_run_time.trim().replace(/\s+/g, "_");
    }
    out.timing = t;
  }
  if (typeof out.scorecard_fair === "string") out.scorecard_fair = out.scorecard_fair.trim().replace(/\s+/g, "_");
  if (Array.isArray(out.fixes)) {
    out.fixes = out.fixes.map((f) => (isObj(f) && !("evidence" in f) ? { ...f, evidence: allRecords(f.fix).map((record) => ({ record, quote: null })) } : f));
  }
  if (!("citations" in out)) out.citations = [];
  return out;
}

export interface ReferenceReview {
  incident: string;
  file: string;
  /** The file as written (for the citation check) */
  raw: unknown;
  /** In the benchmark schema's shape (for the comparison) */
  converted: Obj;
}

/** `<dir>/<incident>.json`, or null when there is none. The incident ID must be a plain name (no path parts). */
export function loadReferenceReview(dir: string, incident: string): ReferenceReview | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(incident) || incident.includes("..")) return null;
  const file = path.join(dir, `${incident}.json`);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  return { incident, file, raw, converted: convertReferenceReview(raw) };
}

export interface ReviewFields {
  primaryFailureMode: string | null;
  failureModes: string[];
  reachability: string | null;
  scorecardFair: string | null;
  fixOwners: string[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map(str).filter((x): x is string => x !== null))].sort() : []);

/** The compared fields of a review output (app or converted reference). */
export function reviewFields(output: unknown): ReviewFields {
  const o = isObj(output) ? output : {};
  return {
    primaryFailureMode: str(o.primary_failure_mode),
    failureModes: strs(o.failure_modes),
    reachability: str(o.reachability),
    scorecardFair: str(o.scorecard_fair),
    fixOwners: strs(Array.isArray(o.fixes) ? o.fixes.map((f) => (isObj(f) ? f.owner : null)) : []),
  };
}

/** |A ∩ B| / |A ∪ B|; 1 when both are empty. */
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const union = new Set([...A, ...B]);
  if (!union.size) return 1;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / union.size;
}

export interface FieldComparison {
  app: string | null;
  reference: string | null;
  equal: boolean;
}

export interface SetComparison {
  app: string[];
  reference: string[];
  shared: string[];
  jaccard: number;
}

export interface CitationSummary {
  checked: number;
  failed: number;
  ok: boolean;
}

export interface ReviewComparison {
  incident: string;
  /** False when the app has no output to compare */
  comparable: boolean;
  primaryFailureMode: FieldComparison;
  failureModes: SetComparison;
  reachability: FieldComparison;
  scorecardFair: FieldComparison;
  fixOwners: SetComparison;
  citations: { app: CitationSummary | null; reference: CitationSummary | null };
}

const field = (app: string | null, reference: string | null): FieldComparison => ({ app, reference, equal: app !== null && app === reference });
const set = (app: string[], reference: string[]): SetComparison => ({ app, reference, shared: app.filter((x) => reference.includes(x)), jaccard: jaccard(app, reference) });
const summary = (c: CitationCheck | null | undefined): CitationSummary | null => (c ? { checked: c.checked, failed: c.failed, ok: c.ok } : null);

export function compareReviews(
  incident: string,
  app: unknown,
  reference: unknown,
  citations: { app?: CitationCheck | null; reference?: CitationCheck | null } = {},
): ReviewComparison {
  const a = reviewFields(app);
  const r = reviewFields(reference);
  return {
    incident,
    comparable: isObj(app),
    primaryFailureMode: field(a.primaryFailureMode, r.primaryFailureMode),
    failureModes: set(a.failureModes, r.failureModes),
    reachability: field(a.reachability, r.reachability),
    scorecardFair: field(a.scorecardFair, r.scorecardFair),
    fixOwners: set(a.fixOwners, r.fixOwners),
    citations: { app: summary(citations.app), reference: summary(citations.reference) },
  };
}

export interface ComparisonTotals {
  incidents: number;
  comparable: number;
  primaryFailureModeEqual: number;
  reachabilityEqual: number;
  scorecardFairEqual: number;
  /** Mean over comparable incidents, 0 to 1 */
  meanFailureModeJaccard: number | null;
  meanFixOwnerJaccard: number | null;
  appCitationsFailed: number;
  appCitationsChecked: number;
  referenceCitationsFailed: number;
  referenceCitationsChecked: number;
}

export function totalComparisons(list: ReviewComparison[]): ComparisonTotals {
  const c = list.filter((x) => x.comparable);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const sum = (f: (x: ReviewComparison) => number) => list.reduce((s, x) => s + f(x), 0);
  return {
    incidents: list.length,
    comparable: c.length,
    primaryFailureModeEqual: c.filter((x) => x.primaryFailureMode.equal).length,
    reachabilityEqual: c.filter((x) => x.reachability.equal).length,
    scorecardFairEqual: c.filter((x) => x.scorecardFair.equal).length,
    meanFailureModeJaccard: mean(c.map((x) => x.failureModes.jaccard)),
    meanFixOwnerJaccard: mean(c.map((x) => x.fixOwners.jaccard)),
    appCitationsFailed: sum((x) => x.citations.app?.failed ?? 0),
    appCitationsChecked: sum((x) => x.citations.app?.checked ?? 0),
    referenceCitationsFailed: sum((x) => x.citations.reference?.failed ?? 0),
    referenceCitationsChecked: sum((x) => x.citations.reference?.checked ?? 0),
  };
}

const yes = (b: boolean) => (b ? "same" : "differs");
const cites = (c: CitationSummary | null) => (c ? `${c.checked - c.failed}/${c.checked} ok` : "none");
const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "0/0");

/** Plain-text report: one block per incident, then totals. */
export function formatComparisons(list: ReviewComparison[]): string {
  const lines: string[] = [];
  for (const x of list) {
    lines.push(`${x.incident}${x.comparable ? "" : " (no app output)"}`);
    lines.push(`  primary failure mode  ${yes(x.primaryFailureMode.equal)}: app ${x.primaryFailureMode.app ?? "-"}, reference ${x.primaryFailureMode.reference ?? "-"}`);
    lines.push(`  failure modes         Jaccard ${x.failureModes.jaccard.toFixed(2)}: app [${x.failureModes.app.join(", ")}], reference [${x.failureModes.reference.join(", ")}]`);
    lines.push(`  reachability          ${yes(x.reachability.equal)}: app ${x.reachability.app ?? "-"}, reference ${x.reachability.reference ?? "-"}`);
    lines.push(`  scorecard fair        ${yes(x.scorecardFair.equal)}: app ${x.scorecardFair.app ?? "-"}, reference ${x.scorecardFair.reference ?? "-"}`);
    lines.push(`  fix owners            Jaccard ${x.fixOwners.jaccard.toFixed(2)}: app [${x.fixOwners.app.join(", ")}], reference [${x.fixOwners.reference.join(", ")}]`);
    lines.push(`  citations             app ${cites(x.citations.app)}, reference ${cites(x.citations.reference)}`);
  }
  const t = totalComparisons(list);
  lines.push("");
  lines.push(`Totals over ${t.comparable} comparable of ${t.incidents} incidents`);
  lines.push(`  primary failure mode equal  ${pct(t.primaryFailureModeEqual, t.comparable)}`);
  lines.push(`  reachability equal          ${pct(t.reachabilityEqual, t.comparable)}`);
  lines.push(`  scorecard fairness equal    ${pct(t.scorecardFairEqual, t.comparable)}`);
  lines.push(`  mean failure-mode Jaccard   ${t.meanFailureModeJaccard === null ? "-" : t.meanFailureModeJaccard.toFixed(2)}`);
  lines.push(`  mean fix-owner Jaccard      ${t.meanFixOwnerJaccard === null ? "-" : t.meanFixOwnerJaccard.toFixed(2)}`);
  lines.push(`  citations failed            app ${t.appCitationsFailed} of ${t.appCitationsChecked}, reference ${t.referenceCitationsFailed} of ${t.referenceCitationsChecked}`);
  return lines.join("\n");
}
