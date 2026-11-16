import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deployedVsRead } from "@/server/analyzers/deployed-vs-read";
import { memoryReads } from "@/server/analyzers/memory-reads";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { markdownBundle } from "@/server/analyzers/testing";
import { parseJournalMarkdown } from "@/server/journals/markdown-import";
import { packageToDesiredAssets, readPackageFolder } from "@/server/packages";
import { SAMPLE_DATA_DIR, sampleLiveRunsDir, samplePackageDir, samplePolicy } from "../../../test/helpers/fixtures";
import { analyzerPackageFiles, desiredAssetsWithFiles, fileKey } from "./package-files";
import { aggregateReads, filesNeedingVersions, identifyVersions, type InvestigationReads, type VersionCandidate } from "./reads";

/**
 * Check 2 on the sample dataset: release v2 was sent on 2026-11-02, yet four
 * live investigations on 2026-11-03 read the v1 bodies of four memories
 * (sample-data/journals/live-runs). It runs on data that ships with the
 * repository, so it never skips.
 */

const policy = samplePolicy();
const expected = JSON.parse(readFileSync(path.join(SAMPLE_DATA_DIR, "expected/verify-live-runs.json"), "utf8")) as {
  release: string;
  earlierVersion: string;
  investigations: string[];
  verdict: string;
  fileCounts: Record<string, number>;
  filesRead: { deployedPath: string; verdict: string; matchedVersions: number[]; counts: Record<string, number> }[];
  stores: { store: string; referencedIn: number }[];
  memoryPathsRequested: Record<string, string[]>;
};

async function packageFiles(version: "v1" | "v2", layout: string, releaseVersion: number) {
  const contents = await readPackageFolder(samplePackageDir(version), { policy, layout });
  return analyzerPackageFiles(desiredAssetsWithFiles(packageToDesiredAssets(contents, layout, { policy }).assets, policy, releaseVersion), policy);
}

async function runCheck() {
  const release = await packageFiles("v2", "anycompany-v2", 2);
  const v1 = await packageFiles("v1", "anycompany-v1", 1);
  const v1ByKey = new Map(v1.files.map((f) => [fileKey(f), f.body]));
  const investigations: InvestigationReads[] = [];
  const names = readdirSync(sampleLiveRunsDir()).filter((f) => f.endsWith(".md")).sort();
  for (const name of names) {
    const text = readFileSync(path.join(sampleLiveRunsDir(), name), "utf8");
    const norm = normalizeBundle(markdownBundle(text, policy, createHash("sha256").update(text).digest("hex")));
    const output = deployedVsRead(norm, release.files);
    const requests = filesNeedingVersions(output)
      .map((r) => {
        const file = release.files.find((f) => fileKey(f) === fileKey(r))!;
        const body = v1ByKey.get(fileKey(r));
        const candidates: VersionCandidate[] = body && body !== file.body ? [{ version: 1, relation: "older", commit: "v1", body }] : [];
        return { file, releaseVersion: 2, candidates };
      })
      .filter((r) => r.candidates.length);
    investigations.push({ taskId: name, incidentId: norm.task.incidentId, output, versions: identifyVersions(norm, requests) });
  }
  return { names, investigations, result: aggregateReads({ files: release.files, origins: release.origins, investigations, policy }) };
}

describe("the sample live-run journals", () => {
  it("parse in the record-created format, newest record first, with 15 to 40 records each", () => {
    const names = readdirSync(sampleLiveRunsDir()).filter((f) => f.endsWith(".md")).sort();
    expect(names).toEqual(["INCIDENT-20201-journal.md", "INCIDENT-20202-journal.md", "INCIDENT-20203-journal.md", "INCIDENT-20204-journal.md"]);
    for (const name of names) {
      const text = readFileSync(path.join(sampleLiveRunsDir(), name), "utf8");
      const p = parseJournalMarkdown(text, policy, { sourceSha256: createHash("sha256").update(text).digest("hex"), fileName: name });
      expect(p.format).toBe("record-created");
      expect(p.warnings).toEqual([]);
      expect(p.task.incidentId).toBe(name.replace("-journal.md", ""));
      expect(p.task.title).toMatch(/^INC-73\d\d: \[us-west-2\]/);
      expect(p.records.length).toBeGreaterThanOrEqual(15);
      expect(p.records.length).toBeLessThanOrEqual(40);
      // The file lists the newest record first; the parser numbers them oldest first.
      const times = p.records.map((r) => r.createdAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(p.records[0]!.createdAt.toISOString().slice(0, 10)).toBe("2026-11-03");
      expect(p.records.map((r) => r.recordType)).toEqual(expect.arrayContaining(["message", "symptom", "finding", "investigation_summary_md", "mitigation_summary_md"]));
    }
  });
});

describe("memory reads in the sample live runs", () => {
  it("request the memory files each story reads, and none that is missing", () => {
    const requested: Record<string, string[]> = {};
    for (const name of readdirSync(sampleLiveRunsDir()).filter((f) => f.endsWith(".md")).sort()) {
      const text = readFileSync(path.join(sampleLiveRunsDir(), name), "utf8");
      const out = memoryReads(normalizeBundle(markdownBundle(text, policy, createHash("sha256").update(text).digest("hex"))), policy.analyzers.memoryReads);
      expect(out.file_not_found).toEqual([]);
      requested[name.replace("-journal.md", "")] = out.memory_file_paths.map(([, p]) => p.replace("/aidevops/memory/", ""));
    }
    expect(requested).toEqual(expected.memoryPathsRequested);
  });
});

describe("check 2 on release v2 over the four live runs", () => {
  it("says the four memories were read as v1, and the others as the release's body", async () => {
    const { names, result } = await runCheck();
    expect(names.map((n) => n.replace("-journal.md", ""))).toEqual(expected.investigations);
    expect(result.verdict).toBe(expected.verdict);
    expect(result.counts).toEqual(expected.fileCounts);

    const read = result.files.filter((f) => f.verdict !== "not-requested" && f.verdict !== "requested-no-body");
    expect(
      read.map((f) => ({ deployedPath: f.deployedPath, verdict: f.verdict, matchedVersions: f.matchedVersions.map((v) => v.version), counts: Object.fromEntries(Object.entries(f.counts).filter(([, n]) => n > 0)) })),
    ).toEqual(expected.filesRead);
    // The older bodies come first, each naming v1.
    expect(result.files.slice(0, 4).every((f) => f.verdict === "older-body" && f.matchedVersions.map((v) => v.version).join() === "1")).toBe(true);
    expect(result.stores).toEqual(expected.stores);
  });

  it("reads roles/on-call-routing as the release's body and no memory as anything else", async () => {
    const { result } = await runCheck();
    const memories = result.files.filter((f) => f.assetType === "memory" && f.verdict !== "not-requested");
    expect(memories.filter((f) => f.verdict === "older-body").map((f) => f.assetName).sort()).toEqual([
      "change-feed-windows",
      "log-query-limits",
      "patterns/cache-evictions",
      "services/seat-map-service",
    ]);
    expect(memories.filter((f) => f.verdict === "release-body").map((f) => f.assetName)).toEqual(["roles/on-call-routing"]);
    expect(memories.some((f) => f.verdict === "other-body" || f.verdict === "near-release" || f.verdict === "requested-no-body")).toBe(false);
  });
});
