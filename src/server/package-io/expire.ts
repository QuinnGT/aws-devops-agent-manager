import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { packageImports } from "@/server/db/schema";
import { defineJob, type JobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { deleteStoredUpload } from "./storage";

/**
 * Daily job: delete stored uploads past their expiry (package-io.yaml
 * uploads.retentionDays). The import rows and their mapping results stay.
 */

export const expireUploadsInput = z.object({}).default({});

export async function runExpireUploads(_input: unknown, ctx: JobContext, now: Date = new Date()): Promise<{ deleted: number; missing: number }> {
  const due = await db()
    .select({ id: packageImports.id, spaceId: packageImports.spaceId, storedPath: packageImports.storedPath, fileName: packageImports.fileName, sha256: packageImports.sha256 })
    .from(packageImports)
    .where(and(isNotNull(packageImports.storedPath), isNull(packageImports.fileDeletedAt), lte(packageImports.expiresAt, now)));
  let deleted = 0;
  let missing = 0;
  for (const row of due) {
    if (await deleteStoredUpload(row.storedPath!)) deleted++;
    else missing++;
    await db().update(packageImports).set({ fileDeletedAt: now }).where(eq(packageImports.id, row.id));
    await recordAuditEvent({
      actor: ctx.actor,
      action: "package.import.expired",
      spaceId: row.spaceId,
      targetType: "package_import",
      targetId: row.id,
      details: { fileName: row.fileName, sha256: row.sha256 },
    });
  }
  ctx.log(`deleted ${deleted} expired package upload(s), ${missing} already gone`);
  return { deleted, missing };
}

export const expireUploadsJob = defineJob({
  name: "package-io.expire-uploads",
  input: expireUploadsInput,
  options: { retryLimit: 1, localConcurrency: 1 },
  // A getter, so the policy is read when the worker registers the job, not at import time.
  get schedule() {
    return { cron: getAppPolicy().policy.packageIo.uploads.expireCron, input: {} };
  },
  handler: (input, ctx) => runExpireUploads(input, ctx),
});
