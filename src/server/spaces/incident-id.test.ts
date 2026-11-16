import { describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { compileIncidentRegex, extractIncidentId, incidentFieldValue, MAX_INCIDENT_FIELD_LENGTH } from "./incident-id";

describe("extractIncidentId", () => {
  it("returns null without a rule", () => {
    expect(extractIncidentId(null, { title: "INC-1" })).toBeNull();
    expect(extractIncidentId(undefined, { title: "INC-1" })).toBeNull();
  });

  it("reads the title with the first capture group", () => {
    const rule = { regex: "\\[(INC-\\d+)\\]", field: "title" as const };
    expect(extractIncidentId(rule, { title: "[INC-4821] Checkout latency in us-west-2" })).toBe("INC-4821");
    expect(extractIncidentId(rule, { title: "No incident here" })).toBeNull();
    expect(extractIncidentId(rule, { title: null })).toBeNull();
  });

  it("prefers the named group id over earlier groups", () => {
    const rule = { regex: "(SEV\\d) (?<id>[A-Z]+-\\d+)", field: "title" as const };
    expect(extractIncidentId(rule, { title: "SEV2 OPS-77 database failover" })).toBe("OPS-77");
  });

  it("uses the whole match when the pattern has no groups", () => {
    expect(extractIncidentId({ regex: "INC\\d{6}", field: "title" }, { title: "Alarm INC000123 fired" })).toBe("INC000123");
  });

  it("returns null when the chosen group did not take part in the match", () => {
    expect(extractIncidentId({ regex: "alarm(?: (INC-\\d+))?", field: "title" }, { title: "alarm fired" })).toBeNull();
  });

  it("reads the description", () => {
    const rule = { regex: "ticket (\\d+)", field: "description" as const };
    expect(extractIncidentId(rule, { title: "ticket 1", description: "Opened from ticket 99821" })).toBe("99821");
  });

  it("reads reference.referenceId from an object or a JSON string", () => {
    const rule = { regex: "^(?<id>.+)$", field: "reference.referenceId" as const };
    const reference = { system: "PagerDuty", referenceId: "Q1W2E3", referenceUrl: "https://example.invalid/x", associationId: "a" };
    expect(extractIncidentId(rule, { reference })).toBe("Q1W2E3");
    expect(extractIncidentId(rule, { reference: JSON.stringify(reference) })).toBe("Q1W2E3");
    expect(extractIncidentId(rule, { reference: null })).toBeNull();
    expect(extractIncidentId(rule, { reference: "not json" })).toBeNull();
  });

  it("reads reference.title", () => {
    const rule = { regex: "#(\\d+)", field: "reference.title" as const };
    expect(extractIncidentId(rule, { reference: { title: "Incident #512: API errors" } })).toBe("512");
  });

  it("returns null for an invalid pattern instead of throwing", () => {
    expect(extractIncidentId({ regex: "(unclosed", field: "title" }, { title: "(unclosed" })).toBeNull();
  });

  it("works on a real backlog task from the test space", () => {
    const { response } = apiFixture<{ task: { title: string; description: string } }>("GetBacklogTask");
    const rule = { regex: "^(?<id>[a-z-]+):", field: "description" as const };
    expect(extractIncidentId(rule, response.task)).toBe("chat-tool-use-best-practices");
  });

  it("only searches the first part of a very long field", () => {
    const title = `${"x".repeat(MAX_INCIDENT_FIELD_LENGTH)}INC-1`;
    expect(incidentFieldValue("title", { title })).toHaveLength(MAX_INCIDENT_FIELD_LENGTH);
    expect(extractIncidentId({ regex: "(INC-\\d)", field: "title" }, { title })).toBeNull();
  });
});

describe("compileIncidentRegex", () => {
  it("explains invalid or empty patterns", () => {
    expect(compileIncidentRegex("").ok).toBe(false);
    expect(compileIncidentRegex("[").ok).toBe(false);
    expect(compileIncidentRegex("x".repeat(501)).ok).toBe(false);
    expect(compileIncidentRegex("(INC-\\d+)").ok).toBe(true);
  });
});
