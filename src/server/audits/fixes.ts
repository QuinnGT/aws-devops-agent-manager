import { findingRevisionLinks, listRevisionOptions, loadRevisionList, revisionAuditSources, type FindingRevisionLink, type RevisionAuditSource, type RevisionOption } from "@/server/revisions";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { getSpaceById } from "@/server/spaces/queries";
import { currentFindingsOf } from "./loaders";
import { fixProgressOf, isActiveLink, natureOf, type FindingNature, type FixProgress } from "./next-step";
import { revisionStage, type RevisionStage } from "./revision-stage";
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

/** A revision the audit's package fixes went to, or that could take them, in the words a person needs to tell revisions apart. */
export interface RevisionInfo {
  id: string;
  name: string;
  state: string;
  stage: { stage: RevisionStage; words: string };
  /** Saves so far */
  saves: number;
  /** What it started from: "Live space" or a release */
  base: string;
  createdBy: string;
  createdAt: Date;
  /** Findings on its to-address list that are accepted now, and findings its saves linked */
  toAddress: number;
  linked: number;
  /** The audits its findings come from */
  audits: RevisionAuditSource[];
  /** Accepted package fixes of this audit that are in it */
  fromThisAudit: number;
}

export interface FixContext {
  /** Every finding of the current reviews */
  fixes: AuditFix[];
  natures: Map<string, FindingNature>;
  /** Where each package fix went; null when the revisions couldn't be read */
  links: Map<string, FindingRevisionLink[]> | null;
  /** Revisions that can take findings, newest first; empty without revisions.build or when they couldn't be read */
  options: RevisionOption[];
  /** The revisions in `links` and `options`, by ID */
  revisions: Map<string, RevisionInfo>;
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
  const revisions = new Map<string, RevisionInfo>();
  if (packageIds.length) {
    links = await findingRevisionLinks(spaceId, packageIds).catch((err: unknown) => unreadable("where the fixes went", err, null));
    if (opts.canBuild) {
      const space = await getSpaceById(spaceId);
      options = space ? await listRevisionOptions(space).catch((err: unknown) => unreadable("the open revisions", err, [])) : [];
    }
    const wanted = new Set([...options.map((o) => o.id), ...[...(links?.values() ?? [])].flat().filter(isActiveLink).map((l) => l.revisionId)]);
    if (wanted.size) await describeRevisions(spaceId, wanted, links, fixes, revisions);
  }
  return { fixes, natures, links, options, revisions, progress: fixProgressOf(fixes, links) };
}

/** Fill `out` with what a person needs to tell the revisions apart. A failure leaves it empty: the page then shows names and counts only. */
async function describeRevisions(spaceId: string, wanted: ReadonlySet<string>, links: Map<string, FindingRevisionLink[]> | null, fixes: readonly AuditFix[], out: Map<string, RevisionInfo>): Promise<void> {
  try {
    const space = await getSpaceById(spaceId);
    if (!space) return;
    const list = await loadRevisionList(space, { limit: 500 });
    const sources = await revisionAuditSources(spaceId, [...wanted]);
    const accepted = new Set(fixes.filter((f) => f.state === "accepted" && f.nature.kind === "package").map((f) => f.id));
    for (const r of list.revisions) {
      if (!wanted.has(r.id)) continue;
      const here = [...(links?.entries() ?? [])].filter(([id, ls]) => accepted.has(id) && ls.some((l) => l.revisionId === r.id && isActiveLink(l))).length;
      out.set(r.id, {
        id: r.id,
        name: r.name,
        state: r.state,
        stage: revisionStage({ state: r.state, changes: r.changes, plan: r.plan }),
        saves: r.changes,
        base: r.base.label,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        toAddress: r.toAddress,
        linked: r.linkedFindings,
        audits: sources.get(r.id) ?? [],
        fromThisAudit: here,
      });
    }
  } catch (err) {
    unreadable("what the revisions are", err, undefined);
  }
}
