import { describe, it, expect } from "vitest";
import { rankCompounds, sortByPlausibility } from "../src/ranking.js";
import type { CompoundRow, ScreenedCompound } from "../src/types.js";

function row(
  name: string,
  log2fc: Record<string, number | null>,
  adjP: Record<string, number | null>,
): CompoundRow {
  return {
    name,
    formula: "C1",
    mz: 100,
    rt: 1,
    chemspiderResults: 1,
    chemspiderMatch: "Full match",
    log2fc,
    adjP,
  };
}

const thresholds = {
  maxAdjP: 0.05,
  minAbsLog2Fc: 1,
  maxCandidates: 40,
};

describe("rankCompounds", () => {
  it("filters out non-significant and low-fold-change compounds", () => {
    const rows = [
      row("strong", { A: 3 }, { A: 0.001 }),
      row("weak_fc", { A: 0.5 }, { A: 0.001 }), // |fc| not > 1
      row("not_sig", { A: 4 }, { A: 0.2 }), // adj.p not < 0.05
      row("no_p", { A: 4 }, { A: null }), // missing p -> excluded
    ];
    const ranked = rankCompounds(rows, ["A"], thresholds);
    expect(ranked.map((r) => r.name)).toEqual(["strong"]);
  });

  it("uses max |log2FC| across selected comparisons and its adj.p", () => {
    const rows = [
      row("c", { A: 1.2, B: -3.5 }, { A: 0.04, B: 0.002 }),
    ];
    const ranked = rankCompounds(rows, ["A", "B"], thresholds);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.bestComparison).toBe("B");
    expect(ranked[0]!.absLog2Fc).toBeCloseTo(3.5);
    expect(ranked[0]!.adjPValue).toBeCloseTo(0.002);
  });

  it("ignores comparisons the user did not select", () => {
    const rows = [row("c", { A: 0.2, B: 5 }, { A: 0.9, B: 0.0001 })];
    // Only A selected -> A fails |fc|>1, compound excluded.
    expect(rankCompounds(rows, ["A"], thresholds)).toHaveLength(0);
  });

  it("sorts descending by composite score and caps at maxCandidates", () => {
    const rows = [
      row("low", { A: 1.5 }, { A: 0.04 }),
      row("high", { A: 6 }, { A: 1e-10 }),
      row("mid", { A: 3 }, { A: 0.001 }),
    ];
    const ranked = rankCompounds(rows, ["A"], {
      ...thresholds,
      maxCandidates: 2,
    });
    expect(ranked.map((r) => r.name)).toEqual(["high", "mid"]);
  });
});

function screened(
  name: string,
  plausibility: ScreenedCompound["plausibility"],
  compositeScore: number,
): ScreenedCompound {
  return {
    name,
    formula: null,
    mz: null,
    rt: null,
    chemspiderResults: null,
    chemspiderMatch: null,
    log2fc: {},
    adjP: {},
    bestComparison: "A",
    absLog2Fc: 1,
    adjPValue: 0.01,
    compositeScore,
    plausibility,
    plausibilityReason: null,
    pubmedHits: 0,
    evidence: [],
  };
}

describe("sortByPlausibility", () => {
  it("orders tiers known > plausible > unknown > unlikely", () => {
    const out = sortByPlausibility([
      screened("u", "unlikely", 100),
      screened("p", "plausible", 1),
      screened("k", "known", 0.1),
      screened("?", "unknown", 50),
    ]);
    expect(out.map((r) => r.name)).toEqual(["k", "p", "?", "u"]);
  });

  it("breaks ties within a tier by composite score (desc)", () => {
    const out = sortByPlausibility([
      screened("p_lo", "plausible", 1),
      screened("p_hi", "plausible", 99),
      screened("p_mid", "plausible", 50),
    ]);
    expect(out.map((r) => r.name)).toEqual(["p_hi", "p_mid", "p_lo"]);
  });

  it("a high-composite unlikely never outranks a low-composite known", () => {
    const out = sortByPlausibility([
      screened("contaminant_huge_fc", "unlikely", 1000),
      screened("real_compound_weak_fc", "known", 0.01),
    ]);
    expect(out.map((r) => r.name)).toEqual([
      "real_compound_weak_fc",
      "contaminant_huge_fc",
    ]);
  });
});
