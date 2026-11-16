import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { countLines, formatBytes, measureInstructions } from "./size-meter";

const limits = { agentsMdMaxBytes: 100, agentsMdRecommendedLines: 3 };

describe("measureInstructions", () => {
  it("counts lines the way an editor does", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\n\n")).toBe(2);
  });

  it("is ok at exactly the byte limit and the recommended lines", () => {
    const exact = `${"x".repeat(96)}\na\nb`;
    expect(Buffer.byteLength(exact)).toBe(100);
    const m = measureInstructions(exact, limits);
    expect(m.lines).toBe(3);
    expect(m.overLimit).toBe(false);
    expect(m.overRecommendedLines).toBe(false);
    expect(m.level).toBe("ok");
    expect(m.fraction).toBe(1);
  });

  it("warns one line above the recommended length", () => {
    const m = measureInstructions("1\n2\n3\n4\n", limits);
    expect(m.lines).toBe(4);
    expect(m.level).toBe("warning");
    expect(m.overLimit).toBe(false);
  });

  it("errors one byte above the limit, counting UTF-8 bytes", () => {
    const m = measureInstructions("é".repeat(50) + "x", limits); // 101 bytes, 51 characters
    expect(m.bytes).toBe(101);
    expect(m.overLimit).toBe(true);
    expect(m.level).toBe("error");
    expect(m.fraction).toBeCloseTo(1.01);
  });

  it("measures the test space's GENERIC instructions against policy limits", () => {
    const policy = getAppPolicy().policy.limits;
    expect(policy.agentsMdMaxBytes).toBe(25600);
    expect(policy.agentsMdRecommendedLines).toBe(120);
    const text = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.agents_md").response.file.content.text;
    const m = measureInstructions(text, policy);
    expect(m.bytes).toBe(Buffer.byteLength(text));
    expect(m.lines).toBe(countLines(text));
    expect(m.level).toBe(m.bytes > 25600 ? "error" : m.lines > 120 ? "warning" : "ok");
  });

  it("formats sizes in KB as the guide does", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(25600)).toBe("25.0 KB");
    expect(formatBytes(6 * 1024 * 1024)).toBe("6.0 MB");
  });
});
