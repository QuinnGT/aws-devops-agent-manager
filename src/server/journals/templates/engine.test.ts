import { describe, expect, it } from "vitest";
import { compileTemplate, lookup, pythonDatetime, pythonJsonDumps, renderString, renderTemplate, TemplateError } from "./engine";
import { normalizeTemplateSource } from "./load";

describe("template engine", () => {
  it("replaces placeholders with own properties only", () => {
    const t = compileTemplate("A {{x}} B {{y.z}} C {{missing.path}} D", "t");
    expect(renderTemplate(t, { x: "one", y: { z: 2 } })).toBe("A one B 2 C  D");
  });

  it("never reaches prototypes, constructors or functions", () => {
    expect(() => compileTemplate("{{constructor.constructor}}", "t")).toThrow(TemplateError);
    expect(() => compileTemplate("{{a.__proto__}}", "t")).toThrow(TemplateError);
    expect(lookup({}, ["toString"])).toBeUndefined();
    expect(lookup({ f: () => "x" }, ["f"])).toBeUndefined();
    expect(renderString("{{x.length}}", { x: "abc" })).toBe("");
  });

  it("rejects unknown filters, expressions and bad arguments at compile time", () => {
    expect(() => compileTemplate("{{x|exec}}", "t")).toThrow(/unknown filter/);
    expect(() => compileTemplate("{{x + 1}}", "t")).toThrow(/invalid placeholder/);
    expect(() => compileTemplate("{{x|truncate}}", "t")).toThrow(/positive whole number/);
    expect(() => compileTemplate("{{x|json:2}}", "t")).toThrow(/takes no argument/);
  });

  it("renders values and filters", () => {
    const ctx = { o: { a: "é", b: [1] }, s: "héllo😀", d: new Date("2026-10-12T18:36:05.759Z"), n: 3, parts: [{ text: "a" }, { text: "b" }, { image: 1 }] };
    expect(renderString("{{o}}", ctx)).toBe('{\n  "a": "é",\n  "b": [\n    1\n  ]\n}');
    expect(renderString("{{o|json-ascii}}", ctx)).toBe('{\n  "a": "\\u00e9",\n  "b": [\n    1\n  ]\n}');
    expect(renderString("{{s|length}}", ctx)).toBe("6");
    expect(renderString("{{d|python-datetime}}", ctx)).toBe("2026-10-12 18:36:05.759000+00:00");
    expect(renderString("{{d}}", ctx)).toBe("2026-10-12T18:36:05.759Z");
    expect(renderString("{{n|hashes}} T", ctx)).toBe("### T");
    expect(renderString("{{parts|join-text}}", ctx)).toBe("ab");
    expect(renderString("{{s|truncate:2}}", ctx, { truncationNotice: "…({{total}})" })).toBe("hé…(6)");
    expect(renderString("{{s|truncate:20}}", ctx, { truncationNotice: "…" })).toBe("héllo😀");
  });

  it("writes Python datetimes without a fraction when milliseconds are zero", () => {
    expect(pythonDatetime(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02 03:04:05+00:00");
    expect(pythonDatetime(new Date("2026-01-02T03:04:05.007Z"))).toBe("2026-01-02 03:04:05.007000+00:00");
  });

  it("matches Python json.dumps(indent=2) escaping", () => {
    expect(pythonJsonDumps({ t: "a\u2014b\u007f😀" })).toBe('{\n  "t": "a\\u2014b\\u007f\\ud83d\\ude00"\n}');
    expect(pythonJsonDumps({})).toBe("{}");
    expect(pythonJsonDumps(undefined)).toBe("null");
  });

  it("drops only the file's final newline and normalizes CRLF", () => {
    expect(normalizeTemplateSource("a\r\nb\n")).toBe("a\nb");
    expect(normalizeTemplateSource("a\n\n")).toBe("a\n");
    expect(normalizeTemplateSource("a")).toBe("a");
  });
});
