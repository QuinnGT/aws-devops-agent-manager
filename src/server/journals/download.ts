import type { Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import type { SpaceRow } from "@/server/spaces/queries";
import { getExportDownload, type ExportDownload } from "./queries";

/**
 * Called by the download Route Handler after the DAL check for
 * `journals.export` on this space. Every attempt is written to the audit log,
 * including ones refused because the file expired or does not exist.
 */
export async function openExportDownload(space: SpaceRow, exportJobId: string, actor: Actor, now = new Date()): Promise<ExportDownload> {
  const d = await getExportDownload(space.id, exportJobId, now);
  await recordAuditEvent({
    actor,
    action: "journal.export.downloaded",
    spaceId: space.id,
    targetType: "export_job",
    targetId: exportJobId,
    result: d.ok ? "ok" : "error",
    details: d.ok ? { fileName: d.fileName, sha256: d.sha256, sizeBytes: d.sizeBytes } : { status: d.status, reason: d.reason },
  });
  return d;
}

/** Content-Disposition for a file name made by safeFileName (ASCII word characters, '.', '@', '+', '-'). */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\w.@+-]/g, "_");
  return `attachment; filename="${ascii}"`;
}
