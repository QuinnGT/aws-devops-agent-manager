/**
 * The to-address list of a revision (revisions.to_address_finding_ids): the
 * findings sent to it from an audit that no save has linked yet. Pure helpers;
 * the writes that use them hold the revision row's lock (findings.ts, save.ts).
 */

/** What adding findings does to a list: the new list, the IDs that were new, and how many were already there or already linked. */
export interface MergedList {
  next: string[];
  added: string[];
  alreadyThere: number;
}

/**
 * Add `incoming` (in the given order) after the findings already on the list.
 * A finding on the list, or already linked by a save of the revision, is
 * counted in `alreadyThere` and not added. Repeated IDs count once.
 */
export function mergeToAddress(list: readonly string[], linked: ReadonlySet<string>, incoming: readonly string[]): MergedList {
  const there = new Set(list);
  const added: string[] = [];
  let alreadyThere = 0;
  for (const id of new Set(incoming)) {
    if (there.has(id) || linked.has(id)) alreadyThere += 1;
    else added.push(id);
  }
  return { next: [...list, ...added], added, alreadyThere };
}

/** The list without these findings (a save linked them, or a person removed them). */
export function takeOffList(list: readonly string[], ids: readonly string[]): string[] {
  const off = new Set(ids);
  return list.filter((id) => !off.has(id));
}

/** How many findings on the list are accepted now. A finding reopened or rejected on its audit stays on the list but isn't counted. */
export function acceptedOnList(list: readonly string[], states: ReadonlyMap<string, string>): number {
  return list.filter((id) => states.get(id) === "accepted").length;
}
