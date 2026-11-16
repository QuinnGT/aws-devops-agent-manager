import { describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { displayValues, splitFrontmatter } from "./frontmatter";

describe("splitFrontmatter", () => {
  it("parses SKILL.md frontmatter from the test space", () => {
    const text = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.skill").response.file.content.text;
    const fm = splitFrontmatter(text);
    expect(fm.error).toBeNull();
    expect(fm.data?.name).toBe("chat-tool-use-best-practices");
    expect(Array.isArray(fm.data?.claim)).toBe(true);
    expect(fm.body.startsWith("<!-- Generated")).toBe(true);
  });

  it("returns the whole text when there is no frontmatter", () => {
    const fm = splitFrontmatter("# Title\n---\nnot frontmatter\n");
    expect(fm.data).toBeNull();
    expect(fm.raw).toBeNull();
    expect(fm.body).toBe("# Title\n---\nnot frontmatter\n");
  });

  it("handles CRLF, a BOM and an empty block", () => {
    expect(splitFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nbody").data).toEqual({ name: "x" });
    expect(splitFrontmatter("---\n---\nbody")).toMatchObject({ data: {}, body: "body" });
  });

  it("reports invalid YAML and non-mapping frontmatter", () => {
    expect(splitFrontmatter("---\nname: [unclosed\n---\n").error).toBeTruthy();
    expect(splitFrontmatter("---\n- a\n- b\n---\n").error).toMatch(/mapping/);
  });

  it("leaves an unclosed fence as body", () => {
    expect(splitFrontmatter("---\nname: x\nno close").data).toBeNull();
  });
});

describe("displayValues", () => {
  it("flattens lists and stringifies scalars and objects", () => {
    expect(displayValues(["a", ["b"], 3, true])).toEqual(["a", "b", "3", "true"]);
    expect(displayValues({ k: 1 })).toEqual(['{"k":1}']);
    expect(displayValues(null)).toEqual([]);
    expect(displayValues("")).toEqual([]);
  });
});
