import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { evidenceDocs, journalTasks } from "@/server/db/schema";
import { openSafeZip, UnsafeZipError } from "@/server/journals/zip-safety";
import type { Policy } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { AuditRequestError } from "./errors";
import { baseName, decodeText, dedupeMatches, inputForFileName, isSystemFile, matchEvidenceFile, type EvidenceMatch, type MatchedEvidence } from "./evidence-match";
import { getProfile, loadedPolicyForSpace } from "./profiles";
import { getAudit, listAuditItems, profileOf, readinessOf } from "./store";

/**
 * Ground-truth upload. Files or zips are matched
 * against the profile's inputs and stored per space in evidence_docs; a new
 * upload of the same incident and kind supersedes the old row. Zips go through
 * the journals module's zip safety checks. The caller holds `audits.run`.
 */

export interface UploadFile {
  fileName: string;
  bytes: Buffer;
}

export type EvidenceOutcome = "added" | "replaced" | "unchanged";

export interface EvidenceMatchReport {
  profileId: string;
  matched: {
    path: string;
    fileName: string;
    incidentId: string;
    kind: string;
    label: string;
    fields: Record<string, string | null>;
    outcome: EvidenceOutcome;
    /** Some investigation in the journal cache has this incident ID */
    knownIncident: boolean;
  }[];
  unmatched: { path: string; fileName: string; reason: string; code: string | null }[];
  /** With an audit: its incidents that still miss a required document */
  missing: { incidentId: string | null; taskIds: string[]; kinds: { kind: string; label: string }[] }[];
  totals: { files: number; added: number; replaced: number; unchanged: number; unmatched: number };
}

const isZip = (f: UploadFile) => /\.zip$/i.test(f.fileName);

/** Every file of the upload, matched. Zip entries whose names match no input are listed without being read. */
export async function matchUpload(files: UploadFile[], profile: AuditProfile, policy: Pick<Policy, "audits" | "journals">): Promise<EvidenceMatch[]> {
  const cap = policy.audits.maxEvidenceUploadBytes;
  const total = files.reduce((n, f) => n + f.bytes.length, 0);
  if (!files.length) throw new AuditRequestError("invalid", "Choose at least one file.");
  if (total > cap) throw new AuditRequestError("invalid", `The upload is larger than the ${Math.floor(cap / 1048576)} MB limit.`);
  const out: EvidenceMatch[] = [];
  for (const f of files) {
    const name = baseName(f.fileName).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300) || "upload";
    if (!isZip(f)) {
      out.push(matchEvidenceFile(profile, name, decodeText(f.bytes)));
      continue;
    }
    if (f.bytes.subarray(0, 2).toString("latin1") !== "PK") {
      out.push({ matched: false, path: name, fileName: name, reason: "The file is not a zip archive.", code: "evidence.not-text" });
      continue;
    }
    let zip;
    try {
      const lim = policy.journals.import;
      zip = await openSafeZip(f.bytes, { maxEntries: lim.maxZipEntries, maxUncompressedBytes: cap, maxEntryBytes: Math.min(lim.maxEntryBytes, cap) });
    } catch (err) {
      if (err instanceof UnsafeZipError) throw new AuditRequestError("invalid", `${name}: ${err.message}`);
      throw err;
    }
    for (const entry of zip.files) {
      const entryName = baseName(entry);
      if (isSystemFile(entry) || !inputForFileName(profile, entryName)) {
        out.push(matchEvidenceFile(profile, entry, null));
        continue;
      }
      let text: string | null;
      try {
        const t = await zip.readText(entry);
        text = t.includes("\u0000") ? null : t.replace(/^\uFEFF/, "");
      } catch (err) {
        if (err instanceof UnsafeZipError) throw new AuditRequestError("invalid", `${name}: ${err.message}`);
        throw err;
      }
      out.push(matchEvidenceFile(profile, entry, text));
    }
  }
  return dedupeMatches(out);
}

/** Store matched documents. A document identical to the current one (same SHA-256) is left as is. */
export async function storeEvidence(spaceId: string, matches: MatchedEvidence[], actor: Actor): Promise<EvidenceOutcome[]> {
  return db().transaction(async (tx) => {
    const outcomes: EvidenceOutcome[] = [];
    for (const m of matches) {
      const [cur] = await tx
        .select({ id: evidenceDocs.id, sha256: evidenceDocs.sha256 })
        .from(evidenceDocs)
        .where(and(eq(evidenceDocs.spaceId, spaceId), eq(evidenceDocs.incidentId, m.incidentId), eq(evidenceDocs.kind, m.kind), isNull(evidenceDocs.supersededAt)))
        .for("update");
      if (cur?.sha256 === m.sha256) {
        outcomes.push("unchanged");
        continue;
      }
      if (cur) await tx.update(evidenceDocs).set({ supersededAt: new Date() }).where(eq(evidenceDocs.id, cur.id));
      await tx.insert(evidenceDocs).values({
        spaceId,
        incidentId: m.incidentId,
        kind: m.kind,
        fileName: m.fileName,
        sha256: m.sha256,
        sizeBytes: m.sizeBytes,
        body: m.body,
        fields: m.fields,
        uploadedBy: actor.email,
      });
      outcomes.push(cur ? "replaced" : "added");
    }
    return outcomes;
  });
}

/**
 * Upload ground truth for a space. With `auditId` the audit's profile is used
 * and the report lists the audit's incidents that still miss a document;
 * otherwise `profileId` (or the default profile) from the space's policy.
 */
export async function uploadGroundTruth(
  actor: Actor,
  spaceId: string,
  files: UploadFile[],
  opts: { auditId?: string; profileId?: string } = {},
): Promise<EvidenceMatchReport> {
  const loaded = await loadedPolicyForSpace(spaceId);
  let profile: AuditProfile;
  let profileId: string;
  const audit = opts.auditId ? await getAudit(spaceId, opts.auditId) : null;
  if (opts.auditId && !audit) throw new AuditRequestError("not-found", "The audit is not in this space.");
  if (audit) {
    profile = profileOf(audit);
    profileId = audit.profileId;
  } else {
    ({ id: profileId, profile } = getProfile(loaded.policy, opts.profileId));
  }
  if (!profile.inputs.length) throw new AuditRequestError("invalid", `The ${profile.label} profile takes no ground-truth documents.`);

  const matches = await matchUpload(files, profile, loaded.policy);
  const matched = matches.filter((m): m is MatchedEvidence => m.matched);
  const outcomes = await storeEvidence(spaceId, matched, actor);
  const incidents = [...new Set(matched.map((m) => m.incidentId))];
  const known = incidents.length
    ? new Set(
        (
          await db()
            .selectDistinct({ incidentId: journalTasks.incidentId })
            .from(journalTasks)
            .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.incidentId, incidents)))
        ).map((r) => r.incidentId),
      )
    : new Set<string | null>();

  let missing: EvidenceMatchReport["missing"] = [];
  if (audit) {
    const items = (await listAuditItems(audit.id)).filter((i) => i.state !== "skipped");
    const readiness = await readinessOf(spaceId, items, profile);
    const byIncident = new Map<string, EvidenceMatchReport["missing"][number]>();
    for (const r of readiness) {
      if (!r.missing.length) continue;
      const key = r.incidentId ?? `\0${r.taskId}`;
      const entry = byIncident.get(key) ?? { incidentId: r.incidentId, taskIds: [], kinds: r.missing };
      entry.taskIds.push(r.taskId);
      byIncident.set(key, entry);
    }
    missing = [...byIncident.values()];
  }

  const report: EvidenceMatchReport = {
    profileId,
    matched: matched.map((m, i) => ({
      path: m.path,
      fileName: m.fileName,
      incidentId: m.incidentId,
      kind: m.kind,
      label: m.label,
      fields: m.fields,
      outcome: outcomes[i]!,
      knownIncident: known.has(m.incidentId),
    })),
    unmatched: matches.flatMap((m) => (m.matched ? [] : [{ path: m.path, fileName: m.fileName, reason: m.reason, code: m.code ?? null }])),
    missing,
    totals: {
      files: matches.length,
      added: outcomes.filter((o) => o === "added").length,
      replaced: outcomes.filter((o) => o === "replaced").length,
      unchanged: outcomes.filter((o) => o === "unchanged").length,
      unmatched: matches.filter((m) => !m.matched).length,
    },
  };
  await recordAuditEvent({
    actor,
    action: "audit.evidence.upload",
    spaceId,
    targetType: audit ? "audit" : "space",
    targetId: audit?.id ?? spaceId,
    details: {
      profileId,
      uploads: files.map((f) => baseName(f.fileName)).slice(0, 50),
      totals: report.totals,
      incidents: incidents.slice(0, 200),
      // Which documents this upload named, so a draft can tell "the same file again" from "already in the space".
      documents: report.matched.slice(0, 200).map((m) => ({ incidentId: m.incidentId, kind: m.kind, outcome: m.outcome })),
    },
  });
  return report;
}
