import { describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { buildPathTree, countItems, pathSegments } from "./tree";

type ListAssets = { items: { assetId: string; assetType: string; metadata: { name?: string; memory_store_id?: string } }[] };

describe("buildPathTree", () => {
  it("builds folders from memory names in the test space", () => {
    const items = apiFixture<ListAssets>("ListAssets.page1").response.items.filter(
      (a) => a.assetType === "memory" && a.metadata.memory_store_id === "ki-63edd778-1a7a-483f-8b18-479742a15a04",
    );
    const tree = buildPathTree(items, (a) => a.metadata.name ?? "");
    // Folders first, then leaves by name
    expect(tree.map((n) => n.name)).toEqual(["categories", "overview"]);
    const categories = tree[0]!;
    expect(categories.items).toHaveLength(0);
    expect(categories.children.map((c) => c.path)).toEqual([
      "categories/devops-agent-product-questions",
      "categories/privatelink-cross-region-setup",
      "categories/privatelink-facts-and-limits",
      "categories/testing-mcp-servers",
    ]);
    expect(countItems(tree)).toBe(items.length);
  });

  it("keeps a name that is both an item and a folder", () => {
    const tree = buildPathTree(["databases", "databases/rds-failover", "databases/aurora/limits"], (s) => s);
    expect(tree).toHaveLength(1);
    const db = tree[0]!;
    expect(db.items).toEqual(["databases"]);
    expect(db.children.map((c) => c.name)).toEqual(["aurora", "rds-failover"]);
    expect(db.children[0]!.children[0]!.items).toEqual(["databases/aurora/limits"]);
  });

  it("ignores empty segments and names empty paths", () => {
    expect(pathSegments("/a//b/ ")).toEqual(["a", "b"]);
    const tree = buildPathTree(["a//b", "", "a/b"], (s) => s);
    expect(tree.map((n) => n.name)).toEqual(["a", "(no name)"]);
    expect(tree[0]!.children[0]!.items).toEqual(["a//b", "a/b"]);
  });

  it("builds a skill file tree", () => {
    const files = apiFixture<{ items: { path: string }[] }>("ListAssetFiles.skill").response.items;
    const tree = buildPathTree(files, (f) => f.path);
    expect(tree.map((n) => n.name)).toEqual(["references", "SKILL.md"]);
    expect(tree[0]!.children).toHaveLength(4);
  });
});
