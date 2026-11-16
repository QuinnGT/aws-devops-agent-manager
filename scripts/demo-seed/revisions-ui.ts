/**
 * Demo data for the revision pages: the space
 * anycompany-tickets with a local history repository under DAM_DATA_DIR and
 * the sample policy overlay (sample-data/policy) committed into it, its assets
 * (sample package v1, sample-data/packages/v1) committed the way the sync
 * worker writes them, release v1.1, the audits of the sample benchmark
 * journals (so there are accepted findings to link), and five revisions:
 *
 *   ruleout-rules    from release v1.1, three saves, the last build fails
 *   vendor-first     from release v1.1, two saves, the build passes
 *   pricing-memory   from release v1.1, one save, a plan waiting for approval
 *   live-changes     from the live space, no saves yet
 *   old-scope        abandoned
 *
 * plus a second space, anycompany-empty, with an empty history repository and
 * no revisions or findings, for the empty state.
 *
 * Runs the create and save job handlers directly with testJobContext() and
 * never calls AWS (the sync before a live revision is a stub). Idempotent:
 * it empties the database it is pointed at (refused unless its name starts
 * with "dam_" and is not "dam") and the demo history repositories first.
 * The building blocks are in parts/; all.ts (`pnpm demo:seed`) runs them on
 * a mocked Agent Space with every other screen's data.
 *
 *   DATABASE_URL=... DAM_DATA_DIR=.scratch/data pnpm exec tsx --tsconfig tsconfig.json scripts/demo-seed/revisions-ui.ts
 */
import "./lib/preload";
import { closeDatabase } from "@/server/db/client";
import { env } from "@/server/env";
import { HistoryRepo } from "@/server/git/history-repo";
import { stopBoss } from "@/server/jobs/boss";
import { policyForSpace } from "@/server/journals/policy";
import { testJobContext } from "@/server/jobs/registry";
import { createReleaseHandler, prepareCreateRelease } from "@/server/releases/create";
import { getHistoryRepoForSpace, toHistoryRepoConfig } from "@/server/spaces/queries";
import { ALEX, ALIAS, REPO_NAME, REVIEW_MODEL, REVIEWER, SAM, SAMPLE } from "./lib/common";
import { resetDatabase, resetHistoryDir } from "./lib/reset";
import { createDemoSpace } from "./lib/space";
import { seedAuditScreens } from "./parts/audits";
import { commitTestAssets, packageAssets, samplePackages } from "./parts/content";
import { seedReportScreens } from "./parts/reports";
import { acceptedFindingLink, noSync, seedRevisionScreens, waitingPlan } from "./parts/revisions";
import { STORY } from "./parts/story";

const EMPTY_REPO_NAME = "anycompany-empty-history";

async function main() {
  console.log(`Seeding ${ALIAS} (history under ${env().dataDir})`);
  await resetDatabase();
  await resetHistoryDir(REPO_NAME);

  const space = await createDemoSpace({ repoName: REPO_NAME, reviewModelId: REVIEW_MODEL, policyOverlayDir: SAMPLE.policyDir, actor: ALEX });
  const policy = (await policyForSpace(space)).policy;
  const repo = await HistoryRepo.open(toHistoryRepoConfig((await getHistoryRepoForSpace(space))!));

  const packages = await samplePackages(policy);
  console.log(`Assets from ${packages.v1.source}`);
  const assets = packageAssets(packages.v1, policy);
  await commitTestAssets(space, repo, policy, assets);
  console.log(`  ${assets.length} assets committed`);

  const rel = await prepareCreateRelease({ spaceId: space.id, name: STORY.release, note: "Before the late October audit fixes" });
  await createReleaseHandler(rel, testJobContext({ actor: { email: ALEX.email }, spaceId: space.id }), { sync: noSync });
  console.log(`  release ${STORY.release} tagged`);

  // Accepted findings to link come from the audits of the benchmark journals.
  await seedAuditScreens(space, ALEX);
  await seedReportScreens(space, { owner: ALEX, reviewer: REVIEWER });
  const link = await acceptedFindingLink(space.id);
  await seedRevisionScreens({
    space,
    repo,
    policy,
    packages,
    layoutName: packages.v1.layout.name,
    releaseId: rel.releaseId,
    link,
    people: { owner: ALEX, sam: SAM },
    createPlan: waitingPlan(space.id, ALEX),
  });

  // A space with nothing in it yet, for the empty list.
  await resetHistoryDir(EMPTY_REPO_NAME);
  await createDemoSpace({ alias: "anycompany-empty", displayName: "AnyCompany Empty (sample)", repoName: EMPTY_REPO_NAME, agentSpaceId: "00000000-0000-4000-8000-0000000000e1", actor: ALEX });

  console.log(`Done. Open http://127.0.0.1:${process.env.PORT ?? 3103}/spaces/${ALIAS}/revisions`);
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
