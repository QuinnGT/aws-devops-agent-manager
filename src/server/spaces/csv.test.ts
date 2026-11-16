import { describe, expect, it } from "vitest";
import { csvLine, escapeCsvCell } from "./csv";

describe("escapeCsvCell", () => {
  it("quotes every cell and doubles quotes", () => {
    expect(escapeCsvCell("plain")).toBe('"plain"');
    expect(escapeCsvCell('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"');
  });

  it.each(["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tx", "\rx", '=HYPERLINK("http://evil.invalid")'])(
    "neutralizes formula-looking cell %j",
    (v) => {
      const out = escapeCsvCell(v);
      expect(out.startsWith(`"'`)).toBe(true);
      expect(out.slice(2, -1).replace(/""/g, '"')).toBe(v);
    },
  );

  it("leaves cells that only contain those characters later", () => {
    expect(escapeCsvCell("a=b")).toBe('"a=b"');
    expect(escapeCsvCell("user@example.com")).toBe('"user@example.com"');
  });

  it("formats null, numbers, dates and objects", () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
    expect(escapeCsvCell(42)).toBe('"42"');
    expect(escapeCsvCell(-1)).toBe(`"'-1"`);
    expect(escapeCsvCell(new Date("2026-11-11T00:00:00.000Z"))).toBe('"2026-11-11T00:00:00.000Z"');
    expect(escapeCsvCell({ a: "=x" })).toBe('"{""a"":""=x""}"');
  });
});

describe("csvLine", () => {
  it("joins cells and ends with CRLF", () => {
    expect(csvLine(["a", 1, null])).toBe('"a","1",""\r\n');
  });
});
