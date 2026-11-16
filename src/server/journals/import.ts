import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { StoredTask } from "@/lib/journal/types";
import type { Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { journalImports } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobContext } from "@/server/jobs/registry";
import type { LoadedPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { EXPORT_FORMAT, EXPORT_VERSION } from "./export-zip";
import { extractIncidentIdLocal, matchIncidentId, type IncidentIdRule } from "./incident-id";
import { parseJournalMarkdown } from "./markdown-import";
import { isRawObject, toStoredExecution, toStoredRecord, toStoredTask } from "./normalize";
import { ensureAreaDir, resolveInArea } from "./paths";
import { policyForSpace } from "./policy";
import { insertImportedJournal } from "./store";
import { openSafeZip, UnsafeZipError } from "./zip-safety";

/**
 * Journal import: the upload (web) and the `journals.import` job (worker).
 *
 * - One markdown file is parsed with parseJournalMarkdown.
 * - A zip produced by this app's export is imported from its raw JSON, which
 *   gives the same rows the export was made from.
 * - Any other zip: files matching the journal patterns are parsed as markdown,
 *   ground-truth files are listed in the report and not imported, the rest is ignored.
 * Imported rows have source "import" and the import's ID.
 */

export class ImportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRequestError";
  }
}

export const importJobInput = z.object({ importId: z.string().uuid() });

export type ImportFormat = "markdown" | "zip" | "export-zip";

export interface ImportFileReport {
  path: string;
  outcome: "imported" | "already-cached" | "ground-truth" | "ignored" | "failed";
  note?: string;
  taskId?: string;
  incidentId?: string | null;
  format?: string;
  executions?: number;
  records?: number;
  warnings?: string[];
  error?: string;
}

export interface ImportReport {
  format: ImportFormat;
  files: ImportFileReport[];
  totals: { imported: number; alreadyCached: number; groundTruth: number; ignored: number; failed: number; records: number };
  duplicateOf?: string;
  error?: string;
}

export type ParseMarkdown = typeof parseJournalMarkdown;

export interface ImportDeps {
  /** Tests replace the markdown parser */
  parseMarkdown?: ParseMarkdown;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${src}$`, "i");
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const matchesAny = (name: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(name));

/** How a file in a non-export zip is handled. */
export function classifyZipFile(filePath: string, pol: LoadedPolicy["policy"]["journals"]["import"]): ImportFileReport["outcome"] | "journal" {
  const name = baseName(filePath);
  if (filePath.startsWith("__MACOSX/") || name.startsWith("._") || name === ".DS_Store") return "ignored";
  if (matchesAny(name, pol.groundTruthFilePatterns)) return "ground-truth";
  if (matchesAny(name, pol.journalFilePatterns)) return "journal";
  return "ignored";
}

export function isExportZip(files: string[]): boolean {
  return files.some((f) => baseName(f) === "manifest.csv") && files.some((f) => /(^|\/)raw\/[^/]+\.json$/.test(f));
}

const rawDocSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  incidentId: z.string().nullable().optional(),
  task: z.record(z.string(), z.unknown()),
  executions: z.array(z.object({ execution: z.record(z.string(), z.unknown()), records: z.array(z.unknown()) })),
});

interface ImportContext {
  spaceId: string;
  importId: string;
  loaded: LoadedPolicy;
  rule: IncidentIdRule | null;
  parse: ParseMarkdown;
}

/** Import one raw JSON document from an app export. */
export async function importExportDoc(text: string, filePath: string, c: ImportContext): Promise<ImportFileReport> {
  const parsed = rawDocSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return { path: filePath, outcome: "ignored", note: "Not a raw journal file from this app's export" };
  const doc = parsed.data;
  const incidentId = doc.incidentId !== undefined ? doc.incidentId : extractIncidentIdLocal(doc.task, c.rule);
  const task = toStoredTask(doc.task, incidentId, "import");
  const executions = doc.executions.map((e) => toStoredExecution(e.execution, task.taskId));
  const records = doc.executions.flatMap((e, i) =>
    e.records.map((r, j) => {
      if (!isRawObject(r)) throw new Error(`record ${j + 1} of execution ${i + 1} is not an object`);
      return toStoredRecord(r, task.taskId, j + 1, executions[i]?.executionId);
    }),
  );
  const inserted = await insertImportedJournal(c.spaceId, { task, executions, records }, { importId: c.importId, importPath: filePath });
  return {
    path: filePath,
    outcome: inserted ? "imported" : "already-cached",
    format: "export-json",
    taskId: task.taskId,
    incidentId: task.incidentId,
    executions: executions.length,
    records: records.length,
    ...(inserted ? {} : { note: "This task is already cached for the space; the cached copy was kept" }),
  };
}

/** Import one markdown journal through parseJournalMarkdown. */
export async function importMarkdownText(text: string, filePath: string, c: ImportContext): Promise<ImportFileReport> {
  const hint = matchIncidentId(filePath, c.loaded.policy.journals.import.incidentIdFromPath);
  const parsed = c.parse(text, c.loaded.policy, { sourceSha256: sha256(text), fileName: filePath, incidentIdHint: hint });
  const task: StoredTask = {
    ...parsed.task,
    incidentId: parsed.task.incidentId ?? hint ?? extractIncidentIdLocal(parsed.task, c.rule),
    source: "import",
    raw: parsed.task.raw,
  };
  const inserted = await insertImportedJournal(c.spaceId, { task, executions: parsed.executions, records: parsed.records }, { importId: c.importId, importPath: filePath });
  return {
    path: filePath,
    outcome: inserted ? "imported" : "already-cached",
    format: parsed.format,
    taskId: task.taskId,
    incidentId: task.incidentId,
    executions: parsed.executions.length,
    records: parsed.records.length,
    ...(parsed.warnings.length ? { warnings: parsed.warnings.slice(0, 50) } : {}),
    ...(inserted ? {} : { note: "This task is already cached for the space; the cached copy was kept" }),
  };
}

function totals(files: ImportFileReport[]): ImportReport["totals"] {
  const count = (o: ImportFileReport["outcome"]) => files.filter((f) => f.outcome === o).length;
  return {
    imported: count("imported"),
    alreadyCached: count("already-cached"),
    groundTruth: count("ground-truth"),
    ignored: count("ignored"),
    failed: count("failed"),
    records: files.filter((f) => f.outcome === "imported").reduce((n, f) => n + (f.records ?? 0), 0),
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function importZip(bytes: Buffer, c: ImportContext, ctx: JobContext): Promise<ImportReport> {
  const limits = c.loaded.policy.journals.import;
  const zip = await openSafeZip(bytes, { maxEntries: limits.maxZipEntries, maxUncompressedBytes: limits.maxUncompressedBytes, maxEntryBytes: limits.maxEntryBytes });
  const exportZip = isExportZip(zip.files);
  const files: ImportFileReport[] = [];
  let i = 0;
  for (const f of zip.files) {
    i++;
    if (await ctx.cancelled()) break;
    try {
      if (exportZip) {
        if (/(^|\/)raw\/[^/]+\.json$/.test(f)) files.push(await importExportDoc(await zip.readText(f), f, c));
        else files.push({ path: f, outcome: "ignored", note: baseName(f) === "manifest.csv" ? "Manifest" : "Rendered copy; the raw JSON was imported instead" });
      } else {
        const kind = classifyZipFile(f, limits);
        if (kind === "journal") files.push(await importMarkdownText(await zip.readText(f), f, c));
        else if (kind === "ground-truth") files.push({ path: f, outcome: "ground-truth", note: "Ground truth for audits; not imported" });
        else files.push({ path: f, outcome: "ignored", note: "Not a journal file name (see journals.yaml import.journalFilePatterns)" });
      }
    } catch (err) {
      if (err instanceof UnsafeZipError) throw err;
      files.push({ path: f, outcome: "failed", error: errorText(err) });
    }
    await ctx.progress(0.1 + 0.85 * (i / zip.files.length), `Read ${i} of ${zip.files.length} file(s)`);
  }
  return { format: exportZip ? "export-zip" : "zip", files, totals: totals(files) };
}

export async function runImport(input: z.output<typeof importJobInput>, ctx: JobContext, deps: ImportDeps = {}): Promise<ImportReport> {
  const [row] = await db().select().from(journalImports).where(eq(journalImports.id, input.importId));
  if (!row) throw new Error(`import ${input.importId} not found`);
  if (["succeeded", "partial", "duplicate"].includes(row.status) && row.parseReport) return row.parseReport as ImportReport;
  const space = await getSpaceById(row.spaceId);
  if (!space) throw new Error(`space ${row.spaceId} not found`);
  const audit = (result: "ok" | "error", details: Record<string, unknown>) =>
    recordAuditEvent({ actor: ctx.actor, action: "journal.import.completed", spaceId: space.id, targetType: "journal_import", targetId: row.id, result, details });
  const finish = async (status: string, report: ImportReport) => {
    await db().update(journalImports).set({ status, parseReport: report, format: report.format, finishedAt: new Date() }).where(eq(journalImports.id, row.id));
  };

  await db().update(journalImports).set({ status: "running" }).where(eq(journalImports.id, row.id));
  const format: ImportFormat = row.format === "markdown" ? "markdown" : "zip";
  try {
    if (!row.storedPath) throw new Error("The upload has no stored file");
    const bytes = await readFile(resolveInArea("imports", row.storedPath));
    const sha = sha256(bytes);
    if (sha !== row.sha256) throw new Error("The stored upload does not match its SHA-256");

    const [dup] = await db()
      .select({ id: journalImports.id })
      .from(journalImports)
      .where(
        and(
          eq(journalImports.spaceId, row.spaceId),
          eq(journalImports.sha256, sha),
          ne(journalImports.id, row.id),
          inArray(journalImports.status, ["succeeded", "partial"]),
        ),
      )
      .limit(1);
    if (dup) {
      const report: ImportReport = { format, files: [], totals: totals([]), duplicateOf: dup.id };
      await finish("duplicate", report);
      await audit("ok", { duplicateOf: dup.id, sha256: sha, fileName: row.fileName });
      await ctx.progress(1, "Already imported; skipped");
      return report;
    }

    const loaded = await policyForSpace(space);
    const c: ImportContext = { spaceId: space.id, importId: row.id, loaded, rule: space.parsedSettings.incidentIdRule, parse: deps.parseMarkdown ?? parseJournalMarkdown };
    await ctx.progress(0.05, "Reading the upload");
    let report: ImportReport;
    if (format === "markdown") {
      let file: ImportFileReport;
      try {
        file = await importMarkdownText(bytes.toString("utf8"), row.fileName, c);
      } catch (err) {
        file = { path: row.fileName, outcome: "failed", error: errorText(err) };
      }
      report = { format, files: [file], totals: totals([file]) };
    } else {
      report = await importZip(bytes, c, ctx);
    }
    const t = report.totals;
    const status = t.failed > 0 ? (t.imported + t.alreadyCached > 0 ? "partial" : "failed") : "succeeded";
    await finish(status, report);
    await audit(status === "failed" ? "error" : "ok", { sha256: sha, fileName: row.fileName, format: report.format, totals: t });
    await ctx.progress(1, `Imported ${t.imported} investigation(s)`);
    return report;
  } catch (err) {
    const report: ImportReport = { format, files: [], totals: totals([]), error: errorText(err) };
    await finish("failed", report);
    await audit("error", { fileName: row.fileName, error: report.error });
    // A rejected zip or a bad upload will not get better on retry.
    if (err instanceof UnsafeZipError) return report;
    throw err;
  }
}

export const importJob = defineJob({
  name: "journals.import",
  input: importJobInput,
  options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 2 * 60 * 60, localConcurrency: 1 },
  handler: (input, ctx) => runImport(input, ctx),
});

/** A display name for the uploaded file: the base name, no control characters, at most 200 characters. */
export function displayFileName(name: string): string {
  return (baseName(name) || "upload")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200);
}

/**
 * Called by the Server Action after the DAL check for `journals.import` on this
 * space: saves the upload under DAM_DATA_DIR/imports and enqueues the job.
 */
export async function saveUpload(space: Space, upload: { fileName: string; bytes: Buffer }, actor: Actor): Promise<{ importId: string; runId: string }> {
  const limits = (await policyForSpace(space)).policy.journals.import;
  const name = displayFileName(upload.fileName);
  const ext = (name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase();
  if (upload.bytes.length === 0) throw new ImportRequestError("The file is empty.");
  if (upload.bytes.length > limits.maxUploadBytes) throw new ImportRequestError(`The file is larger than the ${Math.floor(limits.maxUploadBytes / 1048576)} MB limit.`);
  let format: ImportFormat;
  if (ext === ".md" || ext === ".markdown") format = "markdown";
  else if (ext === ".zip") {
    if (upload.bytes.subarray(0, 2).toString("latin1") !== "PK") throw new ImportRequestError("The file is not a zip archive.");
    format = "zip";
  } else throw new ImportRequestError("Upload a .md journal or a .zip file.");

  const id = randomUUID();
  const storedPath = `${id}${format === "markdown" ? ".md" : ".zip"}`;
  ensureAreaDir("imports");
  await writeFile(resolveInArea("imports", storedPath), upload.bytes, { mode: 0o600, flag: "wx" });
  const sha = sha256(upload.bytes);
  await db()
    .insert(journalImports)
    .values({ id, spaceId: space.id, fileName: name, sha256: sha, format, status: "queued", importedBy: actor.email, storedPath, sizeBytes: upload.bytes.length });
  const runId = await enqueue(importJob, { importId: id }, { actor, spaceId: space.id });
  await db().update(journalImports).set({ jobRunId: runId }).where(eq(journalImports.id, id));
  await recordAuditEvent({
    actor,
    action: "journal.import.requested",
    spaceId: space.id,
    targetType: "journal_import",
    targetId: id,
    details: { fileName: name, sha256: sha, sizeBytes: upload.bytes.length, format, runId },
  });
  return { importId: id, runId };
}
