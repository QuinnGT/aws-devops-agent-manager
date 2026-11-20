import { normalizeBundle } from "@/server/analyzers/normalize";
import { loadJournalBundle } from "@/server/analyzers/store";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { openSafeZip, UnsafeZipError, type ZipLimits } from "@/server/journals/zip-safety";
import type { Policy } from "@/server/policy";
import { parseLooseJson } from "@/server/review";
import { checkCitations } from "@/server/review/citations";
import { validateOutput } from "@/server/review/validate";
import type { ReviewRunResult } from "./contract";
import { AuditRequestError } from "./errors";
import { baseName, isSystemFile } from "./evidence-match";
import { assertTakesReviewFiles, folderAliases, handoffManifestSchema, HANDOFF_FILE_NAMES, noFilesReason, type HandoffManifest } from "./handoff";
import { loadedPolicyForSpace, readOutputSchema } from "./profiles";
import { maybeFinishAudit } from "./run";
import { filesEligible } from "./states";
import { getAudit, getAuditItem, listAuditItems, profileOf, type AuditItemRow, type AuditRow } from "./store";
import { storeReview } from "./store-review";

/**
 * Import reviews written from review files (handoff.ts). A person uploads one
 * review.json for an investigation, or a zip with `<folder>/review.json` per
 * investigation. Each review is matched to an item by the folder's
 * manifest.json, else by the folder's name (an incident ID or task ID), checked
 * against the manifest, parsed, validated against the profile's output schema
 * and citation-checked against the item's own journal, then stored like any
 * review (store-review.ts) with runner "handoff" and the reviewer label the
 * person typed. A review that fails a check is refused with the reason and
 * nothing is stored for it. Everything uploaded is untrusted text: it is only
 * parsed, never executed, and no name in a zip is used as a path.
 */

export interface ImportFile {
  fileName: string;
  bytes: Buffer;
}

export interface ImportResult {
  /** The file as sent: the file's name, or a zip entry's path */
  path: string;
  incidentId: string | null;
  itemId: string | null;
  status: "imported" | "refused";
  /** Why a review was refused, in words; null when imported */
  reason: string | null;
  /** A note on an imported review (for example that no manifest was given) */
  note: string | null;
  findings: number;
  /** Decisions carried over from the review this one replaced */
  carried: number;
  /** The item had a review that this one replaced */
  replaced: boolean;
  citations: { checked: number; failed: number } | null;
}

export interface ImportReport {
  results: ImportResult[];
  /** Folders in a zip with no review.json, left alone */
  withoutReview: number;
  totals: { files: number; imported: number; refused: number; replaced: number };
}

/** The reviewer label as stored: one line of text, within the policy's length. Throws AuditRequestError for an empty or too long one. */
export function cleanReviewerLabel(raw: unknown, max: number): string {
  const label = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!label) throw new AuditRequestError("invalid", "Enter who or what wrote the reviews, for example Claude Code, Opus 5.5.", { field: "reviewer" });
  if (label.length > max) throw new AuditRequestError("invalid", `Keep the reviewer to ${max} characters or fewer.`, { field: "reviewer" });
  return label;
}

interface Candidate {
  path: string;
  /** The last segment of the folder holding review.json; "" for a file at the top level or a loose upload */
  folder: string;
  review: string | null;
  manifest: string | null;
  /** The reason the candidate can't be read, set while collecting */
  problem?: string;
}

const isZipFile = (f: ImportFile) => /\.zip$/i.test(f.fileName) || f.bytes.subarray(0, 2).toString("latin1") === "PK";
const lastSegment = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
const mb = (n: number) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${Math.ceil(n / 1024)} KB`);

type ImportLimits = Policy["audits"]["handoff"]["import"];

/**
 * Read the upload into candidates. A zip is read through the safe zip reader
 * (no absolute paths, "..", symlinks or oversized entries), and only
 * review.json and manifest.json entries are ever read. A zip the reader refuses
 * becomes one refused result, not an error for the whole upload.
 */
export async function collectCandidates(
  files: readonly ImportFile[],
  limits: ImportLimits,
): Promise<{ candidates: Candidate[]; refused: { path: string; reason: string }[]; withoutReview: number }> {
  const candidates: Candidate[] = [];
  const refused: { path: string; reason: string }[] = [];
  let withoutReview = 0;
  const zipLimits: ZipLimits = { maxEntries: limits.maxZipEntries, maxUncompressedBytes: limits.maxUncompressedBytes, maxEntryBytes: limits.maxEntryBytes };
  const loose: { name: string; text: string }[] = [];

  for (const f of files) {
    const name = baseName(f.fileName).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300) || "upload";
    if (f.bytes.length > limits.maxUploadBytes) {
      refused.push({ path: name, reason: `The file is larger than ${mb(limits.maxUploadBytes)}.` });
      continue;
    }
    if (isZipFile(f)) {
      let zip;
      try {
        zip = await openSafeZip(f.bytes, zipLimits);
      } catch (err) {
        if (err instanceof UnsafeZipError) {
          refused.push({ path: name, reason: err.message });
          continue;
        }
        throw err;
      }
      const folders = new Map<string, { review?: string; manifest?: string; duplicate?: boolean }>();
      for (const entry of zip.files) {
        if (isSystemFile(entry)) continue;
        const norm = entry.replace(/\\/g, "/");
        const base = (norm.split("/").pop() ?? "").toLowerCase();
        if (base !== HANDOFF_FILE_NAMES.review && base !== HANDOFF_FILE_NAMES.manifest) continue;
        const dir = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
        const slot = folders.get(dir) ?? {};
        const key = base === HANDOFF_FILE_NAMES.review ? "review" : "manifest";
        if (slot[key]) slot.duplicate = true;
        else slot[key] = entry;
        folders.set(dir, slot);
      }
      const read = async (entry: string): Promise<string | { problem: string }> => {
        const size = zip.entries.find((e) => e.name === entry)?.uncompressedSize ?? 0;
        if (size > limits.maxReviewBytes) return { problem: `${entry} is larger than ${mb(limits.maxReviewBytes)}.` };
        try {
          return await zip.readText(entry);
        } catch (err) {
          if (err instanceof UnsafeZipError) return { problem: err.message };
          throw err;
        }
      };
      for (const [dir, slot] of folders) {
        if (!slot.review) {
          withoutReview++;
          continue;
        }
        const path = `${name}: ${slot.review}`;
        const c: Candidate = { path, folder: lastSegment(dir), review: null, manifest: null };
        if (slot.duplicate) c.problem = `The folder ${dir || "at the top of the zip"} has more than one ${HANDOFF_FILE_NAMES.review} or ${HANDOFF_FILE_NAMES.manifest}.`;
        else {
          const r = await read(slot.review);
          if (typeof r === "object") c.problem = r.problem;
          else c.review = r;
          if (slot.manifest && !c.problem) {
            const m = await read(slot.manifest);
            if (typeof m === "object") c.problem = m.problem;
            else c.manifest = m;
          }
        }
        candidates.push(c);
      }
      continue;
    }
    if (!/\.json$/i.test(name)) {
      refused.push({ path: name, reason: "Upload a zip of the review folders or a review.json file." });
      continue;
    }
    if (f.bytes.length > limits.maxReviewBytes) {
      refused.push({ path: name, reason: `The file is larger than ${mb(limits.maxReviewBytes)}.` });
      continue;
    }
    loose.push({ name, text: f.bytes.toString("utf8").replace(/^\uFEFF/, "") });
  }

  // Loose files: one review, and the manifest.json that sits beside it.
  const manifests = loose.filter((l) => l.name.toLowerCase() === HANDOFF_FILE_NAMES.manifest);
  const reviews = loose.filter((l) => l.name.toLowerCase() !== HANDOFF_FILE_NAMES.manifest);
  if (reviews.length > 1) {
    for (const r of reviews) refused.push({ path: r.name, reason: "Upload one review.json at a time, or a zip of the review folders." });
  } else if (reviews.length === 1) {
    if (manifests.length > 1) refused.push({ path: manifests[1]!.name, reason: "Upload one manifest.json, the one beside this review.json." });
    candidates.push({ path: reviews[0]!.name, folder: "", review: reviews[0]!.text, manifest: manifests[0]?.text ?? null });
  } else if (manifests.length) {
    refused.push({ path: manifests[0]!.name, reason: "A manifest.json goes with a review.json. Upload the review too." });
  }
  return { candidates, refused, withoutReview };
}

const DIFFERENT_AUDIT = "These review files were made for a different audit. Download the review files from this audit.";

/** Why a manifest does not fit the item and audit it is imported into, or null when it does. Pure. */
export function manifestProblem(manifest: HandoffManifest, auditId: string, item: Pick<AuditItemRow, "id" | "journalSha256">): string | null {
  if (manifest.auditId !== auditId) return DIFFERENT_AUDIT;
  if (manifest.itemId !== item.id) return "These review files were made for a different investigation.";
  if (manifest.journalSha256 !== item.journalSha256) {
    return "The journal changed after these review files were made, so the review may not match it. Download the review files again, write the review again and import the new one.";
  }
  return null;
}

export type ItemMatch = { ok: true; item: AuditItemRow; manifest: HandoffManifest | null } | { ok: false; reason: string };

const itemName = (i: Pick<AuditItemRow, "incidentId" | "taskId">) => i.incidentId ?? i.taskId;

/**
 * Which item a review belongs to: the one its manifest names, else the one
 * the upload was started for, else the one the folder is named after. A
 * manifest that doesn't parse, or names another audit or investigation, is a
 * reason, never a guess. Pure.
 */
export function matchReview(
  c: Pick<Candidate, "folder" | "manifest">,
  items: readonly AuditItemRow[],
  ctx: { auditId: string; itemId?: string },
): ItemMatch {
  let manifest: HandoffManifest | null = null;
  if (c.manifest !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(c.manifest);
    } catch {
      return { ok: false, reason: "manifest.json is not valid JSON. Leave it as the app wrote it." };
    }
    const parsed = handoffManifestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `manifest.json is not a manifest this app wrote (${parsed.error.issues[0]?.message ?? "invalid"}). Leave it as the app wrote it.` };
    manifest = parsed.data;
    if (manifest.auditId !== ctx.auditId) return { ok: false, reason: DIFFERENT_AUDIT };
  }
  const asked = ctx.itemId ? items.find((i) => i.id === ctx.itemId) : undefined;
  let item: AuditItemRow | undefined;
  if (manifest) {
    item = items.find((i) => i.id === manifest!.itemId);
    if (!item) return { ok: false, reason: "These review files were made for an investigation that is not in this audit." };
    if (ctx.itemId && manifest.itemId !== ctx.itemId) {
      return { ok: false, reason: `These review files are for ${manifest.incidentId ?? manifest.taskId}${asked ? `, not for ${itemName(asked)}` : ""}.` };
    }
  } else if (ctx.itemId) {
    item = asked;
    if (!item) return { ok: false, reason: "The investigation is not in this audit." };
  } else {
    if (!c.folder) return { ok: false, reason: "The review is not in a folder, and no manifest.json came with it. Put each review.json in a folder named for its incident ID, or keep manifest.json beside it." };
    const hits = items.filter((i) => folderAliases(i).includes(c.folder));
    if (hits.length === 0) return { ok: false, reason: `No investigation in this audit matches the folder "${c.folder}". Name the folder for the incident ID or task ID, or keep manifest.json beside review.json.` };
    if (hits.length > 1) return { ok: false, reason: `More than one investigation matches the folder "${c.folder}". Keep manifest.json beside review.json so the app can tell them apart.` };
    item = hits[0]!;
  }
  if (manifest) {
    const problem = manifestProblem(manifest, ctx.auditId, item);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, item, manifest };
}

/** Whether a review's own `incident` field names another incident than the one it was matched to. Reviews without the field pass. Pure. */
export function incidentMismatch(output: unknown, item: Pick<AuditItemRow, "incidentId">): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output) || !item.incidentId) return null;
  const said = (output as { incident?: unknown }).incident;
  if (typeof said !== "string" || !said.trim()) return null;
  return said.trim().toLowerCase() === item.incidentId.toLowerCase() ? null : said.trim();
}

const refusedResult = (path: string, reason: string, over: Partial<ImportResult> = {}): ImportResult => ({
  path,
  incidentId: null,
  itemId: null,
  status: "refused",
  reason,
  note: null,
  findings: 0,
  carried: 0,
  replaced: false,
  citations: null,
  ...over,
});

interface ImportContext {
  actor: Actor;
  spaceId: string;
  audit: AuditRow;
  items: AuditItemRow[];
  schema: Record<string, unknown>;
  reviewer: string;
  itemId?: string;
}

async function importOne(c: Candidate, ctx: ImportContext, taken: Set<string>): Promise<ImportResult> {
  if (c.problem) return refusedResult(c.path, c.problem);
  const match = matchReview(c, ctx.items, { auditId: ctx.audit.id, itemId: ctx.itemId });
  if (!match.ok) return refusedResult(c.path, match.reason);
  const { manifest } = match;
  const who = { incidentId: match.item.incidentId, itemId: match.item.id };
  const refuse = (reason: string) => refusedResult(c.path, reason, who);
  if (taken.has(match.item.id)) return refuse(`Another review in this upload is also for ${itemName(match.item)}. Import one review for each investigation.`);

  // The item as it is now, not as it was when the upload began.
  const item = await getAuditItem(ctx.audit.id, match.item.id);
  if (!item) return refuse("The investigation is not in this audit.");
  if (!filesEligible(item)) return refuse(noFilesReason(item));
  // A manifest from before a later analysis names an older journal; check against the item as it is now.
  const stale = manifest ? manifestProblem(manifest, ctx.audit.id, item) : null;
  if (stale) return refuse(stale);

  if (c.review === null) return refuse("The review could not be read.");
  const output = parseLooseJson(c.review);
  if (output === null || Array.isArray(output)) return refuse("review.json is not a JSON object. The reviewer must answer with one JSON object that matches schema.json.");
  const other = incidentMismatch(output, item);
  if (other) return refuse(`The review says it is for ${other}, but it was matched to ${itemName(item)}. Check that review.json is in the right folder.`);

  const errors = validateOutput(ctx.schema, output);
  if (errors.length) {
    const shown = errors.slice(0, 3).join("; ");
    return refuse(`The review does not match schema.json (${errors.length} ${errors.length === 1 ? "error" : "errors"}): ${shown}${errors.length > 3 ? "; and more" : ""}.`);
  }
  const bundle = await loadJournalBundle(ctx.spaceId, item.taskId);
  if (!bundle) return refuse("The journal is not in the journal cache, so the review's citations can't be checked.");
  const citationCheck = checkCitations(output, normalizeBundle(bundle));

  const result: ReviewRunResult = {
    state: "succeeded",
    runner: "handoff",
    modelId: ctx.reviewer,
    promptDigest: manifest?.promptDigest ?? "",
    output,
    schemaValid: true,
    schemaErrors: [],
    citationCheck,
    steps: 0,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
    error: null,
    modelCalls: [],
  };
  const stored = await storeReview({
    audit: ctx.audit,
    item,
    spaceId: ctx.spaceId,
    actor: ctx.actor,
    result,
    jobRunId: null,
    fromStates: ["pending", "reviewed", "failed"],
  });
  if (stored.status !== "reviewed") return refuse(stored.reason ?? "The investigation changed while the review was stored. Import it again.");
  taken.add(item.id);
  return {
    path: c.path,
    ...who,
    status: "imported",
    reason: null,
    note: manifest ? null : "No manifest.json came with this review, so the journal version was not checked.",
    findings: stored.findings,
    carried: stored.carried,
    replaced: !!item.currentReviewId,
    citations: { checked: citationCheck.checked, failed: citationCheck.failed },
  };
}

/**
 * Import reviews into a hand-off audit. The caller holds `audits.run` for the
 * space. `opts.itemId` limits the import to one investigation (its page), so a
 * review for another is refused. Writes `audit.review-files.import` with the
 * counts, then settles the audit: when every item has finished it moves to
 * "reviewing". Throws AuditRequestError for an upload that can't be tried at
 * all (a wrong audit, state or reviewer label); a review that fails a check is a
 * refused result.
 */
export async function importReviews(actor: Actor, spaceId: string, auditId: string, files: readonly ImportFile[], opts: { reviewer: string; itemId?: string }): Promise<ImportReport> {
  const audit = await getAudit(spaceId, auditId);
  if (!audit) throw new AuditRequestError("not-found", "The audit is not in this space.");
  const loaded = await loadedPolicyForSpace(spaceId);
  assertTakesReviewFiles(audit, loaded.policy);
  const limits = loaded.policy.audits.handoff.import;
  const reviewer = cleanReviewerLabel(opts.reviewer, limits.maxLabelChars);
  if (!files.length) throw new AuditRequestError("invalid", "Choose a review.json or a zip of the review folders.", { field: "files" });
  if (opts.itemId && !(await getAuditItem(audit.id, opts.itemId))) throw new AuditRequestError("not-found", "The investigation is not in this audit.");
  const schema = readOutputSchema(profileOf(audit), loaded.dirs);
  if (!schema) throw new AuditRequestError("invalid", "The audit profile's output schema is not in the policy directory, so reviews can't be checked.");

  const { candidates, refused, withoutReview } = await collectCandidates(files, limits);
  const results: ImportResult[] = refused.map((r) => refusedResult(r.path, r.reason));
  const items = await listAuditItems(audit.id);
  const taken = new Set<string>();
  const ctx: ImportContext = { actor, spaceId, audit, items, schema, reviewer, itemId: opts.itemId };
  for (const c of candidates) results.push(await importOne(c, ctx, taken));

  const imported = results.filter((r) => r.status === "imported");
  const report: ImportReport = {
    results,
    withoutReview,
    totals: { files: results.length, imported: imported.length, refused: results.length - imported.length, replaced: imported.filter((r) => r.replaced).length },
  };
  await recordAuditEvent({
    actor,
    action: "audit.review-files.import",
    spaceId,
    targetType: "audit",
    targetId: audit.id,
    details: {
      scope: opts.itemId ? "investigation" : "audit",
      reviewer,
      uploads: files.map((f) => baseName(f.fileName)).slice(0, 20),
      ...report.totals,
      withoutReview,
      incidents: imported.map((r) => r.incidentId ?? r.itemId).slice(0, 200),
      refusals: results
        .filter((r) => r.status === "refused")
        .slice(0, 50)
        .map((r) => ({ path: r.path, reason: r.reason })),
    },
  });
  if (imported.length) await maybeFinishAudit(audit.id, actor);
  return report;
}
