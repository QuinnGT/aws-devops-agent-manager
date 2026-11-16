import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import type { JournalBundle } from "@/lib/journal/types";
import { renderJournalMarkdown } from "./render";
import { renderString } from "./templates/engine";
import type { TemplateSet } from "./templates/load";
import { safeFileName } from "./paths";

/**
 * One zip per export:
 *   manifest.csv                 one row per investigation
 *   raw/<name>.json              the task, executions and records exactly as the API returned them
 *   markdown/<name>-journal.md   rendered with the policy's templates
 * `<name>` is the incident ID, or the task ID when no incident ID is known.
 */

export const EXPORT_FORMAT = "devops-agent-manager/journal-export";
export const EXPORT_VERSION = 1;

export interface RawInvestigationDoc {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  spaceAlias: string;
  agentSpaceId: string | null;
  incidentId: string | null;
  /** The ListBacklogTasks or GetBacklogTask item */
  task: unknown;
  /** Each ListExecutions item with its ListJournalRecords items, ascending */
  executions: { execution: unknown; records: unknown[] }[];
}

export interface ManifestRow {
  taskId: string;
  incidentId: string | null;
  status: string | null;
  createdAt: Date | null;
  executions: number;
  recordCount: number;
}

export const MANIFEST_COLUMNS = ["task_id", "incident_id", "status", "created_at", "executions", "record_count"] as const;

/** RFC 4180 quoting, plus a leading quote on cells a spreadsheet would treat as a formula. */
export function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function manifestCsv(rows: ManifestRow[]): string {
  const lines = [MANIFEST_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.taskId, r.incidentId, r.status, r.createdAt ? r.createdAt.toISOString() : null, r.executions, r.recordCount].map(csvCell).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function rawInvestigationDoc(bundle: JournalBundle, meta: { exportedAt: Date; spaceAlias: string; agentSpaceId: string | null }): RawInvestigationDoc {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: meta.exportedAt.toISOString(),
    spaceAlias: meta.spaceAlias,
    agentSpaceId: meta.agentSpaceId,
    incidentId: bundle.task.incidentId,
    task: bundle.task.raw,
    executions: bundle.executions.map((e) => ({
      execution: e.raw,
      records: bundle.records.filter((r) => r.executionId === e.executionId).map((r) => r.raw),
    })),
  };
}

/** Unique, file-system-safe names: the incident ID, then the task ID when the incident repeats. */
export function investigationNames(bundles: JournalBundle[]): string[] {
  const used = new Set<string>();
  return bundles.map((b) => {
    const base = safeFileName(b.task.incidentId ?? b.task.taskId, "task");
    let name = base;
    if (used.has(name.toLowerCase())) name = `${base}_${safeFileName(b.task.taskId, "task")}`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export interface ExportZipInput {
  bundles: JournalBundle[];
  templates: TemplateSet;
  spaceAlias: string;
  agentSpaceId: string | null;
  exportedAt: Date;
}

export function buildExportZip(input: ExportZipInput): { zip: JSZip; manifest: ManifestRow[]; files: string[] } {
  const zip = new JSZip();
  const date = input.exportedAt;
  const names = investigationNames(input.bundles);
  const manifest: ManifestRow[] = [];
  const files: string[] = [];
  input.bundles.forEach((b, i) => {
    const name = names[i] ?? b.task.taskId;
    const rawPath = `raw/${renderString(input.templates.markdown.rawFileName, { name }, {}, "rawFileName")}`;
    const mdPath = `markdown/${renderString(input.templates.markdown.fileName, { name }, {}, "fileName")}`;
    const doc = rawInvestigationDoc(b, { exportedAt: input.exportedAt, spaceAlias: input.spaceAlias, agentSpaceId: input.agentSpaceId });
    zip.file(rawPath, JSON.stringify(doc, null, 2) + "\n", { date });
    zip.file(mdPath, renderJournalMarkdown(b, input.templates), { date });
    files.push(rawPath, mdPath);
    manifest.push({
      taskId: b.task.taskId,
      incidentId: b.task.incidentId,
      status: b.task.status,
      createdAt: b.task.createdAt,
      executions: b.executions.length,
      recordCount: b.records.length,
    });
  });
  zip.file("manifest.csv", manifestCsv(manifest), { date });
  files.unshift("manifest.csv");
  return { zip, manifest, files };
}

export async function sha256File(absPath: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Stream the zip to disk (via a temporary name), then hash it. */
export async function writeZipFile(zip: JSZip, absPath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const tmp = `${absPath}.partial`;
  try {
    await pipeline(
      zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } }),
      createWriteStream(tmp, { mode: 0o600 }),
    );
    await rename(tmp, absPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  const { size } = await stat(absPath);
  return { sizeBytes: size, sha256: await sha256File(absPath) };
}
