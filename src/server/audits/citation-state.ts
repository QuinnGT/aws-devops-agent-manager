import type { Citation } from "./contract";

/**
 * Citation problems a person still has to look at. A failed citation stays
 * failed in the record (`ok: false` with its `problem`); once a reviewer has
 * read the record and noted what they found (`checked`), it no longer holds
 * up the finding. Pure.
 */

type CitationLike = Pick<Citation, "ok"> & { checked?: Citation["checked"] };

export const isOpenProblem = (c: CitationLike) => !c.ok && !c.checked;

export const hasOpenProblem = (cs: readonly CitationLike[]) => cs.some(isOpenProblem);

/** Failed citations of a finding: still open, and checked by a reviewer. */
export function citationProblemCounts(cs: readonly CitationLike[]): { open: number; checked: number } {
  let open = 0;
  let checked = 0;
  for (const c of cs) {
    if (c.ok) continue;
    if (c.checked) checked++;
    else open++;
  }
  return { open, checked };
}

/**
 * Mark every failed citation of `record` as checked. Returns the new list and
 * how many entries changed; entries that passed or were already checked stay
 * as they are, so the first reviewer's note is kept.
 */
export function markChecked<T extends Citation>(cs: readonly T[], record: number, checked: NonNullable<Citation["checked"]>): { citations: T[]; changed: number } {
  let changed = 0;
  const citations = cs.map((c) => {
    if (c.record !== record || c.ok || c.checked) return c;
    changed++;
    return { ...c, checked };
  });
  return { citations, changed };
}
