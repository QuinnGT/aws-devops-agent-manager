/**
 * When a sync last recorded every change. `last_sync_completed_at` is when the
 * last run stopped, failed runs included; the time of the last run that
 * finished is kept in `last_result.succeededAt`. A run whose push failed still
 * recorded every change in the local history, so it counts. Pure.
 */

type Row = { status: string; lastSyncCompletedAt: Date | null; lastResult: unknown } | null | undefined;

export function lastGoodSyncAt(row: Row): Date | null {
  if (!row) return null;
  const r = row.lastResult;
  const at = r && typeof r === "object" ? (r as { succeededAt?: unknown }).succeededAt : undefined;
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) return new Date(at);
  // Rows written before succeededAt existed: only a succeeded status says the last run finished.
  return row.status === "succeeded" ? row.lastSyncCompletedAt : null;
}

/** The result to store in last_result, carrying the last good sync time. */
export function withSucceededAt<T extends object>(result: T, at: Date | null): T & { succeededAt?: string } {
  return at ? { ...result, succeededAt: at.toISOString() } : result;
}
