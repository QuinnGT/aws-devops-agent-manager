import type { NormBundle, NormRecord } from "@/server/analyzers/normalize";

/**
 * The text of one record as the reviewer sees it. The review tools show this
 * text and the citation check searches it, so a quote the model copies from a
 * tool result is found again.
 *
 * Structured messages list their parts in a fixed order: reasoning, text, tool
 * calls (`CALL <name> <input JSON>`, the form the condensed trace uses) and
 * tool results. Other records use the normalized text.
 */
export function recordText(r: NormRecord): string {
  if (!(r.isMessage && r.structured)) return r.text;
  const parts: string[] = [];
  for (const t of r.thinking) if (t.trim()) parts.push(`THINKING\n${t.trim()}`);
  for (const t of r.textBlocks) if (t.trim()) parts.push(t.trim());
  for (const u of r.toolUses) {
    let input = "";
    try {
      input = JSON.stringify(u.input) ?? "";
    } catch {
      input = "";
    }
    parts.push(`CALL ${u.name} ${input}${u.inputComplete ? "" : " (input cut off in the export)"}`.trimEnd());
  }
  for (const t of r.toolResults) parts.push(`RESULT${t.status ? ` (${t.status})` : ""}\n${t.text}`);
  return parts.join("\n\n");
}

/** UTC, "YYYY-MM-DD HH:MM:SS", as in the condensed trace. */
export function utcTime(d: Date): string {
  return Number.isNaN(d.getTime()) ? "unknown time" : d.toISOString().slice(0, 19).replace("T", " ");
}

/** Texts of every record, computed once per bundle. Index i holds record n = i + 1. */
const textCache = new WeakMap<NormBundle, string[]>();

export function recordTexts(bundle: NormBundle): string[] {
  let t = textCache.get(bundle);
  if (!t) {
    t = bundle.records.map(recordText);
    textCache.set(bundle, t);
  }
  return t;
}
