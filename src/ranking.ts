/**
 * Agent 1 — deterministic statistical ranking. No LLM involved.
 *
 * For each compound: take the maximum |log2 fold change| across the
 * user-selected comparisons and the adjusted p-value of that same comparison.
 * Composite score = abs_log2_fc * -log10(adj_p + 1e-300). Filter, sort,
 * take the top N.
 */
import {
  PLAUSIBILITY_RANK,
  type CompoundRow,
  type RankedCompound,
  type ScreenedCompound,
} from "./types.js";

export interface RankingThresholds {
  /** Keep compounds with adjusted p-value strictly below this. */
  maxAdjP: number;
  /** Keep compounds with |log2 fold change| strictly above this. */
  minAbsLog2Fc: number;
  /** Maximum number of ranked candidates to return. */
  maxCandidates: number;
}

export const DEFAULT_THRESHOLDS: Omit<RankingThresholds, "maxCandidates"> = {
  maxAdjP: 0.05,
  minAbsLog2Fc: 1,
};

function bestSignal(
  row: CompoundRow,
  selectedComparisons: string[],
): { comparison: string; absLog2Fc: number; adjP: number } | null {
  let best: {
    comparison: string;
    absLog2Fc: number;
    adjP: number;
  } | null = null;
  for (const cmp of selectedComparisons) {
    const fc = row.log2fc[cmp];
    if (fc == null || !Number.isFinite(fc)) continue;
    const abs = Math.abs(fc);
    if (best === null || abs > best.absLog2Fc) {
      const p = row.adjP[cmp];
      best = {
        comparison: cmp,
        absLog2Fc: abs,
        adjP: p != null && Number.isFinite(p) ? p : NaN,
      };
    }
  }
  return best;
}

/**
 * Ranks compounds. Input rows should already be deduplicated by name and
 * scoped to the user-selected comparisons.
 */
export function rankCompounds(
  rows: CompoundRow[],
  selectedComparisons: string[],
  thresholds: RankingThresholds,
): RankedCompound[] {
  const ranked: RankedCompound[] = [];

  for (const row of rows) {
    const sig = bestSignal(row, selectedComparisons);
    if (!sig) continue;
    // Adjusted p-value is required to pass the significance filter.
    if (!Number.isFinite(sig.adjP)) continue;
    if (sig.adjP >= thresholds.maxAdjP) continue;
    if (sig.absLog2Fc <= thresholds.minAbsLog2Fc) continue;

    const compositeScore =
      sig.absLog2Fc * -Math.log10(sig.adjP + 1e-300);

    ranked.push({
      ...row,
      bestComparison: sig.comparison,
      absLog2Fc: sig.absLog2Fc,
      adjPValue: sig.adjP,
      compositeScore,
    });
  }

  ranked.sort((a, b) => b.compositeScore - a.compositeScore);
  return ranked.slice(0, thresholds.maxCandidates);
}

/**
 * Re-sorts screened compounds by sample-plausibility tier first, then by the
 * existing composite score within each tier. Primary key reflects how likely
 * the compound is to belong in the user's sample (known > plausible > unknown
 * > unlikely); secondary key keeps the strongest statistical signal on top
 * inside each tier. Does not drop or filter — the UI still shows everything
 * so the researcher can override a verdict.
 */
export function sortByPlausibility(
  rows: ScreenedCompound[],
): ScreenedCompound[] {
  return [...rows].sort((a, b) => {
    const tier = PLAUSIBILITY_RANK[a.plausibility] - PLAUSIBILITY_RANK[b.plausibility];
    if (tier !== 0) return tier;
    return b.compositeScore - a.compositeScore;
  });
}
