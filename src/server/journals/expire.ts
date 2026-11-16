import { unlink } from "node:fs/promises";
import { and, eq, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { exportFiles, exportJobs } from "@/server/db/schema";
import { defineJob, type JobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { resolveInArea } from "./paths";

/** Daily job: delete export zip files past their expiry (journals.exportRetentionDays). */

export const expireJobInput = z.object({}).default({});

export async function runExpireExports(_input: unknown, ctx: JobContext, now: Date = new Date()): Promise<{ deleted: number; missing: number }> {
  const due = await db()
    .select({ fileId: exportFiles.id, path: exportFiles.path, exportJobId: exportJobs.id, spaceId: exportJobs.spaceId, fileName: exportFiles.fileName })
    .from(exportFiles)
    .innerJoin(exportJobs, eq(exportFiles.exportJobId, exportJobs.id))
    .where(and(isNull(exportFiles.deletedAt), lte(exportJobs.expiresAt, now)));
  let deleted = 0;
  let missing = 0;
  for (const f of due) {
    try {
      await unlink(resolveInArea("exports", f.path));
      deleted++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      missing++;
    }
    await db().update(exportFiles).set({ deletedAt: now }).where(eq(exportFiles.id, f.fileId));
    await db().update(exportJobs).set({ status: "expired" }).where(eq(exportJobs.id, f.exportJobId));
    await recordAuditEvent({
      actor: ctx.actor,
      action: "journal.export.expired",
      spaceId: f.spaceId,
      targetType: "export_job",
      targetId: f.exportJobId,
      details: { fileName: f.fileName },
    });
  }
  ctx.log(`deleted ${deleted} expired export file(s), ${missing} already gone`);
  return { deleted, missing };
}

export const expireExportsJob = defineJob({
  name: "journals.expire-exports",
  input: expireJobInput,
  options: { retryLimit: 1, localConcurrency: 1 },
  // A getter, so the policy is read when the worker registers the job, not at import time.
  get schedule() {
    return { cron: getAppPolicy().policy.journals.expireCron, input: {} };
  },
  handler: (input, ctx) => runExpireExports(input, ctx),
});
