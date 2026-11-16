import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { uploadGroundTruth } from "@/server/audits/evidence";
import { db } from "@/server/db/client";
import { journalTasks } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { runImport, saveUpload } from "@/server/journals/import";
import type { Space } from "@/server/spaces/queries";
import { benchmarkFiles, type SeedPerson } from "./common";
import { settle } from "./jobs";

/**
 * The sample benchmark set (sample-data/journals/benchmark: eight audited
 * investigations, INCIDENT-20101 to INCIDENT-20108): journals and ground
 * truth, imported through the journal import service and job handler.
 */

/** The benchmark incidents, in order. */
export const BENCHMARK_INCIDENTS = [101, 102, 103, 104, 105, 106, 107, 108].map((n) => `INCIDENT-20${String(n).padStart(3, "0")}`);

/** Import the journals of these incidents that the space doesn't have yet. Returns the incidents imported now. */
export async function importBenchmarkJournals(space: Space, actor: SeedPerson, incidents: readonly string[]): Promise<string[]> {
  const have = new Set(
    (
      await db()
        .select({ incidentId: journalTasks.incidentId })
        .from(journalTasks)
        .where(and(eq(journalTasks.spaceId, space.id), inArray(journalTasks.incidentId, [...incidents])))
    ).map((r) => r.incidentId),
  );
  const imported: string[] = [];
  for (const inc of incidents) {
    if (have.has(inc)) continue;
    const file = benchmarkFiles(inc).journal;
    const { importId, runId } = await saveUpload(space, { fileName: path.basename(file), bytes: readFileSync(file) }, actor);
    const report = await runImport({ importId }, testJobContext({ actor, spaceId: space.id, runId }));
    await settle(runId, report);
    imported.push(inc);
  }
  return imported;
}

/** Upload the root cause document and scorecard of each incident as benchmark ground truth. */
export async function uploadBenchmarkGroundTruth(space: Space, actor: SeedPerson, incidents: readonly string[]) {
  const files = incidents.flatMap((inc) => {
    const f = benchmarkFiles(inc);
    return [f.rca, f.scorecard];
  });
  return uploadGroundTruth(actor, space.id, files.map((f) => ({ fileName: path.basename(f), bytes: readFileSync(f) })), { profileId: "benchmark" });
}
