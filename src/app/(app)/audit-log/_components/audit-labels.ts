import { Ban, CircleCheck, CircleX, Clock } from "lucide-react";
import type { StatusSpec } from "@/components/common/status-words";
import type { AuditResult } from "@/server/spaces/audit-filter";

/**
 * Words for the audit log table. Pure, so the table and the filter menus
 * read the same and the tests can check them.
 */

export const RESULT_WORDS: Record<AuditResult, StatusSpec> = {
  ok: { tone: "success", icon: CircleCheck, label: "Succeeded" },
  error: { tone: "destructive", icon: CircleX, label: "Failed" },
  denied: { tone: "warning", icon: Ban, label: "Denied" },
};

/** Readable names for audit action codes; the code stays in mono meta text. */
const ACTION_WORDS: Record<string, string> = {
  "auth.sign-in": "Signed in",
  "auditlog.export": "Audit log exported",
  "space.register": "Space registered",
  "space.update": "Connection changed",
  "space.settings-update": "Settings changed",
  "space.connection-test-request": "Connection test requested",
  "space.connection-test": "Connection tested",
  "history-repo.create": "History repository added",
  "history-repo.update": "History repository changed",
  "binding.create": "Role binding added",
  "binding.update": "Role binding changed",
  "binding.delete": "Role binding removed",
  "sync.request": "Sync requested",
  "asset.reason.add": "Change reason added",
  "draft.create": "Draft started",
  "draft.update": "Draft changed",
  "draft.save": "Draft saved",
  "draft.rebase": "Draft moved to the live version",
  "draft.discard": "Draft discarded",
  "plan.create": "Plan created",
  "plan.check": "Plan checked",
  "plan.recheck": "Plan re-check requested",
  "plan.approval.request": "Approval requested",
  "plan.approve": "Plan approved",
  "plan.reject": "Plan rejected",
  "plan.apply": "Apply requested",
  "plan.apply.start": "Apply started",
  "plan.apply.finish": "Plan applied",
  "plan.apply.fail": "Apply failed",
  "plan.discard": "Plan discarded",
  "rollback.plan": "Restore plan created",
  "release.create": "Release created",
  "package.import": "Package uploaded",
  "package.plan": "Import plan created",
  "package.export": "Package exported",
  "package.import.expired": "Package upload deleted after it expired",
  "journal.export": "Journals exported",
  "journal.export.requested": "Journal export requested",
  "journal.export.completed": "Journal export finished",
  "journal.export.downloaded": "Journal export downloaded",
  "journal.export.expired": "Journal export deleted after it expired",
  "journal.import.requested": "Journal import requested",
  "journal.import.completed": "Journal import finished",
  "analyzers.run": "Analysis run",
};

/** "space.settings-update" reads "Settings changed"; unknown codes are made readable ("plan.foo-bar" reads "Plan foo bar"). */
export function actionLabel(action: string): string {
  const known = ACTION_WORDS[action];
  if (known) return known;
  const words = action.replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

/**
 * The result badge of one event. A request that was accepted reads
 * "Requested", not "Succeeded": recording "sync.request" means the sync was
 * queued, not that it ran.
 */
export function resultWord(action: string, result: AuditResult): StatusSpec {
  if (result === "ok" && (/(^|[.-])request(ed)?$/.test(action) || action === "plan.recheck")) return { tone: "info", icon: Clock, label: "Requested" };
  return RESULT_WORDS[result];
}

const TARGET_KINDS: Record<string, string> = {
  agent_space: "Space",
  space: "Space",
  history_repo: "History repository",
  role_binding: "Role binding",
  asset: "Asset",
  draft: "Draft",
  plan: "Plan",
  release: "Release",
  export_job: "Journal export",
  journal_import: "Journal import",
  package_export: "Package export",
  package_import: "Package import",
  job_run: "Job",
};

/** "history_repo" becomes "History repository"; unknown types are made readable. */
export function targetKind(type: string): string {
  const known = TARGET_KINDS[type];
  if (known) return known;
  const words = type.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

export interface AuditTargetView {
  kind: string;
  /** A readable name from the event, or null to show the short ID */
  name: string | null;
  /** First 8 characters of the target ID, for rows without a name */
  shortId: string | null;
  href: string | null;
}

interface TargetInput {
  targetType: string | null;
  targetId: string | null;
  spaceAlias: string | null;
  details: unknown;
  /** The plan's current title, when the target is a plan */
  planTitle?: string | null;
}

function detailString(details: unknown, key: string): string | null {
  if (!details || typeof details !== "object") return null;
  const v = (details as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the event acted on, with a link to its page when the app has one. */
export function auditTarget(e: TargetInput): AuditTargetView | null {
  if (!e.targetType) return null;
  const isSpace = e.targetType === "agent_space" || e.targetType === "space";
  const name = isSpace
    ? (e.spaceAlias ?? detailString(e.details, "alias"))
    : (detailString(e.details, "name") ?? detailString(e.details, "title") ?? detailString(e.details, "subject") ?? (e.planTitle || null));
  const base = e.spaceAlias ? `/spaces/${encodeURIComponent(e.spaceAlias)}` : null;
  const id = e.targetId;
  let href: string | null = null;
  if (base && isSpace) href = base;
  else if (base && id && UUID_RE.test(id) && e.targetType === "plan") href = `${base}/plans/${id}`;
  else if (base && id && e.targetType === "asset") href = `${base}/assets/${encodeURIComponent(id)}`;
  else if (base && e.targetType === "release" && name) href = `${base}/releases/${encodeURIComponent(name)}`;
  return { kind: targetKind(e.targetType), name, shortId: id ? id.slice(0, 8) : null, href };
}

/** Details as indented JSON for the expandable cell, or null when there are none. */
export function detailsText(details: unknown): string | null {
  if (details === null || details === undefined) return null;
  if (typeof details === "object" && Object.keys(details as object).length === 0) return null;
  return JSON.stringify(details, null, 2);
}
