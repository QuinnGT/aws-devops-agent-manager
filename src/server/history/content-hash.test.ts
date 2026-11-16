import { describe, expect, it } from "vitest";
import { assetContentHash, metadataHash } from "./content-hash";

describe("assetContentHash", () => {
  it("ignores file order", () => {
    const a = [
      { path: "SKILL.md", sha256: "aa" },
      { path: "references/x.md", sha256: "bb" },
    ];
    expect(assetContentHash(a)).toBe(assetContentHash([...a].reverse()));
  });

  it("changes when a path or hash changes", () => {
    const base = assetContentHash([{ path: "AGENTS.md", sha256: "aa" }]);
    expect(assetContentHash([{ path: "AGENTS.md", sha256: "ab" }])).not.toBe(base);
    expect(assetContentHash([{ path: "agents.md", sha256: "aa" }])).not.toBe(base);
  });
});

describe("metadataHash", () => {
  it("ignores key order at every level", () => {
    expect(metadataHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(metadataHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
  });

  it("keeps array order", () => {
    expect(metadataHash({ agent_types: ["A", "B"] })).not.toBe(metadataHash({ agent_types: ["B", "A"] }));
  });
});
