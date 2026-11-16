import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnifiedDiff } from "@/components/plans/unified-diff";
import { SafeMarkdown } from "@/components/safe-markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { diffText } from "@/server/assets/diff";
import type { AssetListRow } from "@/server/assets/browse";
import { buildPathTree } from "@/server/assets/tree";
import { treeItems } from "./asset-table";
import { ASSET_ID_LABEL, CopyIdButton } from "./action-button";
import { FileDiffView, numberHunk, splitHunk } from "./diff-view";
import { assetTabHref, diffHref, historyHref, restoreConfirm } from "./format";

describe("diff line numbers and split rows", () => {
  const [hunk] = diffText("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n", { context: 3 })!;

  it("numbers old and new lines through a hunk", () => {
    expect(numberHunk(hunk!).map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["ctx", 1, 1, "a"],
      ["del", 2, null, "b"],
      ["add", null, 2, "B"],
      ["ctx", 3, 3, "c"],
      ["ctx", 4, 4, "d"],
      ["add", null, 5, "e"],
    ]);
  });

  it("pairs removed lines with the added lines after them", () => {
    expect(splitHunk(hunk!).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", "c"],
      ["d", "d"],
      [null, "e"],
    ]);
    const [h2] = diffText("x\ny\nz\n", "q\n", { context: 0 })!;
    expect(splitHunk(h2!).map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["x", "q"],
      ["y", null],
      ["z", null],
    ]);
  });
});

describe("asset links", () => {
  it("puts tabs and compare references in the asset page URL", () => {
    expect(assetTabHref("demo", "ki-1", "content")).toBe("/spaces/demo/assets/ki-1");
    expect(assetTabHref("demo", "ki-1", "content", { version: "3" })).toBe("/spaces/demo/assets/ki-1?version=3");
    expect(historyHref("demo", "ki-1")).toBe("/spaces/demo/assets/ki-1?tab=versions");
    expect(diffHref("demo space", "ki-1", "23", "24")).toBe("/spaces/demo%20space/assets/ki-1?tab=versions&from=23&to=24");
  });
});

describe("restore confirmation", () => {
  it("asks before creating the restore plan", () => {
    expect(restoreConfirm("overview", 13)).toEqual({ title: "Create a plan to restore overview to v13?", body: "Nothing changes in the space until the plan is applied.", label: "Create plan" });
  });
});

describe("memory rows", () => {
  const row = (assetId: string, name: string): AssetListRow => ({
    assetId,
    assetType: "memory",
    name,
    status: "ACTIVE",
    version: 1,
    updatedAt: null,
    deleted: false,
    managed: { managed: false },
    lastChange: null,
    parentAssetId: "s",
    metadata: {},
  });

  it("adds a folder row and indents what is inside it", () => {
    const items = treeItems(buildPathTree([row("1", "overview"), row("2", "categories/a"), row("3", "categories/b"), row("4", "db"), row("5", "db/x")], (r) => r.name), 1);
    expect(items.map((i) => [i.kind, i.depth, i.kind === "asset" ? i.label : i.key])).toEqual([
      ["group", 1, "f:categories"],
      ["asset", 2, "a"],
      ["asset", 2, "b"],
      ["asset", 1, "db"],
      ["asset", 2, "x"],
      ["asset", 1, "overview"],
    ]);
  });
});

describe("SafeMarkdown heading offset", () => {
  it("renders headings lower so asset content adds no h1, and keeps raw HTML out", () => {
    const html = renderToStaticMarkup(<SafeMarkdown headingOffset={2}>{"# Title\n\n## Part\n\n###### Deep\n\n<script>alert(1)</script>"}</SafeMarkdown>);
    expect(html).toContain("<h3>Title</h3>");
    expect(html).toContain("<h4>Part</h4>");
    expect(html).toContain("<h6>Deep</h6>");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<script");
    expect(renderToStaticMarkup(<SafeMarkdown>{"# Title"}</SafeMarkdown>)).toContain("<h1>Title</h1>");
  });
});

describe("long diff lines wrap (MASTER Diffs)", () => {
  const long = `${"word ".repeat(60)}${"x".repeat(200)}`;
  const [hunk] = diffText(`a\n${long}\n`, `a\n${long} more\n`, { context: 3 })!;
  const file = { path: "AGENTS.md", status: "modified" as const, beforeSha: null, afterSha: null, hunks: [hunk!], added: 1, removed: 1 };

  it("in Unified and Split, with a fixed table and no sideways scrolling", () => {
    for (const html of [renderToStaticMarkup(<FileDiffView file={file} />), renderToStaticMarkup(<FileDiffView file={file} layout="split" />), renderToStaticMarkup(<UnifiedDiff file={file} />)]) {
      expect(html).toContain("table-fixed");
      expect(html).toContain("whitespace-pre-wrap [overflow-wrap:anywhere]");
      expect(html).not.toMatch(/whitespace-pre[" ]/);
      expect(html).not.toContain("overflow-x-auto");
      expect(html).not.toContain("w-max");
    }
  });
});

describe("asset ID chip", () => {
  it("says what the ID is in its accessible name", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <CopyIdButton id="ki-8578b1bb-0000" short="ki-8578b1bb" />
      </TooltipProvider>,
    );
    expect(ASSET_ID_LABEL).toBe("Asset ID in the Agent Space");
    expect(html).toContain('aria-label="Asset ID in the Agent Space: ki-8578b1bb-0000. Copy"');
  });
});
