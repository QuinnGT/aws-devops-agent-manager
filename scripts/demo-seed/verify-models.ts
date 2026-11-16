/**
 * Demo seed for the model screens: the release Verification
 * tab and the model fields in Space settings. No AWS calls: the DevOps Agent
 * and CloudTrail clients are mocked in this process (aws-sdk-client-mock),
 * the Agent Space serves sample package v1 (sample-data/packages/v1), and the
 * jobs run in this process against those mocks.
 *
 *   DATABASE_URL=... DAM_DATA_DIR=<scratch data dir> \
 *     pnpm exec tsx --tsconfig tsconfig.json scripts/demo-seed/verify-models.ts
 *
 * What it builds in space `anycompany-tickets` (recreated on every run, with
 * its history repository and the sample policy overlay):
 *   - Space settings: environment Test, a default review model
 *   - a baseline sync and release v1 from the live state (no checks, no
 *     investigations since: the empty states)
 *   - plan "Apply the cache audit fixes to seat-map-service and
 *     change-window-search" (a memory and a skill, with the text of package
 *     v2), checked and applied
 *   - release v1.1, tagged after that plan
 *   - live changes since: one skill changed, one deleted, one added
 *   - five investigations after the release (INCIDENT-20301 to 20305); one
 *     read the memory's older (v1) body, two requested the deleted skill
 *     and got nothing back
 *   - both checks run: live state and what the agent read
 *
 * The building blocks are in parts/verify.ts and the story in parts/story.ts;
 * all.ts (`pnpm demo:seed`) runs them with every other screen's data.
 */
import "./lib/preload";
import { closeDatabase } from "@/server/db/client";
import { stopBoss } from "@/server/jobs/boss";
import { policyForSpace } from "@/server/journals/policy";
import { ALEX, ALIAS, logger, NO_AWS_PROFILE, REPO_NAME, REVIEW_MODEL, SAMPLE } from "./lib/common";
import { resetHistoryDir } from "./lib/reset";
import { createDemoSpace, deleteSpaceByAlias } from "./lib/space";
import { fakeSpaceFrom, packageAssets, samplePackages } from "./parts/content";
import { STORY, verifyStory } from "./parts/story";
import { installMocks, seedVerification } from "./parts/verify";

const log = logger("seed");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
  if (!process.env.DAM_DATA_DIR) throw new Error("Set DAM_DATA_DIR to a scratch directory");

  // ---------- the space, recreated ----------
  await deleteSpaceByAlias(ALIAS, REPO_NAME);
  await resetHistoryDir(REPO_NAME);
  const space = await createDemoSpace({ repoName: REPO_NAME, awsProfile: NO_AWS_PROFILE, reviewModelId: REVIEW_MODEL, policyOverlayDir: SAMPLE.policyDir, actor: ALEX });
  log(`space ${ALIAS} (${space.id}), default review model ${REVIEW_MODEL}`);
  const policy = (await policyForSpace(space)).policy;

  // ---------- mocked AWS: the sample package v1 ----------
  const packages = await samplePackages(policy);
  const fake = fakeSpaceFrom(packageAssets(packages.v1, policy));

  const mocks = installMocks(fake);
  try {
    await seedVerification(space, policy, mocks, verifyStory(fake, packages, policy), ALEX);
  } finally {
    mocks.restore();
  }
  log(`open http://127.0.0.1:<port>/spaces/${ALIAS}/releases/${STORY.release}/verification`);
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
