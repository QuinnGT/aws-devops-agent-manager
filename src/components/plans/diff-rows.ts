import { diffWordsWithSpace } from "diff";
import type { DiffHunk } from "@/server/assets/diff";

/**
 * Rows of a unified diff with old and new line numbers (MASTER "Diffs").
 * Pure; unit-tested.
 */

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "ctx"; old: number | null; new: number | null; text: string }
  | { kind: "meta"; text: string };

export function diffRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const h of hunks) {
    rows.push({ kind: "hunk", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let oldN = h.oldStart;
    let newN = h.newStart;
    for (const l of h.lines) {
      if (l.kind === "meta") rows.push({ kind: "meta", text: l.text });
      else if (l.kind === "add") rows.push({ kind: "add", old: null, new: newN++, text: l.text });
      else if (l.kind === "del") rows.push({ kind: "del", old: oldN++, new: null, text: l.text });
      else rows.push({ kind: "ctx", old: oldN++, new: newN++, text: l.text });
    }
  }
  return rows;
}

/** "+N" and "−M" totals of a set of file diffs. */
export function diffTotals(files: readonly { added: number; removed: number }[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}

/** A piece of a changed line in the Words view: kept, added or removed text. */
export interface WordPart {
  kind: "same" | "add" | "del";
  text: string;
}

/** A Words-view row: a unified row, or a removed line and its replacement as one row with the changed words marked. */
export type WordRow = DiffRow | { kind: "change"; old: number; new: number; parts: WordPart[] };

/** A removed line pairs with one of the next few added lines only when at least half of its words stay. */
const PAIR_WINDOW = 3;
const PAIR_MIN_SHARED = 0.5;
/** Longer pairs stay two rows, so a huge line can't stall the browser. */
const PAIR_MAX_CHARS = 20_000;

function wordParts(a: string, b: string): { parts: WordPart[]; shared: number } | null {
  if (a.length + b.length > PAIR_MAX_CHARS) return null;
  const parts: WordPart[] = diffWordsWithSpace(a, b).map((c) => ({ kind: c.added ? "add" : c.removed ? "del" : "same", text: c.value }));
  // Shared share of the non-space text, so spaces between unrelated words don't make two lines look alike.
  const solid = (s: string) => s.replace(/\s+/g, "").length;
  const total = solid(a) + solid(b);
  const kept = parts.reduce((n, p) => n + (p.kind === "same" ? solid(p.text) : 0), 0);
  return { parts, shared: total ? (2 * kept) / total : 0 };
}

/**
 * The Words view of unified rows: in each run of removed and added lines, a
 * removed line and a similar added line become one "change" row with the
 * changed words marked; the other lines stay as they are, in file order.
 * Pure; unit-tested.
 */
export function wordRows(rows: readonly DiffRow[]): WordRow[] {
  const out: WordRow[] = [];
  let run: Extract<DiffRow, { text: string; old: number | null }>[] = [];
  const flush = () => {
    const dels = run.filter((r) => r.kind === "del");
    const adds = run.filter((r) => r.kind === "add");
    let j = 0;
    for (const d of dels) {
      let match: { k: number; parts: WordPart[] } | null = null;
      for (let k = j; k < Math.min(adds.length, j + PAIR_WINDOW) && !match; k++) {
        const w = wordParts(d.text, adds[k]!.text);
        if (w && w.shared >= PAIR_MIN_SHARED) match = { k, parts: w.parts };
      }
      if (!match) {
        out.push(d);
        continue;
      }
      for (; j < match.k; j++) out.push(adds[j]!);
      out.push({ kind: "change", old: d.old ?? 0, new: adds[match.k]!.new ?? 0, parts: match.parts });
      j = match.k + 1;
    }
    for (; j < adds.length; j++) out.push(adds[j]!);
    run = [];
  };
  for (const r of rows) {
    if (r.kind === "add" || r.kind === "del") {
      run.push(r);
      continue;
    }
    flush();
    out.push(r);
  }
  flush();
  return out;
}
