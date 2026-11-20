import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig, type PathChange } from "@/server/git/history-repo";
import type { Policy } from "@/server/policy";
import { getHistoryRepoForSpace, toHistoryRepoConfig, type SpaceRow } from "@/server/spaces/queries";
import { AUDIT_FILES, auditDirFor } from "./layout";

/**
 * What "Save the audit record" does and did, in facts a person can check:
 * the history repository, its branch, the folder, each file and whether it is
 * new or replaces one, and whether the commit goes to a remote. Before saving
 * the page reads the repository (a read, allowed in any process); after saving
 * it reads the `audit.finalize` audit event the worker wrote, which keeps the
 * push result, the branch, the remote and the files, so nothing needs a new
 * column. Saving changes nothing in the Agent Space.
 */

export const RECORD_FILE_NAMES = [AUDIT_FILES.auditJson, AUDIT_FILES.findingsJson, AUDIT_FILES.reportMd] as const;
export type RecordFileName = (typeof RECORD_FILE_NAMES)[number];

/** Where the commit goes when it is saved. */
export type PushPlan =
  | { kind: "pushes"; remote: string }
  /** The commit stays in this app's copy of the repository */
  | { kind: "local"; reason: "no-remote" | "push-off"; remote: string | null };

/** The push a save will make, from the repository's settings. Pure. */
export function pushPlanOf(repo: { remoteUrl: string | null; pushEnabled: boolean }): PushPlan {
  if (!repo.remoteUrl) return { kind: "local", reason: "no-remote", remote: null };
  if (!repo.pushEnabled) return { kind: "local", reason: "push-off", remote: repo.remoteUrl };
  return { kind: "pushes", remote: repo.remoteUrl };
}

export interface RecordFile {
  name: RecordFileName;
  /** "new": the file is not in the folder yet. "changed": it replaces one that is */
  status: "new" | "changed";
}

/** Each file's status from the paths already in the repository. Pure. */
export function recordFiles(dir: string, existingPaths: Iterable<string>): RecordFile[] {
  const have = new Set(existingPaths);
  return RECORD_FILE_NAMES.map((name) => ({ name, status: have.has(path.posix.join(dir, name)) ? "changed" : "new" }));
}

/** Each file's status from the changes a commit made to the folder (git's added or modified). Pure. */
export function recordFilesFromCommit(dir: string, changes: readonly PathChange[]): RecordFile[] {
  const by = new Map(changes.map((c) => [c.path, c.status]));
  return RECORD_FILE_NAMES.map((name) => ({ name, status: by.get(path.posix.join(dir, name)) === "modified" ? "changed" : "new" }));
}

/** The folder's files at the repository's HEAD, or none when the copy isn't there yet or can't be read. */
async function pathsInFolder(config: HistoryRepoConfig, dir: string): Promise<string[]> {
  try {
    const repo = await HistoryRepo.open(config);
    return (await repo.listTree("HEAD", dir)).map((e) => e.path);
  } catch {
    // A copy that doesn't exist yet is created by the worker on the first save: every file is new.
    return [];
  }
}

/** What saving would do, from the repository now. */
export interface RecordPlan {
  repository: string;
  branch: string;
  /** With a trailing slash */
  folder: string;
  push: PushPlan;
  files: RecordFile[];
}

/** What a save did, from the worker's audit event. */
export interface SavedRecord {
  commit: string;
  at: Date | null;
  by: string | null;
  branch: string;
  folder: string;
  files: RecordFile[];
  /** null for a record saved before the event kept the result */
  push: { pushed: boolean; error: string | null; remote: string | null } | null;
}

export interface RecordInfo {
  /** Null when the space has no history repository */
  plan: RecordPlan | null;
  /** Null until the record is saved */
  saved: SavedRecord | null;
}

interface FinalizeDetails {
  commit?: unknown;
  dir?: unknown;
  pushed?: unknown;
  pushError?: unknown;
  branch?: unknown;
  remote?: unknown;
  files?: unknown;
}

const asText = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function filesFromDetails(v: unknown): RecordFile[] {
  const given = Array.isArray(v) ? (v as { name?: unknown; status?: unknown }[]) : [];
  return RECORD_FILE_NAMES.map((name) => ({ name, status: given.find((f) => f.name === name)?.status === "changed" ? "changed" : "new" }));
}

/** The worker's record of the save, with the repository's settings as the fallback for what it did not keep. Pure. */
export function savedRecordFrom(
  audit: { finalizedCommit: string | null; finalizedBy: string | null; finalizedAt: Date | null },
  event: { details: unknown } | null,
  fallback: { branch: string; folder: string },
): SavedRecord | null {
  if (!audit.finalizedCommit) return null;
  const d = (event?.details && typeof event.details === "object" ? event.details : {}) as FinalizeDetails;
  const kept = event !== null && typeof d.pushed === "boolean";
  const dir = asText(d.dir) ?? fallback.folder;
  const folder = dir.endsWith("/") ? dir : `${dir}/`;
  return {
    commit: audit.finalizedCommit,
    at: audit.finalizedAt,
    by: audit.finalizedBy,
    branch: asText(d.branch) ?? fallback.branch,
    folder,
    files: filesFromDetails(d.files),
    push: kept ? { pushed: d.pushed === true, error: asText(d.pushError), remote: asText(d.remote) } : null,
  };
}

async function latestSaveEvent(spaceId: string, auditId: string): Promise<{ details: unknown } | null> {
  const [row] = await db()
    .select({ details: auditEvents.details })
    .from(auditEvents)
    .where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, "audit.finalize"), eq(auditEvents.targetId, auditId), eq(auditEvents.result, "ok")))
    .orderBy(desc(auditEvents.at))
    .limit(1);
  return row ?? null;
}

/**
 * The facts of "Save the audit record" for one audit: the plan (repository,
 * branch, folder, files, push) and, once saved, what happened. Reads only.
 */
export async function loadRecordInfo(
  space: SpaceRow,
  audit: { id: string; finalizedCommit: string | null; finalizedBy: string | null; finalizedAt: Date | null },
  layout: Policy["historyLayout"],
): Promise<RecordInfo> {
  const repoRow = await getHistoryRepoForSpace(space);
  if (!repoRow) return { plan: null, saved: null };
  const dir = auditDirFor(layout, space.alias, audit.id);
  const folder = `${dir}/`;
  const saved = audit.finalizedCommit ? savedRecordFrom(audit, await latestSaveEvent(space.id, audit.id), { branch: repoRow.defaultBranch, folder }) : null;
  const existing = saved ? [] : await pathsInFolder(toHistoryRepoConfig(repoRow), dir);
  return {
    plan: { repository: repoRow.name, branch: repoRow.defaultBranch, folder, push: pushPlanOf(repoRow), files: recordFiles(dir, existing) },
    saved,
  };
}
