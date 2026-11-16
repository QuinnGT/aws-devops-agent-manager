import { createHash } from "node:crypto";
import path from "node:path";
import { deployedVsReadAnalyzer, type DeployedVsReadOutput } from "@/server/analyzers/deployed-vs-read";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { analyzersRunInput, policyForSpace, runAnalyzersJob } from "@/server/analyzers/service";
import { loadJournalBundle } from "@/server/analyzers/store";
import type { PackageFile } from "@/server/analyzers/types";
import { listAssetCommits, openSpaceHistoryRepo } from "@/server/assets/repo";
import type { HistoryRepo } from "@/server/git/history-repo";
import type { JobContext } from "@/server/jobs/registry";
import type { Policy } from "@/server/policy";
import { parseManifest } from "@/server/releases/manifest";
import { readAssetJsonAt } from "@/server/releases/source";
import { VERIFY } from "./config";
import { fileKey, releasePackageFiles, type FileOrigin } from "./package-files";
import { investigationsInWindow, loadReleaseWindow, storedDeployedOutputs } from "./queries";
import { aggregateReads, filesNeedingVersions, identifyVersions, type InvestigationReads, type VersionCandidate } from "./reads";
import { finishBlocked, finishCancelled, finishFailed, finishSucceeded, isFinished, startRun, subContext, type VerifyJobInput, type VerifyJobResult } from "./run";
import type { ReadsCheckResult } from "./types";

/**
 * The verify.reads job (check 2): the release's skill and memory files from
 * its commit, the investigations that ran on the release, the
 * deployed-vs-read analyzer on each (analyzers.run's service, so the output
 * is stored and an unchanged rerun is skipped), then one outcome per
 * investigation and file. A body that isn't the release's is compared with
 * the file's other versions in the history repository.
 */

const sha256 = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

/**
 * Other versions of one file from the history repository, nearest to the
 * release's version first, at most `max`, each with content different from
 * the release's file and from each other.
 */
export async function versionCandidates(
  repo: HistoryRepo,
  origin: FileOrigin,
  releaseBody: string,
  max: number,
  layout: Pick<Policy["historyLayout"], "assetJson">,
): Promise<VersionCandidate[]> {
  if (!origin.gitPath || max <= 0) return [];
  const seen = new Set([sha256(releaseBody)]);
  const found: VersionCandidate[] = [];
  for (const c of await listAssetCommits(repo, origin.gitPath, origin.assetId, VERIFY.maxAssetCommits)) {
    const json = await readAssetJsonAt(repo, c.hash, origin.gitPath, layout);
    if (!json || json.assetId !== origin.assetId || json.serviceVersion === origin.version) continue;
    const entry = json.files.find((f) => f.path === origin.filePath && f.committed);
    if (!entry || seen.has(entry.sha256)) continue;
    const body = await repo.show(c.hash, path.posix.join(origin.gitPath, origin.filePath));
    if (body === null || sha256(body) !== entry.sha256) continue;
    seen.add(entry.sha256);
    found.push({ version: json.serviceVersion, relation: json.serviceVersion < origin.version ? "older" : "newer", commit: c.hash, body });
  }
  return found.sort((a, b) => Math.abs(a.version - origin.version) - Math.abs(b.version - origin.version) || a.version - b.version).slice(0, max);
}

export async function runVerifyReads(input: VerifyJobInput, ctx: JobContext): Promise<VerifyJobResult> {
  const started = await startRun(input, ctx, "reads");
  if (isFinished(started)) return started;
  const { run, release, space } = started;
  try {
    const policy = await policyForSpace(space.id);
    const opts = policy.verify.reads;
    const manifest = parseManifest(release.manifest);
    if (!manifest) return finishBlocked(run, "manifest-invalid", null);
    const opened = await openSpaceHistoryRepo(space, policy.historyLayout);
    if (!opened.ok) return finishBlocked(run, opened.reason, null);
    const repo = opened.repo;

    await ctx.progress(0.02, "Reading the release's files");
    const pkg = await releasePackageFiles(repo, manifest, policy);
    if (!pkg.files.length) return finishBlocked(run, "no-files", null);

    const window = await loadReleaseWindow(space.id, release, opts.window);
    const inWindow = await investigationsInWindow(space.id, window.from, window.to, opts.maxInvestigations);
    if (!inWindow.tasks.length) return finishBlocked(run, "no-journals", null);
    const taskIds = inWindow.tasks.map((t) => t.taskId);

    await ctx.progress(0.1, `Running the deployed-vs-read analyzer on ${taskIds.length} investigation(s)`);
    const analyzed = await runAnalyzersJob(
      analyzersRunInput.parse({ spaceId: space.id, taskIds, analyzers: [deployedVsReadAnalyzer.id], package: { label: release.name, files: pkg.files } }),
      subContext(ctx, 0.1, 0.6, "Analyzer"),
      { policy },
    );
    if (analyzed.cancelled) return finishCancelled(run);

    const digest = deployedVsReadAnalyzer.configDigest({ policy, packageFiles: pkg.files });
    const outputs = await storedDeployedOutputs(space.id, taskIds, deployedVsReadAnalyzer, digest);

    // Other versions of the files some investigation got a body for that isn't the release's.
    const filesByKey = new Map(pkg.files.map((f) => [fileKey(f), f]));
    const needed = new Set<string>();
    for (const out of outputs.values()) for (const r of filesNeedingVersions(out)) needed.add(fileKey(r));
    const candidates = new Map<string, VersionCandidate[]>();
    for (const key of needed) {
      const file = filesByKey.get(key);
      const origin = pkg.origins.get(key);
      if (file && origin) candidates.set(key, await versionCandidates(repo, origin, file.body, opts.versionsPerFile, policy.historyLayout));
    }

    const investigations: InvestigationReads[] = [];
    const incidentOf = new Map(inWindow.tasks.map((t) => [t.taskId, t.incidentId]));
    for (const [i, taskId] of taskIds.entries()) {
      if (await ctx.cancelled()) return finishCancelled(run);
      const output = outputs.get(taskId);
      if (!output) continue;
      await ctx.progress(0.6 + 0.35 * (i / taskIds.length), `Linking records of investigation ${i + 1} of ${taskIds.length}`);
      investigations.push(await linkInvestigation(space.id, taskId, incidentOf.get(taskId) ?? null, output, filesByKey, pkg.origins, candidates));
    }

    const aggregated = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations, policy });
    const result: ReadsCheckResult = {
      release: { id: release.id, name: release.name, sourceCommit: release.sourceCommit },
      window: { mode: window.mode, from: window.from.toISOString(), to: window.to?.toISOString() ?? null, nextRelease: window.nextRelease },
      investigationsInWindow: inWindow.total,
      investigations: investigations.length,
      missing: analyzed.missingTasks,
      errors: analyzed.errors.map((e) => ({ taskId: e.taskId, message: e.message })),
      analyzer: { id: deployedVsReadAnalyzer.id, version: deployedVsReadAnalyzer.version, packageDigest: digest },
      ...aggregated,
      skipped: pkg.skipped,
    };
    const covered = investigations.map((x) => x.taskId);
    await finishSucceeded(run, result, covered);
    await ctx.progress(1, `${aggregated.verdict === "failed" ? "Bodies that aren't the release's" : aggregated.verdict === "passed" ? "The release's bodies" : "No bodies"} in ${covered.length} investigation(s)`);
    return { verificationId: run.id, state: "succeeded", summary: { verdict: aggregated.verdict, investigations: covered.length, files: aggregated.files.length, ...aggregated.counts } };
  } catch (err) {
    await finishFailed(run, err);
    throw err;
  }
}

/** Record IDs for the analyzer's record numbers, and the versions behind bodies that aren't the release's, for one investigation. */
async function linkInvestigation(
  spaceId: string,
  taskId: string,
  incidentId: string | null,
  output: DeployedVsReadOutput,
  filesByKey: ReadonlyMap<string, PackageFile>,
  origins: ReadonlyMap<string, FileOrigin>,
  candidates: ReadonlyMap<string, VersionCandidate[]>,
): Promise<InvestigationReads> {
  const base: InvestigationReads = { taskId, incidentId, output };
  const touched = output.files.some((f) => f.verdict !== "not-read");
  if (!touched) return base;
  const bundle = await loadJournalBundle(spaceId, taskId);
  if (!bundle) return base;
  const norm = normalizeBundle(bundle);
  const recordIds = norm.records.map((r) => r.recordId);
  const requests = filesNeedingVersions(output)
    .map((r) => {
      const key = fileKey(r);
      const file = filesByKey.get(key);
      const list = candidates.get(key) ?? [];
      return file && list.length ? { file, releaseVersion: origins.get(key)?.version ?? 0, candidates: list } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return {
    ...base,
    incidentId: incidentId ?? bundle.task.incidentId ?? null,
    recordIdOf: (n) => recordIds[n - 1] ?? null,
    versions: identifyVersions(norm, requests),
  };
}
