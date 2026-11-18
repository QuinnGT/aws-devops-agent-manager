import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { revisions } from "@/server/db/schema";
import type { PackageLayout } from "@/server/packages/layout";
import type { PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import { sha256Hex } from "@/server/sync/content";
import { ValidationFailure } from "@/server/validation/types";
import { getImportRow, resolveLayout, type PackageImportRow } from "./service";
import { readStoredUploadFile } from "./storage";
import { PackageIoError } from "./types";
import { readStoredUpload } from "./upload";

/**
 * "Fix in a revision": an import's package moved to a revision (the revision's
 * base records it as `fromImport`), where its files can be edited and checked
 * before the plan. While a revision holds the import, the import itself can't
 * be planned or read again with another layout.
 */

/** Revision states that hold the import they started from; a failed or abandoned revision gives it back. */
const HOLDING_STATES = ["creating", "open", "applied"] as const;

export interface ImportRevision {
  id: string;
  name: string;
  state: (typeof HOLDING_STATES)[number];
}

/** The revision an import was moved to, or null. */
export async function importRevision(spaceId: string, importId: string): Promise<ImportRevision | null> {
  const [r] = await db()
    .select({ id: revisions.id, name: revisions.name, state: revisions.state })
    .from(revisions)
    .where(and(eq(revisions.spaceId, spaceId), inArray(revisions.state, [...HOLDING_STATES]), sql`${revisions.base}->'fromImport'->>'importId' = ${importId}`))
    .limit(1);
  return r ? { ...r, state: r.state as ImportRevision["state"] } : null;
}

/** Refuse a plan or a new read of an import that a revision holds. */
export async function refuseIfInRevision(spaceId: string, importId: string): Promise<void> {
  const held = await importRevision(spaceId, importId);
  if (held) throw new PackageIoError("in-revision", `This import was moved to revision ${held.name}. Create the plan from the revision.`);
}

/**
 * An import's package, read to start a revision from it: refused like a plan
 * (no such import, already planned, not read, expired, changed on disk) and
 * when a revision other than `revisionId` already holds it. Validation errors
 * don't block: fixing them is what the revision is for.
 */
export async function readImportForRevision(
  space: Pick<Space, "id">,
  importId: string,
  policy: Policy,
  opts: { revisionId?: string } = {},
): Promise<{ row: PackageImportRow; layout: PackageLayout; contents: PackageContents }> {
  const row = await getImportRow(space.id, importId);
  if (!row) throw new PackageIoError("not-found", "There is no such import in this space.");
  if (row.status === "planned" || row.status === "planning") throw new PackageIoError("already-planned", "A plan was already created from this import, so it can't move to a revision.");
  if (row.status !== "analyzed") throw new PackageIoError("not-plannable", "The package could not be read, so it can't move to a revision. Fix the package and upload it again.");
  if (!row.storedPath || row.fileDeletedAt) throw new PackageIoError("upload-expired", "The uploaded package was deleted after its retention period. Upload it again.");
  const held = await importRevision(space.id, importId);
  if (held && held.id !== opts.revisionId) throw new PackageIoError("in-revision", `This import is already in revision ${held.name}.`);
  const layout = resolveLayout(policy, row.layout);
  const bytes = await readStoredUploadFile(row.storedPath);
  if (!bytes) throw new PackageIoError("upload-expired", "The uploaded package is no longer stored. Upload it again.");
  if (sha256Hex(bytes) !== row.sha256) throw new PackageIoError("upload-changed", "The stored upload does not match its SHA-256. Upload the package again.");
  try {
    return { row, layout, contents: readStoredUpload(bytes, row.packageName, { policy, layout }) };
  } catch (err) {
    if (err instanceof ValidationFailure) throw new PackageIoError("not-plannable", "The stored upload no longer passes the read checks.", err.results);
    throw err;
  }
}
