import type { NormBundle } from "@/server/analyzers/normalize";
import type { Citation, CitationCheck } from "@/server/audits/contract";
import { recordTexts } from "./records";

/**
 * Citation check, independent of any profile
 * schema. Walking the review output:
 *   - an object with an integer `record` (and an optional string `quote`) is a citation
 *   - an integer field whose name ends in `_record` is a citation
 *   - every "R<number>" in a string is a citation without a quote
 * Strings under a `quote` key are quoted record text, not claims, so their
 * R<number> mentions are not counted.
 *
 * A citation passes when its record exists (1 to the number of records,
 * NormRecord.n) and its quote, if any, appears in that record's text after
 * normalizing Unicode, quotes, whitespace and case. "..." (or "…") in a quote
 * stands for skipped text: the parts must appear in order.
 */

export interface FoundCitation {
  record: number;
  quote: string | null;
  field: string;
  /** From a `supports` key next to `record` (top-level `citations` entries) */
  supports?: string;
}

const R_MENTION = /\bR(\d{1,7})\b/g;

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** Every citation in a review output, with the JSON path of the field that makes it. */
export function collectCitations(output: unknown): FoundCitation[] {
  const found: FoundCitation[] = [];
  const seen = new Set<string>();
  const add = (c: FoundCitation) => {
    const key = `${c.field}\0${c.record}\0${c.quote ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(c);
  };
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(R_MENTION)) add({ record: Number(m[1]), quote: null, field: path || "$" });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!v || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    const hasRecord = Number.isInteger(obj.record);
    if (hasRecord) {
      const q = typeof obj.quote === "string" && obj.quote.trim() ? obj.quote : null;
      const supports = typeof obj.supports === "string" && obj.supports.trim() ? obj.supports.trim().slice(0, 100) : undefined;
      add({ record: obj.record as number, quote: q, field: path || "$", ...(supports ? { supports } : {}) });
    }
    for (const [k, child] of Object.entries(obj)) {
      if (k === "quote") continue;
      if (k === "record" && hasRecord) continue;
      const p = join(path, k);
      if (k.endsWith("_record") && Number.isInteger(child)) {
        add({ record: child as number, quote: null, field: p });
        continue;
      }
      walk(child, p);
    }
  };
  walk(output, "");
  return found;
}

/** NFKC, straight quotes and dashes, lower case, single spaces. NFKC turns "…" into "...". */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** JSON escapes and markdown emphasis removed, for quotes copied from rendered text. */
function plain(s: string): string {
  return s
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/[*_`#>|]+/g, " ");
}

function variants(s: string): [string, string] {
  return [normalizeForQuote(s), normalizeForQuote(plain(s))];
}

function partsOf(quote: string): string[] {
  return quote
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .split(/\.{3,}/)
    .map((p) => p.replace(/^["'\s]+|["'\s]+$/g, "").trim())
    .filter(Boolean);
}

function inOrder(parts: string[], text: string): boolean {
  let pos = 0;
  for (const p of parts) {
    const i = text.indexOf(p, pos);
    if (i < 0) return false;
    pos = i + p.length;
  }
  return true;
}

/** Whether `quote` appears in `text` (both raw), with the normalization above. */
export function quoteInText(quote: string, text: string): boolean {
  return quoteInVariants(quote, variants(text));
}

function quoteInVariants(quote: string, textVariants: [string, string]): boolean {
  const [q1, q2] = variants(quote);
  const p1 = partsOf(q1);
  if (!p1.length) return true;
  if (inOrder(p1, textVariants[0])) return true;
  const p2 = partsOf(q2);
  return p2.length > 0 && inOrder(p2, textVariants[1]);
}

const normCache = new WeakMap<NormBundle, ([string, string] | undefined)[]>();

function normalizedText(bundle: NormBundle, n: number): [string, string] {
  let arr = normCache.get(bundle);
  if (!arr) {
    arr = new Array(bundle.records.length);
    normCache.set(bundle, arr);
  }
  let v = arr[n - 1];
  if (!v) {
    v = variants(recordTexts(bundle)[n - 1] ?? "");
    arr[n - 1] = v;
  }
  return v;
}

export function checkCitation(c: FoundCitation, bundle: NormBundle): Citation {
  const count = bundle.records.length;
  if (!Number.isInteger(c.record) || c.record < 1 || c.record > count) return { ...c, ok: false, problem: "missing-record" };
  if (c.quote !== null && !quoteInVariants(c.quote, normalizedText(bundle, c.record))) return { ...c, ok: false, problem: "quote-not-found" };
  return { ...c, ok: true };
}

/** Checks every citation in a review output against the investigation's records. */
export function checkCitations(output: unknown, bundle: NormBundle): CitationCheck {
  const citations = collectCitations(output).map((c) => checkCitation(c, bundle));
  const failed = citations.filter((c) => !c.ok).length;
  return { ok: failed === 0, checked: citations.length, failed, citations };
}
