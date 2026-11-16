import { describe, expect, it } from "vitest";
import type { AssetJson, AssetSnapshot } from "@/lib/assets/types";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { authorFor, fallbackAttribution, principalSlug } from "./author";
import { buildAssetJson, canonicalize, changedMetadataKeys, fileBytes, fileSnapshot, isUtf8Text, safeAssetFilePath, sha256Hex } from "./content";
import { isDue } from "./schedule";

describe("file snapshots", () => {
  it("keeps UTF-8 text as text and binary as base64, with the hash of the raw bytes", () => {
    const text = fileSnapshot("SKILL.md", Buffer.from("héllo\n"), { maxCommittedFileBytes: 100, mimeType: "text/markdown" });
    expect(text).toMatchObject({ encoding: "utf8", content: "héllo\n", size: 7, sha256: sha256Hex(Buffer.from("héllo\n")), mimeType: "text/markdown" });
    const bin = fileSnapshot("x.bin", new Uint8Array([0, 255, 1]), { maxCommittedFileBytes: 100 });
    expect(bin).toMatchObject({ encoding: "base64", content: "AP8B", size: 3 });
    expect(fileBytes(bin)).toEqual(Buffer.from([0, 255, 1]));
    expect(isUtf8Text(new Uint8Array([0xc3]))).toBe(false);
  });

  it("drops content above the size threshold but keeps the hash and size", () => {
    const big = fileSnapshot("big.md", Buffer.alloc(11, 97), { maxCommittedFileBytes: 10 });
    expect(big.content).toBeUndefined();
    expect(big).toMatchObject({ size: 11, sha256: sha256Hex(Buffer.alloc(11, 97)) });
    expect(fileBytes(big)).toBeNull();
  });

  it("rejects unsafe file paths", () => {
    expect(safeAssetFilePath("references/a.md")).toBe("references/a.md");
    expect(safeAssetFilePath("./a//b.md")).toBe("a/b.md");
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "C:/x", ".git/config", "a/.GIT/hooks", "a\0b"]) expect(safeAssetFilePath(bad)).toBeNull();
  });
});

describe("asset.json", () => {
  it("sorts metadata keys and files, and records the committed flag", () => {
    const asset = apiFixture<{ asset: { assetId: string; assetType: string; metadata: Record<string, unknown> } }>("GetAsset.memory.oldVersion").response.asset;
    const snap: AssetSnapshot = {
      assetId: asset.assetId,
      assetType: asset.assetType,
      version: 1,
      createdAt: "2026-08-13T18:37:05.000Z",
      updatedAt: "2026-08-13T18:37:05.000Z",
      metadata: asset.metadata,
      files: [
        { path: "z.md", sha256: "b", size: 2, encoding: "utf8", content: "z\n" },
        { path: "a.md", sha256: "a", size: 2, encoding: "utf8" },
      ],
    };
    const previous: AssetJson = {
      assetId: asset.assetId,
      assetType: asset.assetType,
      metadata: {},
      serviceVersion: 0,
      serviceCreatedAt: "",
      serviceUpdatedAt: "",
      files: [{ path: "a.md", sha256: "a", size: 2, committed: false, mimeType: "text/markdown" }],
    };
    const json = buildAssetJson(snap, (f) => f.content !== undefined, previous);
    expect(Object.keys(json.metadata)).toEqual(["description", "memory_store_id", "name", "status"]);
    expect(json.files).toEqual([
      { path: "a.md", sha256: "a", size: 2, committed: false, mimeType: "text/markdown" },
      { path: "z.md", sha256: "b", size: 2, committed: true },
    ]);
    expect(json).toMatchObject({ assetId: asset.assetId, serviceVersion: 1, serviceCreatedAt: "2026-08-13T18:37:05.000Z" });
  });

  it("canonicalizes nested objects and lists changed keys", () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 2 } }))).toBe('{"a":{"c":2,"d":[{"x":2,"y":1}]},"b":1}');
    expect(changedMetadataKeys({ status: "ACTIVE", name: "x", tags: ["a"] }, { name: "x", status: "INACTIVE", tags: ["a"], extra: 1 })).toEqual(["extra", "status"]);
  });
});

describe("commit authors", () => {
  const domain = "devops-agent-manager.invalid";
  it("uses an email principal as is, and a synthetic email otherwise", () => {
    expect(authorFor({ source: "app", label: "DevOps Agent Manager", principal: "alex@example.com", cloudTrailEventId: null, planId: "p1", matchedBy: "clientToken" }, domain)).toEqual({
      name: "alex@example.com",
      email: "alex@example.com",
    });
    expect(
      authorFor({ source: "cli", label: "CLI or SDK", principal: "arn:aws:iam::111122223333:user/alice", cloudTrailEventId: "e", planId: null, matchedBy: "exact" }, domain),
    ).toEqual({ name: "arn:aws:iam::111122223333:user/alice", email: `arn-aws-iam-111122223333-user-alice@${domain}` });
    expect(authorFor({ source: "agent", label: "DevOps Agent (no API call recorded)", principal: null, cloudTrailEventId: null, planId: null, matchedBy: "none" }, domain)).toEqual({
      name: "DevOps Agent (no API call recorded)",
      email: `agent@${domain}`,
    });
  });

  it("labels failed attribution as unknown", () => {
    const a = fallbackAttribution(getAppPolicy().policy.attribution.labels, "error");
    expect(a).toEqual({ source: "unknown", label: "Unknown", principal: null, cloudTrailEventId: null, planId: null, matchedBy: "error" });
    expect(authorFor(a, domain)).toEqual({ name: "Unknown", email: `unknown@${domain}` });
  });

  it("keeps synthetic email local parts short and strips characters git rejects", () => {
    const long = `arn:aws:sts::111122223333:assumed-role/${"x".repeat(80)}/session`;
    const slug = principalSlug(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(/^[a-z0-9._+-]+$/);
    expect(authorFor({ source: "cli", label: "CLI", principal: "a <b>\nc", cloudTrailEventId: null, planId: null, matchedBy: "exact" }, domain).name).toBe("a bc");
  });
});

describe("sync policy and scheduling", () => {
  it("loads the sync policy with its defaults", () => {
    const sync = getAppPolicy().policy.sync;
    expect(sync).toMatchObject({ intervalMinutes: 15, reconcileCron: "17 3 * * *", tickCron: "* * * * *", defaultStoreCommitPolicy: "every-version", batchSize: 100 });
    expect(sync.committer).toEqual({ name: "DevOps Agent Manager sync", email: "sync@devops-agent-manager.invalid" });
    expect(sync.commitMessages.metadata).toContain("{name}");
  });

  it("is due once the interval has passed since the later of enqueue and start", () => {
    const now = new Date("2026-11-11T12:15:00Z");
    expect(isDue(now, { intervalMinutes: 15, lastEnqueuedAt: null, lastSyncStartedAt: null })).toBe(true);
    expect(isDue(now, { intervalMinutes: 15, lastEnqueuedAt: new Date("2026-11-11T12:00:00Z"), lastSyncStartedAt: null })).toBe(true);
    expect(isDue(now, { intervalMinutes: 15, lastEnqueuedAt: new Date("2026-11-11T12:00:00Z"), lastSyncStartedAt: new Date("2026-11-11T12:01:00Z") })).toBe(false);
  });
});
