import { describe, expect, it } from "vitest";
import { acceptedOnList, mergeToAddress, takeOffList } from "./to-address";

describe("to-address list", () => {
  it("adds new findings after the ones already there, once each, in the given order", () => {
    expect(mergeToAddress(["a"], new Set(), ["c", "b", "c"])).toEqual({ next: ["a", "c", "b"], added: ["c", "b"], alreadyThere: 0 });
    expect(mergeToAddress([], new Set(), [])).toEqual({ next: [], added: [], alreadyThere: 0 });
  });

  it("counts findings already on the list or already linked, and doesn't add them", () => {
    expect(mergeToAddress(["a", "b"], new Set(["c"]), ["a", "c", "d", "a"])).toEqual({ next: ["a", "b", "d"], added: ["d"], alreadyThere: 2 });
  });

  it("takes findings off the list, keeping the order of the rest", () => {
    expect(takeOffList(["a", "b", "c", "d"], ["c", "a", "x"])).toEqual(["b", "d"]);
    expect(takeOffList(["a"], [])).toEqual(["a"]);
  });

  it("counts only the findings that are accepted now", () => {
    const states = new Map([
      ["a", "accepted"],
      ["b", "proposed"],
      ["c", "rejected"],
      ["d", "accepted"],
    ]);
    expect(acceptedOnList(["a", "b", "c", "d", "gone"], states)).toBe(2);
    expect(acceptedOnList([], states)).toBe(0);
  });
});
