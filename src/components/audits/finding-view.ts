/**
 * How a finding card lays out its fields and citations (pages/audit-item.md,
 * "Finding card"). Pure; unit-tested.
 */

export interface CardField {
  key: string;
  label: string;
  value: unknown;
  valueLabel: string;
  editable: boolean;
  choices: { value: string; label: string }[] | null;
  multiple: boolean;
  changed: boolean;
}

export interface CardRow {
  field: CardField;
  /** A `<key>_reason` or `<key>_notes` field shown under this one */
  detail: CardField | null;
}

const DETAIL_SUFFIXES = ["_reason", "_notes"];

/** The field a "<prefix>_reason" or "<prefix>_notes" field explains: "<prefix>" itself, else the first "<prefix>_..." field. */
function detailOwner(key: string, keys: readonly string[]): string | null {
  const suffix = DETAIL_SUFFIXES.find((s) => key.endsWith(s));
  if (!suffix) return null;
  const prefix = key.slice(0, -suffix.length);
  if (!prefix) return null;
  if (keys.includes(prefix)) return prefix;
  return keys.find((k) => k !== key && k.startsWith(`${prefix}_`) && !DETAIL_SUFFIXES.some((s) => k.endsWith(s))) ?? null;
}

/** Rows of a card: hidden fields left out, and "reachability_reason" shown under "reachability" ("scorecard_notes" under "scorecard_fair"). */
export function cardRows(fields: readonly CardField[], hidden: readonly string[] = []): CardRow[] {
  const visible = fields.filter((f) => !hidden.includes(f.key));
  const keys = visible.map((f) => f.key);
  const ownerOf = new Map(visible.map((f) => [f.key, detailOwner(f.key, keys)]));
  return visible
    .filter((f) => !ownerOf.get(f.key))
    .map((f) => ({ field: f, detail: visible.find((d) => ownerOf.get(d.key) === f.key) ?? null }));
}

export interface CitationRef {
  record: number;
  quote: string | null;
  field: string;
  supports?: string;
  ok: boolean;
  problem?: "missing-record" | "quote-not-found";
  /** A reviewer read the record: `by` is their display name, `at` the time as text */
  checked?: { by: string; at: string; note: string } | null;
}

/**
 * The finding field a citation belongs to: the top key of its JSON path after
 * the extractor's array element ("fixes[0].evidence[1]" -> "evidence" for an
 * extractor `from: fixes`), or the key a top-level `citations` entry supports.
 */
export function citationField(c: Pick<CitationRef, "field" | "supports">, from: string): string {
  let path = c.field;
  if (from !== "$") path = path.replace(new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[\\d+\\]\\.?`), "");
  const top = path.split(/[.[]/)[0] ?? "";
  if ((top === "citations" || top === "") && c.supports) return c.supports.split(/[.[]/)[0] ?? c.supports;
  return top;
}

/** Citations grouped by field; ones whose field the card doesn't show go under "" (shown as "Other citations"). One chip per record and field. */
export function citationsByField<T extends CitationRef>(citations: readonly T[], from: string, shown: readonly string[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const c of citations) {
    const f = citationField(c, from);
    const key = shown.includes(f) ? f : "";
    const list = out.get(key) ?? [];
    const same = list.findIndex((x) => x.record === c.record);
    if (same < 0) list.push(c);
    else if (!c.ok && (list[same]!.ok || (list[same]!.checked && !c.checked))) list[same] = c;
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.record - b.record);
  return out;
}

/** Quotes from the citations of one record, for highlighting it in the record card. */
export function quotesFor(citations: readonly CitationRef[], record: number): string[] {
  return [...new Set(citations.filter((c) => c.record === record && c.quote).map((c) => c.quote!))];
}

/** The first record to open: the first citation of the first proposed finding, else of any finding. */
export function firstCitation(findings: readonly { state: string; citations: readonly CitationRef[] }[]): CitationRef | null {
  const pick = (fs: readonly { citations: readonly CitationRef[] }[]) => fs.flatMap((f) => f.citations).find((c) => c.ok) ?? fs.flatMap((f) => f.citations)[0] ?? null;
  return pick(findings.filter((f) => f.state === "proposed")) ?? pick(findings);
}

/** A field whose value is a list of record citations (objects), such as a fix's evidence: shown as chips, or "No records cited" when empty. */
export function isCitationList(field: Pick<CardField, "value" | "choices">): boolean {
  return !field.choices && Array.isArray(field.value) && field.value.every((x) => !!x && typeof x === "object");
}

/** Values for the edit form's fields, compared with the current ones; only changed editable fields are sent. */
export function changedValues(current: Record<string, unknown>, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edited)) if (JSON.stringify(v) !== JSON.stringify(current[k])) out[k] = v;
  return out;
}

/** The evidence list of one finding: a row per record and quote, in record order. A failed copy of a citation wins over a passed one, and a checked failure over an unchecked one. */
export function evidenceRows<T extends CitationRef>(citations: readonly T[]): T[] {
  const by = new Map<string, T>();
  for (const c of citations) {
    const key = `${c.record}\0${c.quote ?? ""}`;
    const prev = by.get(key);
    if (!prev || (!c.ok && (prev.ok || (prev.checked && !c.checked)))) by.set(key, c);
  }
  return [...by.values()].sort((a, b) => a.record - b.record || (a.quote ?? "").localeCompare(b.quote ?? ""));
}
