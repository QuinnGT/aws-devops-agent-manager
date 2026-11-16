import { describe, expect, it } from "vitest";
import { finishWords } from "./runner";

describe("worker log finish line", () => {
  it("says succeeded, unless the result reports failed items", () => {
    expect(finishWords({ status: "applied", failed: 0 })).toBe("succeeded");
    expect(finishWords(undefined)).toBe("succeeded");
    // A live apply with 1 failed item was once logged as "succeeded".
    expect(finishWords({ status: "failed", failed: 1 })).toBe("finished with 1 failed item");
    expect(finishWords({ status: "failed", failed: 3 })).toBe("finished with 3 failed items");
    expect(finishWords({ status: "failed" })).toBe("finished with failures");
  });
});
