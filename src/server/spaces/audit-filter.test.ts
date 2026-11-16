import { describe, expect, it } from "vitest";
import { AUDIT_MAX_ROWS, AUDIT_PAGE_SIZE, auditFilterQuery, auditFilterSchema, auditShowCount, hasAuditFilters, zonedDayStart } from "./audit-filter";

const SPACE = "c95712bf-109c-4290-9518-47571fca9598";

describe("auditFilterSchema", () => {
  it("reads comma lists, trims text and drops blanks", () => {
    const f = auditFilterSchema.parse({
      space: SPACE,
      action: "space.update, space.register,,space.update",
      result: "error,denied",
      actor: "  alex ",
      target: " ",
      from: "2026-11-01",
      to: "",
    });
    expect(f).toEqual({ space: [SPACE], action: ["space.update", "space.register"], result: ["error", "denied"], actor: "alex", from: "2026-11-01" });
  });

  it("accepts repeated params as a list", () => {
    expect(auditFilterSchema.parse({ result: ["ok", "error"] }).result).toEqual(["ok", "error"]);
  });

  it("rejects unknown results, bad space IDs and bad dates", () => {
    expect(auditFilterSchema.safeParse({ result: "ok,maybe" }).success).toBe(false);
    expect(auditFilterSchema.safeParse({ space: "customer-demo-space" }).success).toBe(false);
    expect(auditFilterSchema.safeParse({ from: "11/01/2026" }).success).toBe(false);
  });
});

describe("auditFilterQuery", () => {
  it("writes the filters back in a stable order, with extra params last", () => {
    const f = auditFilterSchema.parse({ to: "2026-11-12", result: "denied", action: "a.b,c.d", actor: "bob" });
    expect(auditFilterQuery(f)).toBe("?action=a.b%2Cc.d&actor=bob&result=denied&to=2026-11-12");
    expect(auditFilterQuery(f, { format: "csv" })).toBe("?action=a.b%2Cc.d&actor=bob&result=denied&to=2026-11-12&format=csv");
    expect(auditFilterSchema.parse(Object.fromEntries(new URLSearchParams(auditFilterQuery(f))))).toEqual(f);
  });

  it("leaves out the keyset cursor and is empty without filters", () => {
    expect(auditFilterQuery(auditFilterSchema.parse({ before: "20" }))).toBe("");
    expect(hasAuditFilters(auditFilterSchema.parse({}))).toBe(false);
    expect(hasAuditFilters(auditFilterSchema.parse({ result: "ok" }))).toBe(true);
  });
});

describe("zonedDayStart", () => {
  it("is midnight UTC in UTC", () => {
    expect(zonedDayStart("2026-11-12", "UTC").toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(zonedDayStart("2026-12-31", "UTC", 1).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("uses the zone's offset on that day, including daylight saving changes", () => {
    expect(zonedDayStart("2026-11-12", "America/Los_Angeles").toISOString()).toBe("2026-11-12T08:00:00.000Z");
    expect(zonedDayStart("2026-07-01", "America/Los_Angeles").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    // 2026-03-08 starts in PST; the next day starts in PDT.
    expect(zonedDayStart("2026-03-08", "America/Los_Angeles").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(zonedDayStart("2026-03-08", "America/Los_Angeles", 1).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect(zonedDayStart("2026-11-12", "Asia/Tokyo").toISOString()).toBe("2026-11-11T15:00:00.000Z");
  });
});

describe("auditShowCount", () => {
  it("rounds up to whole pages between one page and the maximum", () => {
    expect(auditShowCount(undefined)).toBe(AUDIT_PAGE_SIZE);
    expect(auditShowCount("abc")).toBe(AUDIT_PAGE_SIZE);
    expect(auditShowCount("10")).toBe(AUDIT_PAGE_SIZE);
    expect(auditShowCount("100")).toBe(100);
    expect(auditShowCount("101")).toBe(150);
    expect(auditShowCount(["150", "50"])).toBe(150);
    expect(auditShowCount("999999")).toBe(AUDIT_MAX_ROWS);
  });
});
