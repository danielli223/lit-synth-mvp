import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseWorkbook, dedupByName } from "../src/excel-parser.js";

const SAMPLE = resolve("test-data/sample.xlsx");
const hasSample = existsSync(SAMPLE);

describe.runIf(hasSample)("parseWorkbook (test-data/sample.xlsx)", () => {
  it("extracts ~42 pairwise comparisons", () => {
    const { comparisons } = parseWorkbook(SAMPLE);
    expect(comparisons.length).toBeGreaterThanOrEqual(40);
    expect(comparisons.length).toBeLessThanOrEqual(45);
    // Prefix must be stripped.
    expect(
      comparisons.every((c) => !c.startsWith("Log2 Fold Change:")),
    ).toBe(true);
  });

  it("keeps only named rows and dedups to fewer unique compounds", () => {
    const parsed = parseWorkbook(SAMPLE);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.every((r) => r.name.length > 0)).toBe(true);

    const deduped = dedupByName(parsed.rows, parsed.comparisons.slice(0, 2));
    const names = new Set(deduped.map((r) => r.name));
    expect(names.size).toBe(deduped.length); // unique by name
    expect(deduped.length).toBeLessThanOrEqual(parsed.rows.length);
  });

  it("populates log2fc/adjP keyed by comparison display name", () => {
    const { comparisons, rows } = parseWorkbook(SAMPLE);
    const c0 = comparisons[0]!;
    expect(Object.prototype.hasOwnProperty.call(rows[0]!.log2fc, c0)).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(rows[0]!.adjP, c0)).toBe(
      true,
    );
  });
});
