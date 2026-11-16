/**
 * Demo data for the Report tab. Run with
 *
 *   DATABASE_URL=... DAM_DATA_DIR=<scratch data dir> \
 *     pnpm exec tsx --tsconfig tsconfig.json scripts/demo-seed/reports-ui.ts
 *
 * In the space `anycompany-tickets` (created when missing, with a local
 * history repository under DAM_DATA_DIR and the sample policy overlay), it
 * imports the sample benchmark journals and their ground truth from
 * sample-data/journals/benchmark/, then creates five benchmark audits through
 * the audit service and job handlers, with a fake reviewer that returns the
 * sample reference reviews (see parts/reports.ts for what each one shows). No
 * AWS or Bedrock calls. Idempotent: audits with these names are deleted and
 * made again. all.ts (`pnpm demo:seed`) runs the same part with every other
 * screen's data.
 */
import "./lib/preload";
import { stopBoss } from "@/server/jobs/boss";
import { ALEX, REPO_NAME, REVIEW_MODEL, REVIEWER, SAMPLE } from "./lib/common";
import { ensureDemoSpace } from "./lib/space";
import { REPORT_NAMES, seedReportScreens } from "./parts/reports";

async function main() {
  const space = await ensureDemoSpace({ repoName: REPO_NAME, policyOverlayDir: SAMPLE.policyDir, reviewModelId: REVIEW_MODEL, actor: ALEX });
  console.log(`Space ${space.alias} (${space.id})`);

  const ids = await seedReportScreens(space, { owner: ALEX, reviewer: REVIEWER });

  console.log("\nReport tabs:");
  for (const [key, name] of Object.entries(REPORT_NAMES) as [keyof typeof REPORT_NAMES, string][]) console.log(`  ${name}: /spaces/${space.alias}/audits/${ids[key]}/report`);
  await stopBoss();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
