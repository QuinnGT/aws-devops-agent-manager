import { deployedVsRead, type DeployedFileResult, type DeployedVsReadOutput } from "@/server/analyzers/deployed-vs-read";
import type { NormBundle } from "@/server/analyzers/normalize";
import type { PackageFile } from "@/server/analyzers/types";
import type { Policy } from "@/server/policy";
import { fileKey, type FileOrigin } from "./package-files";
import { READ_OUTCOMES, type FileVerdict, type MatchedVersion, type ReadOutcome, type ReadsCheckResult, type ReadsFileRow, type RecordExample } from "./types";

/**
 * Check 2, what the agent read:
 * the deployed-vs-read analyzer's output per investigation, turned into one
 * outcome per investigation and file, and aggregated per file. Pure.
 *
 * A body that isn't the release's is compared with the file's other versions
 * from the history repository, so "the agent read v1 after v2 was sent"
 * shows as an older body instead of a 97% near match.
 */

/** Another version of a package file, from the history repository. */
export interface VersionCandidate {
  version: number;
  relation: "older" | "newer";
  commit: string;
  body: string;
}

export interface VersionMatch {
  match: MatchedVersion;
  /** Record whose returned body matched the version */
  n: number | null;
}

/**
 * For each file, the version among `candidates` whose body the investigation
 * returned (the analyzer's "matches" verdict for that version's body), or
 * null. Several matches: the best line shares, then the version nearest the
 * release. One analyzer pass over the journal for every file.
 */
export function identifyVersions(
  norm: NormBundle,
  requests: readonly { file: PackageFile; releaseVersion: number; candidates: readonly VersionCandidate[] }[],
): Map<string, VersionMatch | null> {
  const flat: { key: string; candidate: VersionCandidate; file: PackageFile; releaseVersion: number }[] = [];
  for (const r of requests) for (const c of r.candidates) flat.push({ key: fileKey(r.file), candidate: c, file: { ...r.file, body: c.body }, releaseVersion: r.releaseVersion });
  const out = new Map<string, VersionMatch | null>(requests.map((r) => [fileKey(r.file), null]));
  if (!flat.length) return out;
  const results = deployedVsRead(norm, flat.map((f) => f.file)).files;
  // Every candidate keeps the release file's type, name and path, so the analyzer keeps them all, in order.
  if (results.length !== flat.length) return out;
  const best = new Map<string, { score: number; distance: number; match: VersionMatch }>();
  results.forEach((res, i) => {
    const f = flat[i]!;
    if (res.verdict !== "matches") return;
    const score = (res.pkg ?? 0) + (res.ret ?? 0);
    const distance = Math.abs(f.candidate.version - f.releaseVersion);
    const cur = best.get(f.key);
    if (cur && (cur.score > score || (cur.score === score && cur.distance <= distance))) return;
    best.set(f.key, { score, distance, match: { match: { version: f.candidate.version, relation: f.candidate.relation, commit: f.candidate.commit }, n: res.returnedAt } });
  });
  for (const [k, v] of best) out.set(k, v.match);
  return out;
}

/** One investigation's outcome for one file. */
export function classifyRead(result: DeployedFileResult | undefined, version: VersionMatch | null | undefined): ReadOutcome {
  if (!result) return "not-requested";
  switch (result.verdict) {
    case "matches":
      return "release-body";
    case "near":
    case "different":
      if (version) return version.match.relation === "older" ? "older-body" : "newer-body";
      return result.verdict === "near" ? "near-release" : "other-body";
    case "requested-no-body":
      return "requested-no-body";
    default:
      return "not-requested";
  }
}

/** The record an example links to: the returned body, or the first request. */
function exampleRecordNumber(result: DeployedFileResult | undefined, outcome: ReadOutcome, version: VersionMatch | null | undefined): number | null {
  if (!result) return null;
  if ((outcome === "older-body" || outcome === "newer-body") && version?.n) return version.n;
  return result.returnedAt ?? result.readAt[0] ?? null;
}

export interface InvestigationReads {
  taskId: string;
  incidentId: string | null;
  output: DeployedVsReadOutput;
  /** Record number (the analyzer's 1-based numbering) to record ID */
  recordIdOf?: (n: number) => string | null;
  /** Version matches for files this investigation got a body for that isn't the release's */
  versions?: ReadonlyMap<string, VersionMatch | null>;
}

const OUTCOME_RANK: Record<ReadOutcome, number> = Object.fromEntries(READ_OUTCOMES.map((o, i) => [o, i])) as Record<ReadOutcome, number>;

function emptyCounts(): Record<ReadOutcome, number> {
  return Object.fromEntries(READ_OUTCOMES.map((o) => [o, 0])) as Record<ReadOutcome, number>;
}

export function fileVerdictOf(counts: Record<ReadOutcome, number>): FileVerdict {
  return READ_OUTCOMES.find((o) => counts[o] > 0) ?? "not-requested";
}

const FAILING: readonly ReadOutcome[] = ["older-body", "other-body", "newer-body"];
const PASSING: readonly ReadOutcome[] = ["release-body", "near-release"];

export function aggregateReads(input: {
  files: readonly PackageFile[];
  origins: ReadonlyMap<string, FileOrigin>;
  investigations: readonly InvestigationReads[];
  policy: Pick<Policy, "assetTypes" | "verify">;
}): Pick<ReadsCheckResult, "verdict" | "counts" | "files" | "stores"> {
  const { files, origins, investigations, policy } = input;
  const examplesPerFile = policy.verify.reads.examplesPerFile;
  const rows: ReadsFileRow[] = [];
  for (const f of files) {
    const key = fileKey(f);
    const origin = origins.get(key);
    if (!origin) continue;
    const counts = emptyCounts();
    const examples: Partial<Record<ReadOutcome, RecordExample[]>> = {};
    const versions = new Map<number, MatchedVersion>();
    let requested = 0;
    let worst: { pkg: number; ret: number } | null = null;
    let diffFrom: DeployedFileResult | null = null;
    for (const inv of investigations) {
      const result = inv.output.files.find((r) => r.assetType === f.assetType && r.name === f.name && r.path === f.path);
      const version = inv.versions?.get(key);
      const outcome = classifyRead(result, version);
      counts[outcome]++;
      if (result?.read) requested++;
      if (version && (outcome === "older-body" || outcome === "newer-body")) versions.set(version.match.version, version.match);
      if (FAILING.includes(outcome) || outcome === "near-release") {
        if (result && result.pkg !== null && result.ret !== null && (!worst || result.pkg + result.ret < worst.pkg + worst.ret)) worst = { pkg: result.pkg, ret: result.ret };
        diffFrom ??= result ?? null;
      }
      const list = (examples[outcome] ??= []);
      if (outcome !== "not-requested" && list.length < examplesPerFile) {
        const n = exampleRecordNumber(result, outcome, version);
        list.push({
          taskId: inv.taskId,
          incidentId: inv.incidentId,
          n,
          recordId: n !== null && inv.recordIdOf ? inv.recordIdOf(n) : null,
          ...(outcome === "older-body" || outcome === "newer-body" ? { version: version?.match.version ?? null } : {}),
        });
      }
    }
    for (const k of Object.keys(examples) as ReadOutcome[]) if (!examples[k]!.length) delete examples[k];
    rows.push({
      rowKey: `${f.assetType}:${f.name}:${f.path}`,
      assetType: f.assetType,
      typeLabel: policy.assetTypes.assetTypes[f.assetType]?.label ?? f.assetType,
      assetId: origin.assetId,
      releaseVersion: origin.version,
      assetName: origin.assetName,
      store: origin.store,
      filePath: origin.filePath,
      deployedPath: origin.deployedPath,
      verdict: fileVerdictOf(counts),
      counts,
      investigations: investigations.length,
      requested,
      matchedVersions: [...versions.values()].sort((a, b) => b.version - a.version),
      worstShares: worst,
      releaseOnly: diffFrom?.packageOnly ?? [],
      deployedOnly: diffFrom?.deployedOnly ?? [],
      examples,
    });
  }

  const typeOrder = Object.keys(policy.assetTypes.assetTypes);
  const rank = (t: string) => (typeOrder.indexOf(t) < 0 ? typeOrder.length : typeOrder.indexOf(t));
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort(
    (a, b) =>
      OUTCOME_RANK[a.verdict] - OUTCOME_RANK[b.verdict] ||
      rank(a.assetType) - rank(b.assetType) ||
      cmp(a.store ?? "", b.store ?? "") ||
      cmp(a.assetName, b.assetName) ||
      cmp(a.filePath, b.filePath),
  );

  const counts = emptyCounts();
  for (const r of rows) counts[r.verdict]++;
  const verdict = FAILING.some((o) => counts[o] > 0) ? "failed" : PASSING.some((o) => counts[o] > 0) ? "passed" : "inconclusive";

  const storeNames = [...new Set(files.filter((f) => f.assetType === "memory").map((f) => f.name))].sort(cmp);
  const stores = storeNames.map((store) => ({
    store,
    referencedIn: investigations.filter((inv) => inv.output.stores.some((s) => s.store === store && s.referenced)).length,
  }));
  return { verdict, counts, files: rows, stores };
}

/** Files of one investigation that need their other versions compared: a body came back and it isn't the release's. */
export function filesNeedingVersions(output: DeployedVsReadOutput): DeployedFileResult[] {
  return output.files.filter((f) => f.verdict === "near" || f.verdict === "different");
}
