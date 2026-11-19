import { fillTemplate, safeSegment } from "@/server/history/layout";
import type { Policy } from "@/server/policy";

/** Where an audit's record goes in the history repository, and the files in it. */

export const AUDIT_FILES = { auditJson: "audit.json", findingsJson: "findings.json", reportMd: "report.md" } as const;

export function auditDirFor(layout: Policy["historyLayout"], spaceAlias: string, auditId: string): string {
  return fillTemplate(layout.auditDir, { spaceAlias: safeSegment(spaceAlias), auditId: safeSegment(auditId) });
}
