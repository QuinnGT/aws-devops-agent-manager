import type { Space } from "@/server/spaces/queries";
import type { RevisionActor } from "./types";

/**
 * CONTRACT between audits and revisions: accepted package fixes go from an
 * audit into a revision. A revision keeps a "to address" list of findings sent
 * to it; a save that links a finding takes it off the list. The audit page
 * shows, for each finding, the revisions it went to and how far they got.
 *
 * Do not change these exported shapes; add optional fields or new exports only.
 */

/** A revision a finding can be sent to (state open, or creating). */
export interface RevisionOption {
  id: string;
  name: string;
  state: string;
  packageName: string;
  /** Findings on its to-address list */
  toAddress: number;
  /** Distinct findings linked by its saves */
  linked: number;
  updatedAt: Date;
}

/** Where one finding went: a revision that has it to address, or a save that linked it. */
export interface FindingRevisionLink {
  revisionId: string;
  revisionName: string;
  revisionState: string;
  kind: "to-address" | "linked";
  /** The revision's plan, once one was made from it */
  planId: string | null;
  planState: string | null;
  /** The release tagged when that plan was applied */
  releaseName: string | null;
}

/** Revisions of the space that can take findings, newest first. */
export async function listRevisionOptions(_space: Space): Promise<RevisionOption[]> {
  throw new Error("listRevisionOptions is not built yet");
}

/**
 * Put accepted, linkable findings of this space on an open (or creating) revision's
 * to-address list. Findings already on the list or already linked are counted, not added.
 * Refuses (RevisionError) a finding that is not accepted, not linkable or of another space.
 * Permission revisions.build. Records an audit event.
 */
export async function addFindingsToRevision(_space: Space, _input: { revisionId: string; findingIds: string[] }, _actor: RevisionActor): Promise<{ revisionId: string; added: number; alreadyThere: number }> {
  throw new Error("addFindingsToRevision is not built yet");
}

/**
 * Create a revision based on the live space with these findings on its to-address list
 * (the create job runs in the worker, like requestCreateRevision). Same refusals as
 * addFindingsToRevision, plus the revision name rules.
 */
export async function createRevisionForFindings(
  _space: Space,
  _input: { name: string; findingIds: string[]; note?: string },
  _actor: RevisionActor,
): Promise<{ revisionId: string; runId: string; branch: string }> {
  throw new Error("createRevisionForFindings is not built yet");
}

/** For each finding ID, the revisions it went to (empty array when none). */
export async function findingRevisionLinks(_spaceId: string, _findingIds: string[]): Promise<Map<string, FindingRevisionLink[]>> {
  throw new Error("findingRevisionLinks is not built yet");
}
