import { describe, expect, it, vi } from "vitest";
import { notifyPlanApplied, onPlanApplied } from "./hooks";

describe("plan-applied hooks", () => {
  it("runs every hook in order, logs a failing one and keeps going", async () => {
    const calls: string[] = [];
    const log = vi.fn();
    const off = [
      onPlanApplied(async (e) => {
        calls.push(`a:${e.planId}`);
      }),
      onPlanApplied(async () => {
        throw new Error("boom");
      }),
      onPlanApplied(async () => {
        calls.push("c");
      }),
    ];
    await notifyPlanApplied({ planId: "p1", spaceId: "s1", actor: { email: "a@example.com" }, log });
    expect(calls).toEqual(["a:p1", "c"]);
    expect(log).toHaveBeenCalledWith("a plan-applied hook failed", { error: "boom" });
    for (const f of off) f();
    calls.length = 0;
    await notifyPlanApplied({ planId: "p2", spaceId: "s1", actor: { email: "a@example.com" }, log });
    expect(calls).toEqual([]);
  });
});
