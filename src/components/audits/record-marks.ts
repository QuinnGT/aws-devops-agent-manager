/**
 * Marks the quoted spans of a journal record for the record card
 * (pages/audit-item.md, "Journal record"). The record and the quotes are
 * untrusted text: this only splits the string, and the card renders each part
 * as text inside <mark> or a span. Matching ignores case and treats any run
 * of whitespace as one space, so a quote copied across a line break is found.
 * "..." in a quote splits it into parts that are marked separately. Pure.
 */

export interface TextPart {
  text: string;
  mark: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pattern(part: string): RegExp | null {
  const words = part.trim().split(/\s+/).filter(Boolean);
  if (!words.length || part.trim().length < 3) return null;
  return new RegExp(words.map(escapeRe).join("\\s+"), "gi");
}

export function markQuotes(text: string, quotes: readonly (string | null | undefined)[]): TextPart[] {
  const ranges: [number, number][] = [];
  for (const q of quotes) {
    if (!q) continue;
    for (const part of q.split(/\.\.\.|…/)) {
      const re = pattern(part);
      if (!re) continue;
      for (const m of text.matchAll(re)) if (m[0].length) ranges.push([m.index!, m.index! + m[0].length]);
    }
  }
  if (!ranges.length) return text ? [{ text, mark: false }] : [];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: TextPart[] = [];
  let at = 0;
  for (const [s, e] of merged) {
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}

/** Whether any quote was found in the text. */
export const hasMarks = (parts: readonly TextPart[]) => parts.some((p) => p.mark);
