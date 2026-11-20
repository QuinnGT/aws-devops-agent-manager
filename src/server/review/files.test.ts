import { describe, expect, it } from "vitest";
import { checkCitations } from "./citations";
import { recordsMarkdown, reviewFiles } from "./files";
import { prepareReview } from "./prompt";
import { reviewSettings } from "./settings";
import { benchmarkProfile, runInput, syntheticBundle } from "./test-support";

const bundle = syntheticBundle([
  { text: "Orders are delayed in eu-west-1. Investigate." },
  { text: "Checking the consumer lag.", toolUses: [{ name: "logs_query", input: { q: "lag" } }] },
  { type: "message", role: "user", text: "", toolResults: ["consumer group orders-v2 rebalanced 14 times between 07:50 and 08:10"] },
  { type: "finding", text: "The consumer group rebalanced on every scale event." },
]);
const settings = reviewSettings(benchmarkProfile());

describe("reviewFiles", () => {
  it("fills the brief in files mode: records.md instead of tools", () => {
    const f = reviewFiles(runInput(bundle), settings);
    expect(f.brief).toContain("records.md");
    expect(f.brief).not.toContain("through your tools");
    expect(f.brief).not.toContain("{{");
    expect(f.system).toContain("records.md");
    expect(f.system).not.toContain("search_records");
    expect(JSON.parse(f.schema).type).toBe("object");
    expect(f.schema).not.toContain('"$schema"');
  });

  it("keeps the tools wording for the Bedrock review", () => {
    const p = prepareReview(runInput(bundle), settings);
    expect(p.prompt).toContain("available through your tools");
    expect(p.prompt).toContain(`${settings.stepLimit} steps`);
    expect(p.system).toContain("search_records");
  });

  it("writes every record under its heading, so a quote copied from records.md passes the citation check", () => {
    const { text, cut } = recordsMarkdown(bundle, 20_000);
    expect(cut).toBe(0);
    expect(text).toMatch(/^## R1 MESSAGE /);
    expect(text).toContain("## R4 FINDING ");
    const r3 = text.slice(text.indexOf("## R3 "), text.indexOf("## R4 "));
    const quote = r3.match(/rebalanced 14 times between 07:50/)![0];
    const check = checkCitations({ citations: [{ record: 3, quote, supports: "x" }] }, bundle);
    expect(check.ok).toBe(true);
  });

  it("cuts a long record with a note, and a quote from the part shown still passes", () => {
    const long = syntheticBundle([{ text: `start of a long record ${"x".repeat(500)} end` }]);
    const { text, cut } = recordsMarkdown(long, 100);
    expect(cut).toBe(1);
    expect(text).toContain("[Cut by the app: ");
    expect(text).not.toContain(" end");
    expect(checkCitations({ citations: [{ record: 1, quote: "start of a long record" }] }, long).ok).toBe(true);
  });
});
