import { describe, expect, it } from "vitest";
import { unknownReasonText } from "./words";

const o = { retentionDays: 90, deliveryDelaySeconds: 300 };
const none = { old: 0, pending: 0, failed: 0, noEvent: 0 };

describe("why changes are marked Unknown", () => {
  it("says the 90-day reason only for changes older than the lookup period", () => {
    expect(unknownReasonText({ ...none, old: 2 }, o)).toEqual(["AWS keeps a record of who made each change for 90 days. 2 changes marked Unknown are older than that."]);
    expect(unknownReasonText({ ...none, pending: 3 }, o).join(" ")).not.toMatch(/90 days/);
  });

  it("says what is true for recent changes, most common reason first", () => {
    expect(unknownReasonText({ old: 0, pending: 3, failed: 1, noEvent: 2 }, o)).toEqual([
      "CloudTrail hasn't delivered an event yet for 3 changes made recently. The app waits 5 minutes for one, and a later sync looks again.",
      "CloudTrail had no matching event for 2 changes.",
      "The CloudTrail lookup failed for 1 change.",
    ]);
    expect(unknownReasonText(none, o)).toEqual([]);
  });
});
