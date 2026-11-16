import { describe, expect, it } from "vitest";
import type { AssetJson } from "@/lib/assets/types";
import { diffAssetVersions, diffRecords, diffText, type VersionContent, type VersionFile } from "./diff";

function assetJson(over: Partial<AssetJson> = {}): AssetJson {
  return {
    assetId: "ki-x",
    assetType: "memory",
    metadata: { name: "overview", status: "ACTIVE" },
    serviceVersion: 24,
    serviceCreatedAt: "2026-08-13T18:37:05.000Z",
    serviceUpdatedAt: "2026-11-07T18:33:31.000Z",
    files: [],
    ...over,
  };
}

function file(path: string, content: string | null, over: Partial<VersionFile> = {}): VersionFile {
  return { path, sha256: content === null ? "h" : `sha-${content}`, size: content?.length ?? 0, committed: true, content, ...over };
}

function version(json: AssetJson, files: VersionFile[]): VersionContent {
  return { assetJson: json, files };
}

describe("diffRecords", () => {
  it("lists added, removed and changed keys, comparing nested values by content", () => {
    const changes = diffRecords({ a: 1, b: [1, 2], c: { x: 1, y: 2 }, gone: "x" }, { a: 2, b: [1, 2], c: { y: 2, x: 1 }, added: true });
    expect(changes).toEqual([
      { key: "a", kind: "changed", before: 1, after: 2 },
      { key: "added", kind: "added", after: true },
      { key: "gone", kind: "removed", before: "x" },
    ]);
  });
});

describe("diffText", () => {
  it("returns hunks with added, removed and context lines", () => {
    const hunks = diffText("a\nb\nc\n", "a\nB\nc\nd\n", { context: 1 })!;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "ctx", text: "c" },
      { kind: "add", text: "d" },
    ]);
  });

  it("marks a missing final newline", () => {
    const hunks = diffText("a", "a\n")!;
    expect(hunks[0]!.lines.some((l) => l.kind === "meta")).toBe(true);
  });
});

describe("diffAssetVersions", () => {
  it("shows a status-only change (the Active switch) as metadata and timestamp, with no file changes", () => {
    const md = "Version 24 body\n";
    const before = version(assetJson(), [file("overview.md", md)]);
    const after = version(assetJson({ metadata: { name: "overview", status: "INACTIVE" }, serviceUpdatedAt: "2026-11-10T23:30:02.000Z" }), [file("overview.md", md)]);
    const d = diffAssetVersions(before, after);
    expect(d.identical).toBe(false);
    expect(d.metadata).toEqual([{ key: "status", kind: "changed", before: "ACTIVE", after: "INACTIVE" }]);
    expect(d.fields).toEqual([{ key: "serviceUpdatedAt", kind: "changed", before: "2026-11-07T18:33:31.000Z", after: "2026-11-10T23:30:02.000Z" }]);
    expect(d.files.map((f) => f.status)).toEqual(["unchanged"]);
  });

  it("diffs content, and lists added and removed files", () => {
    const before = version(assetJson({ serviceVersion: 13 }), [file("SKILL.md", "one\ntwo\n"), file("references/old.md", "old\n")]);
    const after = version(assetJson({ serviceVersion: 14 }), [file("SKILL.md", "one\nthree\n"), file("references/new.md", "new\n")]);
    const d = diffAssetVersions(before, after);
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath["SKILL.md"]).toMatchObject({ status: "modified", added: 1, removed: 1 });
    expect(byPath["references/new.md"]).toMatchObject({ status: "added", added: 1, removed: 0 });
    expect(byPath["references/old.md"]).toMatchObject({ status: "removed", added: 0, removed: 1 });
    expect(d.fields).toEqual([{ key: "serviceVersion", kind: "changed", before: 13, after: 14 }]);
  });

  it("does not line-diff files that git doesn't hold or that are binary or too large", () => {
    const before = version(assetJson(), [
      file("big.bin", null, { committed: false, sha256: "a" }),
      file("img.png", "\u0000PNG", { sha256: "b1" }),
      file("large.md", "x".repeat(50), { sha256: "c1" }),
    ]);
    const after = version(assetJson(), [
      file("big.bin", null, { committed: false, sha256: "a2" }),
      file("img.png", "\u0000PNG2", { sha256: "b2" }),
      file("large.md", "y".repeat(50), { sha256: "c2" }),
    ]);
    const d = diffAssetVersions(before, after, { maxFileBytes: 10 });
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(byPath["big.bin"]).toMatchObject({ status: "not-comparable", reason: expect.stringMatching(/threshold/) });
    expect(byPath["img.png"]).toMatchObject({ status: "not-comparable", reason: "Binary content" });
    expect(byPath["large.md"]).toMatchObject({ status: "not-comparable", reason: expect.stringMatching(/Too large/) });
  });

  it("treats equal hashes as unchanged and reports identical versions", () => {
    const v = version(assetJson(), [file("a.md", "same\n")]);
    expect(diffAssetVersions(v, v).identical).toBe(true);
  });

  it("handles a version with no asset.json (deleted) as all removed", () => {
    const d = diffAssetVersions(version(assetJson(), [file("a.md", "x\n")]), { assetJson: null, files: [] });
    expect(d.files[0]!.status).toBe("removed");
    expect(d.metadata.map((m) => m.kind)).toEqual(["removed", "removed"]);
  });
});
