/**
 * One sample dataset for the whole app: `pnpm demo:seed`.
 *
 *   DATABASE_URL=<a dam_* database> DAM_DATA_DIR=<scratch data dir> pnpm demo:seed
 *
 * Everything comes from sample-data/ (see its README): the fictional
 * AnyCompany Tickets, its two instruction packages, the benchmark journals and
 * the reference reviews. Nothing outside the repository is read.
 *
 * Empties the database DATABASE_URL names (refused unless its name starts
 * with "dam_" and is not "dam") and the demo history repository under
 * DAM_DATA_DIR, then fills the space "anycompany-tickets" so every page has
 * something to show: the sample policy overlay committed into the history
 * repository, assets, history, plans, releases v1 and v1.1 with both
 * verification checks, journals and analyzer results, audits in every state
 * with a report, an audit reviewed with review files, revisions (one with
 * accepted fixes from an audit on its to-address list), and a default review
 * model in Space settings.
 *
 * No AWS, Bedrock or network calls: the Agent Space is a mock
 * (aws-sdk-client-mock) serving sample package v1, reviews come from the
 * sample reference reviews, and report text from the AI SDK's mock model.
 * Jobs run in this process. The space names an AWS profile that doesn't
 * exist, so the dev server can't reach AWS for it either.
 *
 * To look at the result, run the dev server as the space owner:
 * AUTH_DEV_BYPASS=true AUTH_DEV_USER_EMAIL=alex@example.com AUTH_DEV_USER_NAME="Alex Rivera".
 */
import "./lib/preload";
import { eq } from "drizzle-orm";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { closeDatabase, db } from "@/server/db/client";
import { auditItems, audits as auditsTable, journalTasks } from "@/server/db/schema";
import { stopBoss } from "@/server/jobs/boss";
import { policyForSpace } from "@/server/journals/policy";
import { getReleaseByName } from "@/server/releases/queries";
import { syncSpace } from "@/server/sync/engine";
import { ALEX, ALIAS, logger, NO_AWS_PROFILE, REPO_NAME, REVIEW_MODEL, REVIEWER, SAM, SAMPLE } from "./lib/common";
import { cancelLeftovers, drain } from "./lib/jobs";
import { resetDatabase, resetHistoryDir } from "./lib/reset";
import { createDemoSpace } from "./lib/space";
import { seedAnalysis } from "./parts/analysis";
import { seedAuditScreens } from "./parts/audits";
import { fakeSpaceFrom, packageAssets, samplePackages } from "./parts/content";
import { sendFixesToRevision, seedReviewFilesAudit } from "./parts/flow";
import { seedReportScreens } from "./parts/reports";
import { acceptedFindingLink, seedRevisionScreens } from "./parts/revisions";
import { verifyStory } from "./parts/story";
import { installMocks, seedVerification } from "./parts/verify";

const log = logger("demo-seed");

async function main() {
  const started = Date.now();
  const database = await resetDatabase();
  const historyDir = await resetHistoryDir(REPO_NAME);
  log(`emptied database ${database} and ${historyDir}`);

  // The space's policy is the app's policy with the sample overlay, which createDemoSpace commits into its history repository.
  const space = await createDemoSpace({ repoName: REPO_NAME, awsProfile: NO_AWS_PROFILE, reviewModelId: REVIEW_MODEL, policyOverlayDir: SAMPLE.policyDir, actor: ALEX });
  log(`space ${ALIAS} (${space.id}), default review model ${REVIEW_MODEL}`);
  const policy = (await policyForSpace(space)).policy;

  const packages = await samplePackages(policy);
  const fake = fakeSpaceFrom(packageAssets(packages.v1, policy));
  log(`assets from ${packages.v1.source}: ${fake.assets.size}`);

  const mocks = installMocks(fake);
  const pages: string[] = [];
  try {
    // ---------- assets, history, plan, releases, verification ----------
    const verify = await seedVerification(space, policy, mocks, verifyStory(fake, packages, policy), ALEX);

    // ---------- audits and reports (the benchmark journals) ----------
    await seedAuditScreens(space, ALEX);
    const reports = await seedReportScreens(space, { owner: ALEX, reviewer: REVIEWER });

    // ---------- revisions ----------
    const link = await acceptedFindingLink(space.id);
    const opened = await openSpaceHistoryRepo(space, policy.historyLayout);
    if (!opened.ok) throw new Error(opened.message);
    const release = (await getReleaseByName(space.id, verify.release))!;
    const revisions = await seedRevisionScreens({
      space,
      repo: opened.repo,
      policy,
      packages,
      layoutName: packages.v1.layout.name,
      releaseId: release.id,
      link,
      people: { owner: ALEX, sam: SAM },
      sync: syncSpace,
    });
    await drain(space.id);

    // ---------- an audit's fixes queued in a revision, and an audit reviewed with review files ----------
    // The audit in review keeps two fixes in no revision, so its page shows that warning; the saved audit has all of its fixes queued.
    await sendFixesToRevision(space, { auditId: reports.main, revisionId: revisions.vendor, count: 2, actor: ALEX });
    await sendFixesToRevision(space, { auditId: reports.finalized, revisionId: revisions.live, count: 10, actor: ALEX });
    await seedReviewFilesAudit(space, ALEX);
    await drain(space.id);

    // ---------- analyzer results for every investigation ----------
    const analysis = await seedAnalysis(space, ALEX);
    log(`analyzers over ${analysis.tasks} investigations`);
    await drain(space.id);
    const cancelled = await cancelLeftovers(space.id);
    if (cancelled.length) log(`cancelled queued jobs the seed doesn't run: ${cancelled.join(", ")}`);

    // ---------- pages ----------
    const base = `/spaces/${ALIAS}`;
    pages.push("/spaces", base, `${base}/assets`, `${base}/history`, `${base}/plans`, `${base}/plans/import`, `${base}/drafts`, `${base}/releases`, `${base}/journals`, `${base}/journals/imports`, `${base}/journals/exports`, `${base}/analysis`, `${base}/audits`, `${base}/audits/new`, `${base}/revisions`, `${base}/roles`, `${base}/settings`);
    // /history/<assetId> redirects to the asset's Versions tab, so the list names the tab.
    for (const id of verify.assetIds) pages.push(`${base}/assets/${id}`, `${base}/assets/${id}?tab=versions`);
    pages.push(`${base}/plans/${verify.planId}`, `${base}/plans/${revisions.planId}`);
    for (const r of [verify.firstRelease, verify.release]) pages.push(`${base}/releases/${r}`, `${base}/releases/${r}/verification`, `${base}/releases/${r}/rollback`);
    const tasks = await db().select({ taskId: journalTasks.taskId }).from(journalTasks).where(eq(journalTasks.spaceId, space.id));
    for (const t of tasks) pages.push(`${base}/journals/investigations/${encodeURIComponent(t.taskId)}`, `${base}/analysis/${encodeURIComponent(t.taskId)}`);
    const auditRows = await db().select({ id: auditsTable.id, state: auditsTable.state }).from(auditsTable).where(eq(auditsTable.spaceId, space.id)).orderBy(auditsTable.createdAt);
    for (const { id, state } of auditRows) {
      // A draft audit has no reviews yet, so its Findings tab redirects to the audit page.
      pages.push(`${base}/audits/${id}`, ...(state === "draft" ? [] : [`${base}/audits/${id}/findings`]), `${base}/audits/${id}/report`);
      const items = await db().select({ id: auditItems.id }).from(auditItems).where(eq(auditItems.auditId, id));
      for (const it of items) pages.push(`${base}/audits/${id}/items/${it.id}`);
    }
    for (const id of [revisions.ruleout, revisions.vendor, revisions.pricing, revisions.live, revisions.old]) pages.push(`${base}/revisions/${id}`);
  } finally {
    mocks.restore();
  }

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)} s.`);
  console.log(`Pages (${pages.length}):`);
  for (const p of pages) console.log(`  ${p}`);
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
