import { findingRevisionLinks, listRevisionOptions, type FindingRevisionLink, type RevisionOption } from "@/server/revisions";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { getSpaceById } from "@/server/spaces/queries";
import { currentFindingsOf } from "./loaders";
import { fixProgressOf, natureOf, type FindingNature, type FixProgress } from "./next-step";
import type { FindingState } from "./states";

/**
 * Where an audit's fixes go: for each finding of the current reviews whether it
 * is a package fix, the revisions a package fix went to, the open revisions it
 * can still be added to, and how far the accepted package fixes got. The
 * revision calls are the contract in src/server/revisions/findings.ts. When
 * they fail the audit page still renders and says it can't read the
 * revisions, instead of failing with them. Read-only; callers check
 * `audits.read` first, and `revisions.build` before offering the options.
 */

export interface AuditFix {
  id: string;
  state: FindingState;
  kind: string;
  title: string;
  incidentId: string | null;
  nature: FindingNature;
}

export interface FixContext {
  /** Every finding of the current reviews */
  fixes: AuditFix[];
  natures: Map<string, FindingNature>;
  /** Where each package fix went; null when the revisions couldn't be read */
  links: Map<string, FindingRevisionLink[]> | null;
  /** Revisions that can take findings, newest first; empty without revisions.build or when they couldn't be read */
  options: RevisionOption[];
  progress: FixProgress;
}

function unreadable<T>(what: string, err: unknown, fallback: T): T {
  console.error(`[audits] couldn't read ${what}`, err);
  return fallback;
}

export async function loadFixContext(spaceId: string, auditId: string, profile: Pick<AuditProfile, "fixOwners" | "findings">, opts: { canBuild: boolean }): Promise<FixContext> {
  const rows = await currentFindingsOf(auditId);
  const fixes: AuditFix[] = rows.map((f) => ({ id: f.id, state: f.state, kind: f.kind, title: f.title, incidentId: f.incidentId, nature: natureOf(profile, { kind: f.kind, values: f.current }) }));
  const natures = new Map(fixes.map((f) => [f.id, f.nature]));
  const packageIds = fixes.filter((f) => f.nature.kind === "package").map((f) => f.id);
  let links: Map<string, FindingRevisionLink[]> | null = new Map();
  let options: RevisionOption[] = [];
  if (packageIds.length) {
    links = await findingRevisionLinks(spaceId, packageIds).catch((err: unknown) => unreadable("where the fixes went", err, null));
    if (opts.canBuild) {
      const space = await getSpaceById(spaceId);
      options = space ? await listRevisionOptions(space).catch((err: unknown) => unreadable("the open revisions", err, [])) : [];
    }
  }
  return { fixes, natures, links, options, progress: fixProgressOf(fixes, links) };
}
