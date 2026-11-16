import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkExpected } from "../../../test/helpers/fixtures";
import { checkCitations, collectCitations, normalizeForQuote, quoteInText } from "./citations";
import { recordText } from "./records";
import { benchmarkBundle, benchmarkDirs, syntheticBundle, validBenchmarkOutput } from "./test-support";

const bundle = syntheticBundle([
  { text: "Investigate: orders not received by fulfillment-worker" },
  { text: "Checking  Consumer\nlag for fulfillment-worker on order-events" },
  { type: "investigation_summary_md", text: "Root cause: a **timing race** between the batch job and the stream." },
  { type: "finding", text: '{\n  "title": "Lag on \\"order\\" topic"\n}' },
]);

describe("collectCitations", () => {
  it("finds record objects, *_record fields and R<n> mentions, with JSON paths", () => {
    const found = collectCitations({
      near_miss: "It listed a rebalance (R2) and then dropped it (R3, R2).",
      scored_summary_record: 3,
      other_record: "not an integer",
      fixes: [{ fix: "Add memory (R1)", evidence: [{ record: 2, quote: "consumer lag" }, { record: 3, quote: null }] }],
      citations: [{ record: 3, quote: "said R9 in passing", supports: "near_miss" }],
      summaries: [{ record: 3, utc: "", conclusion: "Timing race (R3)." }],
      nested: { deep: ["R4", "IR5 is not a mention", "R6x neither"] },
    });
    expect(found).toEqual([
      { record: 2, quote: null, field: "near_miss" },
      { record: 3, quote: null, field: "near_miss" },
      { record: 3, quote: null, field: "scored_summary_record" },
      { record: 1, quote: null, field: "fixes[0].fix" },
      { record: 2, quote: "consumer lag", field: "fixes[0].evidence[0]" },
      { record: 3, quote: null, field: "fixes[0].evidence[1]" },
      { record: 3, quote: "said R9 in passing", field: "citations[0]", supports: "near_miss" },
      { record: 3, quote: null, field: "summaries[0]" },
      { record: 3, quote: null, field: "summaries[0].conclusion" },
      { record: 4, quote: null, field: "nested.deep[0]" },
    ]);
  });

  it("returns nothing for output without citations", () => {
    expect(collectCitations(null)).toEqual([]);
    expect(collectCitations({ a: 1, b: ["x"] })).toEqual([]);
  });
});

describe("quote matching", () => {
  it("normalizes whitespace, case, Unicode quotes and dashes", () => {
    expect(normalizeForQuote("  A\u00a0“B”\n\t‘c’ — d …")).toBe("a \"b\" 'c' - d ...");
    expect(quoteInText("checking consumer lag", "Checking  Consumer\nlag")).toBe(true);
    expect(quoteInText("“checking consumer lag”", "Checking  Consumer\nlag")).toBe(true);
  });

  it("treats ... and … as gaps that must appear in order", () => {
    const t = "Root cause: a timing race between the batch job and the stream.";
    expect(quoteInText("root cause ... the stream", t)).toBe(true);
    expect(quoteInText("root cause… batch job", t)).toBe(true);
    expect(quoteInText("the stream ... root cause", t)).toBe(false);
  });

  it("accepts quotes without markdown emphasis or JSON escapes", () => {
    expect(quoteInText("a timing race between", "a **timing race** between")).toBe(true);
    expect(quoteInText('Lag on "order" topic', '"title": "Lag on \\"order\\" topic"')).toBe(true);
    expect(quoteInText("a timing crash", "a **timing race** between")).toBe(false);
  });

  it("matches a quote that differs from the record only by its dashes", () => {
    // The record's table row, as the condensed trace has it: an en dash in the range, an em dash for an empty cell.
    const row = '| `checkout-api` "Exception" | steady ~1,100\u20131,880/min (tracks traffic) | \u2014 | FLAT, pre-existing |';
    expect(quoteInText("~1,100-1,880/min ... FLAT, pre-existing", row)).toBe(true);
    expect(quoteInText("steady ~1,100\u20141,880/min (tracks traffic) | - | flat", row)).toBe(true);
    expect(quoteInText("~1,100\u22121,880/min", row)).toBe(true);
    // A quote that is not in the record must keep failing.
    expect(quoteInText("the seat-hold cluster timed out on every read", row)).toBe(false);
  });
});

describe("checkCitations", () => {
  it("passes valid citations and flags missing records and quotes", () => {
    const check = checkCitations(
      {
        a: "Seen in R2 and R9.",
        citations: [
          { record: 2, quote: "consumer lag for fulfillment-worker", supports: "a" },
          { record: 3, quote: "timing race ... the stream", supports: "a" },
          { record: 1, quote: "this text is not in the record", supports: "a" },
          { record: 0, quote: null, supports: "a" },
        ],
      },
      bundle,
    );
    expect(check.checked).toBe(6);
    expect(check.failed).toBe(3);
    expect(check.ok).toBe(false);
    expect(check.citations.filter((c) => !c.ok)).toEqual([
      { record: 9, quote: null, field: "a", ok: false, problem: "missing-record" },
      { record: 1, quote: "this text is not in the record", field: "citations[2]", supports: "a", ok: false, problem: "quote-not-found" },
      { record: 0, quote: null, field: "citations[3]", supports: "a", ok: false, problem: "missing-record" },
    ]);
  });

  it("passes the synthetic benchmark output", () => {
    const b = syntheticBundle([{ text: "start" }, { text: "no consumer lag query" }, { text: "a timing race" }]);
    const check = checkCitations(validBenchmarkOutput(), b);
    expect(check.failed).toBe(0);
    expect(check.ok).toBe(true);
    expect(check.citations.map((c) => c.field)).toContain("fixes[0].evidence[0]");
  });
});

const dirs = benchmarkDirs();

describe("citation check on the benchmark reference reviews", () => {
  const reviews = readdirSync(dirs.reviews).filter((f) => /^INCIDENT-\d+\.json$/.test(f)).sort();
  const expected = benchmarkExpected();

  it("covers every review", () => {
    expect(reviews.length).toBeGreaterThan(0);
    if (expected) expect(reviews).toEqual(expected.incidentIds.map((i) => `${i}.json`));
  });

  it.each(reviews)("%s: every cited record exists in the imported journal", (file) => {
    const incident = file.replace(/\.json$/, "");
    const review = JSON.parse(readFileSync(path.join(dirs.reviews, file), "utf8")) as unknown;
    const b = benchmarkBundle(dirs.incidents, incident);
    const check = checkCitations(review, b);
    const mentions = new Set<string>();
    const walk = (v: unknown, p: string) => {
      if (typeof v === "string") for (const m of v.matchAll(/\bR(\d+)\b/g)) mentions.add(`${p}\0${m[1]}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    };
    walk(review, "");
    expect(check.checked).toBe(mentions.size);
    expect(check.checked).toBeGreaterThan(0);
    if (expected) expect(check.checked).toBe(expected.reviews[incident]!.citationsChecked);
    expect(check.citations.filter((c) => !c.ok)).toEqual([]);
    // Record numbers in the reference reviews are the export's record numbers, which equal NormRecord.n
    expect(b.records.every((r) => r.sourceNumber === r.n)).toBe(true);
  });

  it.each(reviews.slice(0, 5))("%s: quotes taken from records pass, altered quotes fail", (file) => {
    const b = benchmarkBundle(dirs.incidents, file.replace(/\.json$/, ""));
    const picks = b.records.filter((r) => recordText(r).replace(/\s+/g, " ").trim().length > 200).slice(0, 10);
    expect(picks.length).toBeGreaterThan(0);
    for (const r of picks) {
      const flat = recordText(r).replace(/\s+/g, " ").trim();
      const a = flat.slice(20, 80);
      const c = flat.slice(120, 180);
      const ok = checkCitations({ citations: [{ record: r.n, quote: `${a.toUpperCase()} ... ${c}`, supports: "x" }] }, b);
      expect(ok.ok, `R${r.n}`).toBe(true);
      const wrong = checkCitations({ citations: [{ record: r.n, quote: `${a} zzqx-not-in-record`, supports: "x" }] }, b);
      expect(wrong.citations[0]!.problem).toBe("quote-not-found");
    }
  });
});
