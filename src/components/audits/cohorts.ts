/**
 * Cohort assignment on New audit (pages/audit-new.md, "Cohorts card"): each
 * investigation goes to the cohort for when it started, split at a release's
 * time or a time the user enters, and a person can move one by hand. The
 * result becomes one task selection per cohort for createAudit. Pure.
 */

export interface CohortItem {
  taskId: string;
  createdAt: string | null;
}

export interface CohortAssignment {
  taskId: string;
  cohort: string;
  /** Moved by hand from the cohort the split time gives */
  moved: boolean;
}

/**
 * Two or more cohorts in profile order: the first holds investigations that
 * started before `splitAt`, the last those at or after it. An item without a
 * start time goes to the first cohort. Overrides win.
 */
export function assignByTime(items: readonly CohortItem[], cohorts: readonly string[], splitAt: Date | null, overrides: Readonly<Record<string, string>> = {}): CohortAssignment[] {
  const before = cohorts[0];
  const after = cohorts.at(-1);
  if (!before || !after) return [];
  return items.map((i) => {
    const t = i.createdAt ? Date.parse(i.createdAt) : Number.NaN;
    const byTime = splitAt && Number.isFinite(t) && t >= splitAt.getTime() ? after : before;
    const o = overrides[i.taskId];
    const cohort = o && cohorts.includes(o) ? o : byTime;
    return { taskId: i.taskId, cohort, moved: cohort !== byTime };
  });
}

/** One `tasks` selection per cohort that has investigations, in profile order. */
export function cohortSelections(assignments: readonly CohortAssignment[], cohorts: readonly string[]): { by: "tasks"; taskIds: string[]; cohort: string }[] {
  return cohorts
    .map((c) => ({ by: "tasks" as const, cohort: c, taskIds: assignments.filter((a) => a.cohort === c).map((a) => a.taskId) }))
    .filter((s) => s.taskIds.length > 0);
}

/** Count and start-time range per cohort, for the counts row. */
export function cohortCounts(items: readonly CohortItem[], assignments: readonly CohortAssignment[], cohorts: readonly string[]): { cohort: string; n: number; from: string | null; to: string | null }[] {
  const at = new Map(items.map((i) => [i.taskId, i.createdAt]));
  return cohorts.map((c) => {
    const times = assignments
      .filter((a) => a.cohort === c)
      .map((a) => at.get(a.taskId))
      .filter((t): t is string => !!t)
      .sort();
    return { cohort: c, n: assignments.filter((a) => a.cohort === c).length, from: times[0] ?? null, to: times.at(-1) ?? null };
  });
}
