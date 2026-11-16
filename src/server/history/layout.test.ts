import { describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { getAppPolicy } from "@/server/policy";
import { assetDir, assetDisplayName, releaseTagName, safeSegment } from "./layout";

const layout = getAppPolicy().policy.historyLayout;

describe("history layout", () => {
  it("places each asset type per the layout policy", () => {
    const md = apiFixture<{ asset: { assetId: string; assetType: string; metadata: Record<string, unknown> } }>("GetAsset.agents_md").response.asset;
    expect(assetDir(layout, "test-space", md)).toBe("spaces/test-space/agents_md/GENERIC");

    const mem = apiFixture<{ asset: { assetId: string; assetType: string; metadata: Record<string, unknown> } }>("GetAsset.memory").response.asset;
    expect(assetDir(layout, "test-space", { ...mem, storeName: "chat-tool-use-best-practices" })).toBe(
      "spaces/test-space/memory/chat-tool-use-best-practices/overview",
    );
    expect(assetDir(layout, "t", { assetId: "ki-1", assetType: "memory", metadata: { name: "databases/rds-failover" }, storeName: "ops" })).toBe(
      "spaces/t/memory/ops/databases/rds-failover",
    );
  });

  it("falls back to the asset ID for unknown types and missing names", () => {
    expect(assetDir(layout, "t", { assetId: "ki-9", assetType: "artifact", metadata: {} })).toBe("spaces/t/artifact/ki-9");
    expect(assetDisplayName(layout, { assetId: "ki-9", assetType: "skill", metadata: {} })).toBe("ki-9");
  });

  it("never produces path traversal", () => {
    expect(safeSegment("..")).toBe("_");
    expect(assetDir(layout, "t", { assetId: "ki-1", assetType: "skill", metadata: { name: "../../etc" } })).not.toContain("..");
    expect(releaseTagName(layout, "anycompany", "v2.3")).toBe("anycompany/v2.3");
  });
});
