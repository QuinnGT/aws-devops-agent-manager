import type { FindingRevisionLink } from "@/server/revisions";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { linkApplied } from "./revision-stage";
import type { FindingState } from "./states";

/**
 * What happens to a finding next, as one rule table. Pure; unit-tested.
 *
 * - A finding with no owner (a diagnosis) is recorded and counted in the report.
 * - A fix whose owner `changesPackage` (policy/audits.yaml, `fixOwners`) is a
 *   package fix: it is made in a revision. The page shows the revisions it went
 *   to, or offers to add it to one.
 * - Any other fix is an action for the people its owner names, listed in the
 *   report. Nothing is added to a revision.
 * - A rejected finding is left out of the report and of every revision.
 */

/** The finding field that holds a fix's owner (a `fixOwners` ID). */
export const OWNER_FIELD = "owner";

export type FindingNature =
  /** No owner: a diagnosis or another finding the report records and counts */
  | { kind: "recorded" }
  /** A fix that changes the instruction package: made in a revision */
  | { kind: "package"; ownerId: string; ownerLabel: string }
  /** A fix for people to carry out: listed in the report */
  | { kind: "action"; ownerId: string; ownerLabel: string };

type Profile = Pick<AuditProfile, "fixOwners" | "findings">;

/** "customer_memory" -> "customer memory" for an owner ID the profile doesn't list. */
const idWords = (id: string) => id.replace(/[_-]+/g, " ").trim();

/**
 * What kind of finding this is, from its owner value. An owner the profile
 * marks `changesPackage` is a package fix only when its kind is `linkable`:
 * a revision refuses a finding of a kind that isn't.
 */
export function natureOf(profile: Profile, finding: { kind: string; values: Record<string, unknown> }): FindingNature {
  const raw = finding.values[OWNER_FIELD];
  const ownerId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (!ownerId) return { kind: "recorded" };
  const owner = profile.fixOwners.find((o) => o.id === ownerId);
  const ownerLabel = owner?.label ?? idWords(ownerId);
  const linkable = !!profile.findings.find((x) => x.kind === finding.kind)?.linkable;
  return owner?.changesPackage && linkable ? { kind: "package", ownerId, ownerLabel } : { kind: "action", ownerId, ownerLabel };
}

/** A revision that can still take the finding: not abandoned and not failed. */
export const isActiveLink = (l: Pick<FindingRevisionLink, "revisionState">): boolean => l.revisionState !== "abandoned" && l.revisionState !== "failed";

export interface NextStepInput {
  state: FindingState;
  nature: FindingNature;
  /** The viewer can accept and reject this finding now (findings.review, audit in review, current review) */
  canDecide: boolean;
  /** The viewer holds revisions.build */
  canBuild: boolean;
  /** Where the finding went; null when the revisions couldn't be read */
  links: readonly FindingRevisionLink[] | null;
  /** A rejected finding's note */
  reviewNote: string | null;
}

export interface NextStepAction {
  kind: "add-to-revision";
  label: string;
  /** The finding is still proposed: accept it, then add it */
  acceptFirst: boolean;
}

export interface NextStep {
  /** Which rule applied, for tests and for the panel's tone */
  rule: "recorded" | "action" | "package-open" | "package-sent" | "rejected" | "unknown";
  /** The sentence under "What happens next" */
  text: string;
  /** Revisions the finding is in, with their progress, each a link on the page */
  links: FindingRevisionLink[];
  /** The one button, when the viewer can use it */
  action: NextStepAction | null;
  /** A reason in words when the rule has an action the viewer can't use */
  note: string | null;
  /** A rejected finding's note, to show with it */
  reviewNote: string | null;
}

const NO_BUILD = "Someone who can build revisions adds it to one.";
/** Why a package fix goes to a revision, and that being in one only queues it. */
const packageWhere = (owner: string) =>
  `It is a package fix (${owner}), so it is made in a revision: a copy of the package. Someone edits the files there, saves with this finding linked, and applies the revision's plan to the space.`;
/** Accepting, or being in a revision, doesn't change the agent. */
const QUEUED = "A fix in a revision is only queued: it reaches the agent after someone edits the files in the revision, saves, and applies its plan.";

/** The message and the action for a finding. */
export function nextStepFor(i: NextStepInput): NextStep {
  const base = { links: [] as FindingRevisionLink[], action: null, note: null, reviewNote: null };
  const n = i.nature;

  if (i.state === "rejected") {
    const links = i.links ? [...i.links] : [];
    const went = links.length ? " It was sent to a revision before it was rejected; the revision shows that it is no longer accepted." : "";
    return { ...base, rule: "rejected", links, reviewNote: i.reviewNote, text: `Rejected. It is left out of the report, and no revision takes it.${went}` };
  }

  if (n.kind === "recorded") {
    return {
      ...base,
      rule: "recorded",
      text: i.state === "accepted" ? "Recorded. This finding is counted in the report." : "Accepting records it and counts it in the report. Nothing else changes.",
    };
  }

  if (n.kind === "action") {
    return {
      ...base,
      rule: "action",
      text:
        i.state === "accepted"
          ? `Listed in the report as an action for ${n.ownerLabel}. It doesn't change the package, so there is nothing to add to a revision.`
          : `Accepting lists it in the report as an action for ${n.ownerLabel}. It doesn't change the package.`,
    };
  }

  // A package fix.
  if (i.links === null) {
    return { ...base, rule: "unknown", text: `${packageWhere(n.ownerLabel)} The revisions couldn't be read right now, so this page can't say whether it is in one. Reload in a moment.` };
  }
  const links = [...i.links];
  const active = links.filter(isActiveLink);
  if (i.state === "accepted" && active.length) {
    const applied = active.every(linkApplied);
    const where = active.length === 1 ? "a revision" : `${active.length} revisions`;
    return {
      ...base,
      rule: "package-sent",
      links,
      text: applied ? `Applied. The plan of ${where === "a revision" ? "its revision" : "its revisions"} was applied to the space.` : `Queued in ${where}, not applied yet. ${QUEUED}`,
    };
  }
  const dead = links.length && !active.length ? " Its earlier revision was abandoned or failed." : "";
  if (i.state === "accepted") {
    return {
      ...base,
      links,
      rule: "package-open",
      text: `${packageWhere(n.ownerLabel)} It isn't in one yet. Accepting it didn't change the agent.${dead}`,
      action: i.canBuild ? { kind: "add-to-revision", label: "Add to revision…", acceptFirst: false } : null,
      note: i.canBuild ? null : NO_BUILD,
    };
  }
  // Proposed.
  const can = i.canDecide && i.canBuild;
  return {
    ...base,
    links,
    rule: "package-open",
    text: `Accepting only queues it with the package fixes. It doesn't change the agent. ${packageWhere(n.ownerLabel)}`,
    action: can ? { kind: "add-to-revision", label: "Accept and add to revision…", acceptFirst: true } : null,
    note: !i.canDecide ? null : i.canBuild ? null : "You can accept it here. Someone who can build revisions adds it to one afterwards.",
  };
}

export interface FixProgress {
  /** Accepted package fixes */
  total: number;
  /** Of those, in a revision that can still take them; null when the revisions couldn't be read */
  inRevision: number | null;
  /** Of those, whose revision's plan was applied to the space; null when the revisions couldn't be read */
  applied: number | null;
  /** The accepted package fixes in none, for "Add the accepted package fixes to a revision…" (empty when the revisions couldn't be read) */
  open: string[];
}

/** How far the accepted package fixes of an audit got, from where each went. Pure. */
export function fixProgressOf(
  fixes: readonly { id: string; state: FindingState; nature: FindingNature }[],
  links: ReadonlyMap<string, readonly FindingRevisionLink[]> | null,
): FixProgress {
  const accepted = fixes.filter((f) => f.state === "accepted" && f.nature.kind === "package");
  if (!links) return { total: accepted.length, inRevision: null, applied: null, open: [] };
  const open = accepted.filter((f) => !(links.get(f.id) ?? []).some(isActiveLink)).map((f) => f.id);
  const applied = accepted.filter((f) => (links.get(f.id) ?? []).some((l) => isActiveLink(l) && linkApplied(l))).length;
  return { total: accepted.length, inRevision: accepted.length - open.length, applied, open };
}

