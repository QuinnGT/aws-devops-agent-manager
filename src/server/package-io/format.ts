/** Pure display helpers shared by the package pages and the Route Handlers. Safe to import in client components. */

/** "32 MB", "141 KB", "512 bytes" (binary units, as the limits are written). */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    const mb = n / (1024 * 1024);
    return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (n >= 1024) {
    const kb = n / 1024;
    return `${kb >= 10 || Number.isInteger(kb) ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  return `${n} ${n === 1 ? "byte" : "bytes"}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What an import maps for one asset type, counted once for the type checkboxes and the plan notes. */
export interface TypePlanCounts {
  /** Creates and updates: what the plan would hold */
  changes: number;
  /** Package assets that already match live */
  unchanged: number;
  /** Package assets the import leaves out anyway (duplicate names, can't be created here) */
  leftOut: number;
}

/** "48 changes, 5 left out", "2 changes, 20 unchanged": the same words on the import page and in the plan notes. */
export function typePlanCountsText(c: TypePlanCounts): string {
  const parts = [`${c.changes} ${c.changes === 1 ? "change" : "changes"}`];
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  if (c.leftOut) parts.push(`${c.leftOut} left out`);
  return parts.join(", ");
}

/**
 * The validation line of an import, one definition everywhere on the page:
 * assets with errors (an asset counts once however many errors it has), then
 * errors and warnings. "14 assets have validation errors (22 errors in all)".
 */
export function validationFailedText(failedAssets: number, errors: number): string {
  const e = `${errors} ${errors === 1 ? "error" : "errors"}`;
  if (failedAssets > 0) return `${failedAssets} ${failedAssets === 1 ? "asset has" : "assets have"} validation errors (${e} in all)`;
  return `The package has ${e}`;
}

/** "12 custom agents with errors (20 errors)": the type checkbox and the type table say the same. */
export function typeErrorsText(o: { failedAssets: number; errors: number; nounOne: string; nounOther: string }): string {
  const e = `${o.errors} ${o.errors === 1 ? "error" : "errors"}`;
  if (o.failedAssets === 0) return e;
  return `${o.failedAssets} ${o.failedAssets === 1 ? o.nounOne : o.nounOther} with errors (${e})`;
}
