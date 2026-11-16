import { assertSafeStartup, env } from "@/server/env";
import { getAppPolicy } from "@/server/policy";
import { boss, stopBoss } from "@/server/jobs/boss";
import { closeDatabase } from "@/server/db/client";
import { allJobs } from "./handlers";
import { registerJob } from "./runner";

/**
 * Worker process: runs every background job (sync, export, import, apply,
 * analyze, review, replay). It is the only process that writes to git and the
 * only one that may use an Agent Space write role.
 */
async function main() {
  process.env.DAM_PROCESS = "worker";
  if (env().process !== "worker") throw new Error("DAM_PROCESS must be 'worker' for the worker process");
  assertSafeStartup();
  getAppPolicy(); // fail fast on a bad policy directory

  const b = await boss();
  for (const job of allJobs) await registerJob(b, job);
  console.log(`[worker] started with ${allJobs.length} job types: ${allJobs.map((j) => j.name).join(", ") || "(none)"}`);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal}, stopping`);
    await stopBoss();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
