import { Ban, CircleCheck, CircleMinus, CirclePlus, CircleX, Clock, Copy, Equal, FileText, Loader, TriangleAlert } from "lucide-react";
import type { StatusSpec } from "@/components/common/status-words";

/**
 * Words for journal statuses, job states and import outcomes (MASTER
 * "Statuses": one word set, tone plus icon plus text). Pure.
 */

/** "SYSTEM_LEARNING" and "systemLearning" both read "System learning". */
export function enumLabel(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

/** Investigation (task) and execution status from the API. */
export function taskStatus(status: string | null | undefined): StatusSpec {
  if (!status) return { tone: "neutral", label: "Not set" };
  const label = enumLabel(status);
  switch (status) {
    case "COMPLETED":
      return { tone: "success", icon: CircleCheck, label };
    case "FAILED":
    case "TIMED_OUT":
      return { tone: "destructive", icon: CircleX, label };
    case "IN_PROGRESS":
    case "RUNNING":
      return { tone: "info", icon: Loader, label };
    case "WAITING":
    case "PENDING_START":
    case "PENDING_TRIAGE":
    case "PENDING_CUSTOMER_APPROVAL":
      return { tone: "warning", icon: Clock, label };
    default:
      return { tone: "neutral", label };
  }
}

/** Export and import job states (export_jobs.status, journal_imports.status). */
export function jobStatus(status: string): StatusSpec {
  switch (status) {
    case "queued":
      return { tone: "neutral", icon: Clock, label: "Queued" };
    case "running":
      return { tone: "info", icon: Loader, label: "Running" };
    case "succeeded":
      return { tone: "success", icon: CircleCheck, label: "Succeeded" };
    case "partial":
      return { tone: "warning", icon: TriangleAlert, label: "Partly imported" };
    case "failed":
      return { tone: "destructive", icon: CircleX, label: "Failed" };
    case "duplicate":
      return { tone: "neutral", icon: Copy, label: "Already imported" };
    case "cancelled":
      return { tone: "neutral", icon: Ban, label: "Cancelled" };
    case "expired":
      return { tone: "neutral", label: "Expired" };
    default:
      return { tone: "neutral", label: enumLabel(status) };
  }
}

export const IMPORT_OUTCOMES = {
  imported: { tone: "success", icon: CirclePlus, label: "Imported" },
  "already-cached": { tone: "neutral", icon: Equal, label: "Already cached" },
  "ground-truth": { tone: "info", icon: FileText, label: "Ground truth, not imported" },
  ignored: { tone: "neutral", icon: CircleMinus, label: "Ignored" },
  failed: { tone: "destructive", icon: CircleX, label: "Failed" },
} as const satisfies Record<string, StatusSpec>;

export function importOutcome(outcome: string): StatusSpec {
  return (IMPORT_OUTCOMES as Record<string, StatusSpec>)[outcome] ?? { tone: "neutral", label: enumLabel(outcome) };
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** "1 imported, 10 already cached, 2 ground truth files listed. 62 records added." Zero counts are left out. */
export function importSummary(t: { imported: number; alreadyCached: number; groundTruth: number; ignored: number; failed: number; records: number }): string {
  const parts = [
    t.imported ? `${t.imported} imported` : null,
    t.alreadyCached ? `${t.alreadyCached} already cached` : null,
    t.groundTruth ? `${plural(t.groundTruth, "ground truth file", "ground truth files")} listed` : null,
    t.ignored ? `${t.ignored} ignored` : null,
    t.failed ? `${t.failed} failed` : null,
  ].filter(Boolean);
  const head = parts.length ? parts.join(", ") : "No journal files found";
  return `${head}. ${plural(t.records, "record", "records")} added.`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const SOURCE_LABELS = { api: "Pulled", import: "Imported" } as const;

export type ExportFileState = "download" | "deleted" | "expired" | "none";

/** Whether an export row offers its zip: only a succeeded job whose file is still kept. */
export function exportFileState(
  j: { status: string; fileName: string | null; fileDeletedAt: Date | null; expiresAt: Date | null },
  now: Date = new Date(),
): ExportFileState {
  if (!j.fileName) return "none";
  if (j.fileDeletedAt || j.status === "expired") return "deleted";
  if (j.expiresAt && j.expiresAt <= now) return "expired";
  return j.status === "succeeded" ? "download" : "none";
}
