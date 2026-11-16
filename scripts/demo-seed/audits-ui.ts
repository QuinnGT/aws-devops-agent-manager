/**
 * Demo data for the audit pages. Run against a disposable
 * database:
 *
 *   DATABASE_URL=... DAM_DATA_DIR=... \
 *     pnpm exec tsx --tsconfig tsconfig.json scripts/demo-seed/audits-ui.ts
 *
 * In the space "anycompany-tickets" (created when missing, with its history
 * repository and the sample policy overlay) it imports three sample benchmark
 * journals (INCIDENT-20101, 20104, 20105) and their ground truth from
 * sample-data/journals/benchmark/, creates the benchmark audit "Late October
 * low scores, first look" with the review model "example.reviewer-model", runs
 * it with a fake runReview built from the sample reference reviews
 * (sample-data/audit/reviews; no AWS, no model call), and leaves findings
 * proposed, accepted, rejected and one flagged by the citation check. It also
 * creates a benchmark draft, a before-and-after draft and an audit whose
 * reviews failed. Idempotent: audits that already exist by name are left
 * alone. The building blocks are in parts/audits.ts; all.ts
 * (`pnpm demo:seed`) runs them with every other screen's data.
 */
import "./lib/preload";
import { closeDatabase } from "@/server/db/client";
import { stopBoss } from "@/server/jobs/boss";
import { ALEX, REPO_NAME, REVIEW_MODEL, SAMPLE } from "./lib/common";
import { ensureDemoSpace } from "./lib/space";
import { seedAuditScreens } from "./parts/audits";

async function main() {
  const space = await ensureDemoSpace({ repoName: REPO_NAME, policyOverlayDir: SAMPLE.policyDir, reviewModelId: REVIEW_MODEL, actor: ALEX });
  console.log(`Space ${space.alias} (${space.id})`);
  await seedAuditScreens(space, ALEX);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopBoss().catch(() => {});
    await closeDatabase().catch(() => {});
  });
