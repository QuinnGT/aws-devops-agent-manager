/**
 * Selection on the drafts page (pages/drafts.md): which rows can be picked,
 * the header checkbox state, and why "Create plan" is disabled. Pure;
 * unit-tested.
 */

export interface SelectableDraft {
  id: string;
  name: string;
  mine: boolean;
  plan: { id: string } | null;
  assetDeleted: boolean;
  validation: { errors: number };
}

/** Your own drafts that aren't in a plan. A deleted asset's draft shows a disabled checkbox instead. */
export function canSelect(row: SelectableDraft): boolean {
  return row.mine && !row.plan && !row.assetDeleted;
}

/** Rows that get a checkbox (enabled or disabled). */
export function hasCheckbox(row: SelectableDraft): boolean {
  return row.mine && !row.plan;
}

export function headerState(selected: ReadonlySet<string>, rows: readonly SelectableDraft[]): boolean | "indeterminate" {
  const ids = rows.filter(canSelect).map((r) => r.id);
  const n = ids.filter((id) => selected.has(id)).length;
  if (n === 0) return false;
  return n === ids.length ? true : "indeterminate";
}

/** The header checkbox: select every selectable row, or clear when all are already selected. */
export function toggleAll(selected: ReadonlySet<string>, rows: readonly SelectableDraft[]): Set<string> {
  const ids = rows.filter(canSelect).map((r) => r.id);
  return headerState(selected, rows) === true ? new Set() : new Set(ids);
}

export function toggleOne(selected: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** Selected IDs that are still selectable after the rows changed (a refresh, a filter). */
export function pruneSelection(selected: ReadonlySet<string>, rows: readonly SelectableDraft[]): Set<string> {
  const ok = new Set(rows.filter(canSelect).map((r) => r.id));
  return new Set([...selected].filter((id) => ok.has(id)));
}

/** Why "Create plan" is disabled (first match), or null. */
export function createBlocker(selectedRows: readonly SelectableDraft[], title: string): string | null {
  const bad = selectedRows.find((r) => r.validation.errors > 0);
  if (bad) return `Fix the errors in ${bad.name} first.`;
  if (!title.trim()) return "Enter a plan title.";
  return null;
}
