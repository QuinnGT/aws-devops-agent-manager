import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelCatalog } from "@/server/ai/models";
import type { Citation, CitationCheck } from "./contract";

/**
 * Test helpers: the benchmark reference reviews (sample-data/audit/reviews) as a reviewer would return them.
 * Not used by app code, but by the demo seed. The reference review files cite records as strings ("R76") and
 * have no `citations` key; this converts record references to numbers, moves
 * the references in each fix's text into `fixes[i].evidence`, builds a
 * `citations` list from the other text fields, and a citation check over all
 * of them (every citation ok, as if the records exist).
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const REF = /\bR(\d{1,5})\b/g;

const refs = (s: string) => [...s.matchAll(REF)].map((m) => Number(m[1]));
const recordNo = (v: unknown) => (typeof v === "string" && /^R\d+$/.test(v) ? Number(v.slice(1)) : typeof v === "number" ? v : null);

/** R-references in every string under `v`, with the JSON path of the string. */
function collectRefs(v: unknown, at: string, out: { path: string; record: number }[]): void {
  if (typeof v === "string") for (const r of refs(v)) out.push({ path: at, record: r });
  else if (Array.isArray(v)) v.forEach((x, i) => collectRefs(x, `${at}[${i}]`, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) collectRefs(x, at ? `${at}.${k}` : k, out);
}

export interface BenchmarkFixture {
  incident: string;
  output: Obj;
  citationCheck: CitationCheck;
  /** Citations expected on the diagnosis finding: references in the diagnosis fields' text */
  expectedDiagnosisCitations: number;
  /** Per fix: its evidence entries */
  expectedFixCitations: number[];
}

export function benchmarkFixture(raw: Obj, diagnosisFields: readonly string[]): BenchmarkFixture {
  const out: Obj = structuredClone(raw);
  const citations: Citation[] = [];
  for (const key of ["summaries", "blocking_errors"]) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    arr.forEach((el, i) => {
      if (!isObj(el)) return;
      const n = recordNo(el.record);
      el.record = n;
      if (n !== null) citations.push({ record: n, quote: null, field: `${key}[${i}].record`, ok: true });
    });
  }
  const scored = recordNo(out.scored_summary_record);
  out.scored_summary_record = scored;
  if (scored !== null) citations.push({ record: scored, quote: null, field: "scored_summary_record", ok: true });

  const fixes = Array.isArray(out.fixes) ? (out.fixes as Obj[]) : [];
  const expectedFixCitations: number[] = [];
  fixes.forEach((fix, i) => {
    const ev = refs(String(fix.fix ?? "")).map((record) => ({ record, quote: null }));
    fix.evidence = ev;
    expectedFixCitations.push(ev.length);
    ev.forEach((e, j) => citations.push({ record: e.record, quote: null, field: `fixes[${i}].evidence[${j}]`, ok: true }));
  });

  const textRefs: { path: string; record: number }[] = [];
  for (const [k, v] of Object.entries(out)) if (!["summaries", "blocking_errors", "fixes", "scored_summary_record"].includes(k)) collectRefs(v, k, textRefs);
  out.citations = textRefs.map((r) => ({ record: r.record, quote: null, supports: r.path }));
  for (const r of textRefs) citations.push({ record: r.record, quote: null, field: r.path, ok: true });

  const top = (p: string) => p.split(/[.[]/)[0]!;
  return {
    incident: String(out.incident),
    output: out,
    citationCheck: { ok: true, checked: citations.length, failed: 0, citations },
    expectedDiagnosisCitations: textRefs.filter((r) => diagnosisFields.includes(top(r.path))).length,
    expectedFixCitations,
  };
}

/**
 * A model catalogue that answers at once with one model, for tests and the
 * demo seed: they start audits whose reviews come from a fake runReview, so
 * startAudit's Bedrock check must not resolve real AWS credentials.
 */
export function reachableCatalog(modelId = "example.reviewer-model"): (space: unknown, actor: unknown, region: string) => Promise<ModelCatalog> {
  return async (_space, _actor, region) => ({
    region,
    models: [{ id: modelId, label: modelId, kind: "foundation-model", provider: "Example", status: "ACTIVE" }],
    error: null,
    errorKind: null,
    errorDetail: null,
    fetchedAt: new Date(0).toISOString(),
  });
}

/** The reviews folder's JSON files under `auditDir` (sample-data/audit), or [] when the folder is not there. */
export function benchmarkReviews(auditDir: string): { file: string; raw: Obj }[] {
  const dir = path.join(auditDir, "reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^INCIDENT-\d+\.json$/.test(f))
    .sort()
    .map((f) => ({ file: f, raw: JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Obj }));
}
