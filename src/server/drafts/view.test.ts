import { describe, expect, it } from "vitest";
import type { DesiredFile } from "@/server/packages/types";
import { desiredContentHash } from "@/server/plans/content";
import { changedParts, mergeFiles } from "./service";
import { alsoHasDraftNote, draftChange, orderDrafts } from "./view";

const file = (path: string, content: string): DesiredFile => ({ path, encoding: "utf8", content });
const base = { metadata: { name: "verity", status: "ACTIVE", description: "d" }, files: [file("SKILL.md", "a\n")] };

describe("draftChange", () => {
  const draft = (metadata: Record<string, unknown>, files: DesiredFile[]) => ({ desired: { metadata, files }, baseMetadata: base.metadata, baseContentHash: desiredContentHash(base.files) });

  it("tells content, status-only, metadata and no change apart", () => {
    expect(draftChange(draft(base.metadata, [file("SKILL.md", "b\n")])).kind).toBe("content");
    expect(draftChange(draft({ ...base.metadata, status: "INACTIVE" }, base.files))).toMatchObject({ kind: "status", status: "INACTIVE", metadataKeys: ["status"] });
    expect(draftChange(draft({ ...base.metadata, description: "e" }, base.files))).toMatchObject({ kind: "metadata", metadataKeys: ["description"] });
    expect(draftChange(draft({ ...base.metadata, status: "INACTIVE", description: "e" }, base.files)).kind).toBe("metadata");
    expect(draftChange(draft(base.metadata, base.files)).kind).toBe("none");
  });

  it("treats a draft without a base as a create", () => {
    expect(draftChange({ desired: base, baseMetadata: null, baseContentHash: null }).kind).toBe("create");
  });
});

describe("orderDrafts (pages/drafts.md row order)", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 12, 10, m));
  const rows = [
    { id: "o1", assetId: "a1", createdBy: "sam@x", planId: null, updatedAt: at(1) },
    { id: "p2", assetId: "a2", createdBy: "me@x", planId: "P", updatedAt: at(5) },
    { id: "m2", assetId: "a3", createdBy: "me@x", planId: null, updatedAt: at(9) },
    { id: "q1", assetId: "a4", createdBy: "sam@x", planId: "Q", updatedAt: at(2) },
    { id: "m1", assetId: "a5", createdBy: "ME@x", planId: null, updatedAt: at(3) },
    { id: "p1", assetId: "a6", createdBy: "me@x", planId: "P", updatedAt: at(4) },
  ];

  it("puts my free drafts first, then drafts by plan, then other people's, oldest first in each", () => {
    expect(orderDrafts(rows, "me@x").map((r) => r.id)).toEqual(["m1", "m2", "q1", "p1", "p2", "o1"]);
  });
});

describe("alsoHasDraftNote", () => {
  const rows = [
    { id: "mine", assetId: "g", createdBy: "me@x", planId: null, updatedAt: new Date() },
    { id: "sams", assetId: "g", createdBy: "sam@x", planId: "P", updatedAt: new Date() },
    { id: "alone", assetId: "h", createdBy: "me@x", planId: null, updatedAt: new Date() },
  ];
  const nameOf = (e: string) => (e === "sam@x" ? "Sam Lee" : e);

  it("names the other author, or tells me I have one too", () => {
    expect(alsoHasDraftNote(rows[0]!, rows, "me@x", nameOf)).toBe("Sam Lee also has a draft");
    expect(alsoHasDraftNote(rows[1]!, rows, "me@x", nameOf)).toBe("you also have a draft");
    expect(alsoHasDraftNote(rows[2]!, rows, "me@x", nameOf)).toBeNull();
  });
});

describe("saving changed files only", () => {
  it("merges changed files into the draft by path and keeps the rest", () => {
    const prev = [file("SKILL.md", "a"), file("references/x.md", "x")];
    expect(mergeFiles(prev, [file("SKILL.md", "b")])).toEqual([file("SKILL.md", "b"), file("references/x.md", "x")]);
    expect(mergeFiles(prev, [file("new.md", "n")]).map((f) => f.path)).toEqual(["SKILL.md", "references/x.md", "new.md"]);
  });

  it("lists the files and metadata keys a save changed, for the audit event", () => {
    expect(changedParts(base, { metadata: { ...base.metadata, status: "INACTIVE" }, files: [file("SKILL.md", "b\n"), file("r.md", "")] })).toEqual({ files: ["SKILL.md", "r.md"], metadataKeys: ["status"] });
    expect(changedParts(base, base)).toEqual({ files: [], metadataKeys: [] });
  });
});
