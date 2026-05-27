import { describe, it, expect } from "vitest";
import { parseNumberSelection } from "../src/util/selection.js";

describe("parseNumberSelection", () => {
  it("parses comma lists", () => {
    const r = parseNumberSelection("1,3,5", 1, 10);
    expect(r.values).toEqual([1, 3, 5]);
    expect(r.errors).toEqual([]);
  });

  it("parses ranges and mixed lists, sorted + de-duplicated", () => {
    const r = parseNumberSelection("1-5,8,12-15,3", 1, 40);
    expect(r.values).toEqual([1, 2, 3, 4, 5, 8, 12, 13, 14, 15]);
    expect(r.errors).toEqual([]);
  });

  it("handles reversed ranges", () => {
    const r = parseNumberSelection("5-2", 1, 10);
    expect(r.values).toEqual([2, 3, 4, 5]);
  });

  it("reports out-of-range values", () => {
    const r = parseNumberSelection("2,99", 1, 10);
    expect(r.values).toEqual([2]);
    expect(r.errors.join()).toContain("99 is out of range");
  });

  it("rejects non-numeric tokens", () => {
    const r = parseNumberSelection("abc,2", 1, 10);
    expect(r.values).toEqual([2]);
    expect(r.errors.join()).toContain('"abc" is not a number');
  });

  it("treats empty input as an empty selection", () => {
    const r = parseNumberSelection("   ", 1, 10);
    expect(r.values).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("tolerates whitespace around tokens and ranges", () => {
    const r = parseNumberSelection(" 1 - 3 , 7 ", 1, 10);
    expect(r.values).toEqual([1, 2, 3, 7]);
  });
});
