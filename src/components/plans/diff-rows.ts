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
