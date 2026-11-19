import JSZip from "jszip";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { safeFileName } from "@/server/journals/paths";
import { readPolicyFile, type LoadedPolicy, type Policy } from "@/server/policy";
import { fillTemplate, ReviewSetupError } from "@/server/review/prompt";
import { reviewFiles, REVIEW_FILE_NAMES } from "@/server/review/files";
import { reviewSettings } from "@/server/review/settings";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { AuditRequestError } from "./errors";
import { loadedPolicyForSpace } from "./profiles";
import { buildReviewInput } from "./review-input";
import { listReviewers } from "./reviewers";
import { auditStatePhrase, filesEligible } from "./states";
import { getAudit, listAuditItems, profileOf, type AuditItemRow, type AuditRow } from "./store";

/**
 * Review files for a hand-off audit (runner "handoff"): for each investigation
 * a folder with the reviewer's instructions, the brief, every record of the
 * journal, the output schema, a manifest and a README. A person runs them with
 * an agent of their choice, which writes review.json beside them, and imports
 * it (handoff-import.ts).
 *
 * The files hold journal text from the customer's systems, so exporting them is
 * an export of journal content: the caller holds `journals.export` and
 * `audits.read`, and every export is written to the audit log.
 */

export const HANDOFF_FORMAT = "devops-agent-manager/review-files";
export const HANDOFF_VERSION = 1;

export const HANDOFF_FILE_NAMES = { ...REVIEW_FILE_NAMES, manifest: "manifest.json", readme: "README.md", review: "review.json" } as const;

/** manifest.json: which audit, investigation and journal version a folder's files were made from. */
export const handoffManifestSchema = z.object({
  format: z.literal(HANDOFF_FORMAT),
  version: z.literal(HANDOFF_VERSION),
  auditId: z.string().uuid(),
  itemId: z.string().uuid(),
  taskId: z.string().min(1).max(300),
  incidentId: z.string().max(300).nullable(),
  /** The item's journal digest when its analyzers ran (audit_items.journal_sha256) */
  journalSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** SHA-256 over system.md, brief.md and schema.json */
  promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  profileId: z.string().max(100),
  runner: z.string().max(50),
  createdAt: z.string().max(40),
});
export type HandoffManifest = z.output<typeof handoffManifestSchema>;

/** The folder name for an investigation: its incident ID, or its task ID without one. */
export function folderBase(item: Pick<AuditItemRow, "incidentId" | "taskId">): string {
  return safeFileName(item.incidentId ?? item.taskId, "investigation");
}

/** Every name a folder may carry for an item: what folderNames writes, and the plain IDs. */
export function folderAliases(item: Pick<AuditItemRow, "incidentId" | "taskId">): string[] {
  const names = new Set<string>([folderBase(item), safeFileName(item.taskId, "investigation"), `${folderBase(item)}_${safeFileName(item.taskId, "investigation")}`, item.taskId]);
  if (item.incidentId) names.add(item.incidentId);
  return [...names];
}

/** Unique folder names for a set of items: the incident ID, then the task ID too when an incident ID repeats. */
export function folderNames(items: readonly Pick<AuditItemRow, "incidentId" | "taskId">[]): string[] {
  const used = new Set<string>();
  return items.map((i) => {
    let name = folderBase(i);
    if (used.has(name.toLowerCase())) name = `${name}_${safeFileName(i.taskId, "investigation")}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${folderBase(i)}_${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export interface ItemReviewFiles {
  /** File name to text: system.md, brief.md, schema.json, records.md, manifest.json, README.md */
  files: Record<string, string>;
  manifest: HandoffManifest;
  /** Records whose text was cut in records.md */
  recordsCut: number;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** The README for one investigation: the policy's text with the audit's names filled in. */
export function readmeFor(template: string, v: { incidentId: string; taskId: string; auditName: string; profileLabel: string }): string {
  const values: Record<string, string> = { incident_id: oneLine(v.incidentId), task_id: oneLine(v.taskId), audit_name: oneLine(v.auditName), profile_label: oneLine(v.profileLabel) };
  return fillTemplate(template, (k) => (Object.hasOwn(values, k) ? values[k] : undefined));
}

/**
 * The review files of one item, or null when its journal is not in the journal
 * cache. Throws AuditRequestError when the policy's prompts or schema can't be
 * read, which would affect every item.
 */
export async function buildItemFiles(args: {
  audit: AuditRow;
  item: AuditItemRow;
  space: Space;
  loaded: Pick<LoadedPolicy, "dirs">;
  actor: Actor;
  readme: string;
  now: Date;
}): Promise<ItemReviewFiles | null> {
  const { audit, item } = args;
  const profile = profileOf(audit);
  const input = await buildReviewInput({ audit, item, space: args.space, loaded: args.loaded, actor: args.actor });
  if (!input) return null;
  let f;
  try {
    f = reviewFiles(input, reviewSettings(profile));
  } catch (err) {
    if (err instanceof ReviewSetupError) throw new AuditRequestError("invalid", err.message);
    throw err;
  }
  const manifest: HandoffManifest = {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    auditId: audit.id,
    itemId: item.id,
    taskId: item.taskId,
    incidentId: item.incidentId,
    journalSha256: item.journalSha256!,
    promptDigest: f.promptDigest,
    profileId: audit.profileId,
    runner: "handoff",
    createdAt: args.now.toISOString(),
  };
  let readme: string;
  try {
    readme = readmeFor(args.readme, { incidentId: item.incidentId ?? item.taskId, taskId: item.taskId, auditName: audit.name, profileLabel: profile.label });
  } catch (err) {
    if (err instanceof ReviewSetupError) throw new AuditRequestError("invalid", `The hand-off README can't be filled in: ${err.message}`);
    throw err;
  }
  return {
    files: {
      [HANDOFF_FILE_NAMES.readme]: readme,
      [HANDOFF_FILE_NAMES.system]: f.system,
      [HANDOFF_FILE_NAMES.brief]: f.brief,
      [HANDOFF_FILE_NAMES.records]: f.records,
      [HANDOFF_FILE_NAMES.schema]: f.schema,
      [HANDOFF_FILE_NAMES.manifest]: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    manifest,
    recordsCut: f.recordsCut,
  };
}

/** Why an item has no review files, in words. */
export function noFilesReason(item: Pick<AuditItemRow, "state" | "analyzedAt" | "journalSha256">): string {
  if (item.state === "skipped") return "This investigation was skipped, so it has no review files.";
  if (!item.analyzedAt || !item.journalSha256) return "The analyzers have not run on this investigation yet, so it has no review files.";
  return "This investigation is not waiting for a review.";
}

/** A hand-off audit that is running or in review, or the reason it takes no review files. */
export function assertTakesReviewFiles(audit: AuditRow, policy: Pick<Policy, "audits">): void {
  const profile = profileOf(audit);
  if (profile.review.runner !== "handoff") {
    const label = listReviewers(policy).find((e) => e.id === profile.review.runner)?.label ?? profile.review.runner;
    throw new AuditRequestError("state", `This audit's reviews are written by ${label}, not from review files.`);
  }
  if (audit.state !== "running" && audit.state !== "reviewing") {
    throw new AuditRequestError("state", `The audit is ${auditStatePhrase(audit.state)}; review files are for an audit that is running or in review.`);
  }
}

export interface ReviewFilesExport {
  fileName: string;
  zip: JSZip;
  /** The investigations in the zip, with their folders */
  items: { itemId: string; taskId: string; incidentId: string | null; folder: string }[];
  /** Eligible investigations left out because their journal is not cached */
  left: { itemId: string; taskId: string; incidentId: string | null; reason: string }[];
}

/**
 * The review files of an audit (every investigation that takes one) or of one
 * investigation, as a zip with one folder each. Writes `audit.review-files.export`.
 * The caller has checked `journals.export` and `audits.read` for the space.
 */
export async function exportReviewFiles(actor: Actor, spaceId: string, auditId: string, opts: { itemId?: string; now?: Date } = {}): Promise<ReviewFilesExport> {
  const audit = await getAudit(spaceId, auditId);
  if (!audit) throw new AuditRequestError("not-found", "The audit is not in this space.");
  const loaded = await loadedPolicyForSpace(spaceId);
  assertTakesReviewFiles(audit, loaded.policy);
  const space = await getSpaceById(spaceId);
  if (!space) throw new AuditRequestError("not-found", "The space is not registered.");

  const all = await listAuditItems(audit.id);
  let chosen = all.filter(filesEligible);
  if (opts.itemId) {
    const one = all.find((i) => i.id === opts.itemId);
    if (!one) throw new AuditRequestError("not-found", "The investigation is not in this audit.");
    if (!filesEligible(one)) throw new AuditRequestError("state", noFilesReason(one));
    chosen = [one];
  }
  if (!chosen.length) throw new AuditRequestError("state", "No investigation has finished its analyzers yet, so there are no review files.");

  const readmePath = loaded.policy.audits.handoff.readme;
  let readme: string | null = null;
  try {
    readme = readPolicyFile(loaded.dirs, readmePath);
  } catch {
    readme = null;
  }
  if (readme === null) throw new AuditRequestError("invalid", `The hand-off README ${readmePath} is not in the policy directory.`);

  const now = opts.now ?? new Date();
  const zip = new JSZip();
  const names = folderNames(chosen);
  const items: ReviewFilesExport["items"] = [];
  const left: ReviewFilesExport["left"] = [];
  for (const [i, item] of chosen.entries()) {
    const built = await buildItemFiles({ audit, item, space, loaded, actor, readme, now });
    if (!built) {
      left.push({ itemId: item.id, taskId: item.taskId, incidentId: item.incidentId, reason: "The journal is not in the journal cache." });
      continue;
    }
    const folder = names[i]!;
    for (const [name, text] of Object.entries(built.files)) zip.file(`${folder}/${name}`, text, { date: now });
    items.push({ itemId: item.id, taskId: item.taskId, incidentId: item.incidentId, folder });
  }
  if (opts.itemId && !items.length) throw new AuditRequestError("state", left[0]!.reason);
  if (left.length) {
    zip.file("NOT-INCLUDED.txt", `${left.map((l) => `${l.incidentId ?? l.taskId}: ${l.reason}`).join("\n")}\n`, { date: now });
  }

  const single = opts.itemId ? items[0] : null;
  const fileName = `${safeFileName(single ? (single.incidentId ?? single.taskId) : audit.name, "audit")}-review-files.zip`;
  await recordAuditEvent({
    actor,
    action: "audit.review-files.export",
    spaceId,
    targetType: "audit",
    targetId: audit.id,
    details: {
      scope: opts.itemId ? "investigation" : "audit",
      investigations: items.length,
      incidents: items.map((i) => i.incidentId ?? i.taskId).slice(0, 200),
      left: left.map((l) => l.incidentId ?? l.taskId).slice(0, 50),
      fileName,
    },
  });
  return { fileName, zip, items, left };
}
