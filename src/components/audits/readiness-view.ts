import { noCredentialsText } from "@/server/ai/error-kind";
import { NO_REVIEW_MODEL_REASON } from "@/server/ai/models";
import type { BedrockCheck } from "@/server/audits/bedrock-check";
import { plural } from "./words";

/**
 * The Readiness card and the Start button's disabled reason on New audit
 * (pages/audit-new.md, "Readiness card" and "Start the audit card"). Pure;
 * unit-tested. The server applies the same rules again when the audit starts.
 */

export interface BedrockReadiness {
  kind: BedrockCheck["kind"];
  region: string;
  /** For a muted Details line (refused IAM actions, the error name) */
  detail: string | null;
}

export interface ReadinessInput {
  name: string;
  /** Investigations with a cached journal */
  investigations: number;
  /** IDs the user named that have no cached journal */
  missingJournalIds: number;
  /** Per required input: investigations without a document */
  missingByInput: { label: string; items: number }[];
  /** Investigations with every required document (and a journal) */
  ready: number;
  /** Profile cohorts with their investigation counts; empty for a profile without cohorts */
  cohorts: { label: string; items: number }[];
  analyzers: { count: number; words: string };
  /** The review model that would run, or null */
  reviewModelId: string | null;
  /** The space's connection test or sync failed in a way an Admin fixes */
  connectionFailed: boolean;
  /** The model catalogue for the space's inference Region; null when it wasn't checked */
  bedrock?: BedrockReadiness | null;
  /** The reader is an Admin of the space (for the next step in the no-credentials sentence) */
  canManageSpace?: boolean;
}

export interface ReadinessRow {
  tone: "success" | "warning" | "destructive";
  text: string;
  /** Shown in a muted Details disclosure under the row */
  detail?: string | null;
}

/** The "Amazon Bedrock" row, from the model catalogue for the space's inference Region. */
export function bedrockRow(b: BedrockReadiness, canManage: boolean): ReadinessRow {
  const detail = b.detail ? `${b.detail} (Region ${b.region})` : `Region ${b.region}`;
  switch (b.kind) {
    case null:
      return { tone: "success", text: `Amazon Bedrock in ${b.region}` };
    case "no-credentials":
      return { tone: "destructive", text: `Amazon Bedrock: ${noCredentialsText(canManage)}`, detail };
    case "access-denied":
      return { tone: "warning", text: "Amazon Bedrock: Can't list models; a typed ID is used as is", detail };
    case "expired":
      return { tone: "warning", text: "Amazon Bedrock: the space's AWS credentials have expired. Refresh them before you start, or the reviews fail", detail };
    default:
      return { tone: "warning", text: "Amazon Bedrock: can't check it right now. The reviews fail if it can't be reached", detail };
  }
}

export function readinessRows(r: ReadinessInput): ReadinessRow[] {
  const rows: ReadinessRow[] = [];
  rows.push(r.name.trim() ? { tone: "success", text: "Name and profile" } : { tone: "destructive", text: "Enter a name" });
  rows.push(r.investigations ? { tone: "success", text: `${plural(r.investigations, "investigation")} with cached journals` } : { tone: "destructive", text: "Choose at least one investigation" });
  if (r.missingJournalIds) rows.push({ tone: "warning", text: `${plural(r.missingJournalIds, "ID")} ${r.missingJournalIds === 1 ? "has" : "have"} no cached journal and ${r.missingJournalIds === 1 ? "is" : "are"} left out` });
  for (const m of r.missingByInput) {
    if (!m.items || !r.investigations) continue;
    rows.push({ tone: "warning", text: `${plural(m.items, "investigation")} ${m.items === 1 ? "is" : "are"} missing a ${m.label.toLowerCase().replace(/^benchmark /, "")} and ${m.items === 1 ? "is" : "are"} skipped` });
  }
  if (r.cohorts.length) {
    const empty = r.cohorts.filter((c) => c.items === 0);
    for (const c of empty) rows.push({ tone: "destructive", text: `${c.label} has no investigations` });
    if (!empty.length) {
      const same = r.cohorts.every((c) => c.items === r.cohorts[0]!.items);
      rows.push({
        tone: "success",
        text: same ? `${r.cohorts.length} cohorts, ${plural(r.cohorts[0]!.items, "investigation")} each` : `${r.cohorts.length} cohorts: ${r.cohorts.map((c) => `${c.items} ${c.label.toLowerCase()}`).join(", ")}`,
      });
    }
  }
  if (r.bedrock) rows.push(bedrockRow(r.bedrock, !!r.canManageSpace));
  rows.push({ tone: "success", text: `${plural(r.analyzers.count, "analyzer")} run first`, detail: `${r.analyzers.words.charAt(0).toUpperCase()}${r.analyzers.words.slice(1)}` });
  return rows;
}

/** Why Start is disabled, or null when the audit can start (the not-ready ones skipped). */
export function startBlockedReason(r: ReadinessInput): string | null {
  if (!r.name.trim()) return "Enter a name.";
  if (!r.investigations) return "Choose at least one investigation.";
  if (r.ready === 0 && r.missingByInput.some((m) => m.items > 0)) return "Every investigation is missing ground truth. Upload it first.";
  const empty = r.cohorts.find((c) => c.items === 0);
  if (empty) return `${empty.label} has no investigations.`;
  if (!r.reviewModelId) return NO_REVIEW_MODEL_REASON;
  if (r.bedrock?.kind === "no-credentials") return noCredentialsText(!!r.canManageSpace);
  if (r.connectionFailed) return CONNECTION_FAILED_REASON;
  return null;
}

/** The Start reason when the space's last connection check failed; the page adds the next step after it. */
export const CONNECTION_FAILED_REASON = "The space's AWS connection failed its last check.";

/** "Start audit with 20 reviews". */
export const startLabel = (reviews: number) => `Start audit with ${plural(reviews, "review")}`;
