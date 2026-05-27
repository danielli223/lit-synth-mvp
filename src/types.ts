/**
 * Shared domain types for the lit-synth pipeline.
 */

/** A single named compound row parsed from the Compound Discoverer export. */
export interface CompoundRow {
  name: string;
  formula: string | null;
  mz: number | null;
  rt: number | null;
  chemspiderResults: number | null;
  /** "Annot. Source: ChemSpider Search" — e.g. Full match / Partial match / No match. */
  chemspiderMatch: string | null;
  /** comparison display name (prefix stripped) -> log2 fold change */
  log2fc: Record<string, number | null>;
  /** comparison display name (prefix stripped) -> adjusted p-value */
  adjP: Record<string, number | null>;
}

export interface ParsedWorkbook {
  /** Comparison display names (the "Log2 Fold Change: " prefix already stripped). */
  comparisons: string[];
  /** All rows with a non-null Name. Not yet deduplicated. */
  rows: CompoundRow[];
}

/** Output of Agent 1 — a compound with its strongest-signal statistics. */
export interface RankedCompound extends CompoundRow {
  /** Comparison (display name) that produced the maximum |log2 fold change|. */
  bestComparison: string;
  absLog2Fc: number;
  adjPValue: number;
  compositeScore: number;
}

/**
 * Sample-plausibility tier produced by Agent 2.
 *
 *   known     — direct prior report of this compound in the user's sample
 *   plausible — reported in the genus / family / similar matrix, or a primary
 *               metabolite expected in any plant tissue
 *   unknown   — no clear evidence either way; defer to the researcher
 *   unlikely  — no plausible biological origin in this sample (industrial
 *               chemicals, drug metabolites, common lab contaminants)
 */
export type Plausibility = "known" | "plausible" | "unknown" | "unlikely";

/** Stable rank order for sorting; lower = higher priority. */
export const PLAUSIBILITY_RANK: Record<Plausibility, number> = {
  known: 0,
  plausible: 1,
  unknown: 2,
  unlikely: 3,
};

/** A minimal PubMed reference returned by the evidence lookup. */
export interface EvidencePaper {
  pmid: string;
  title: string;
  year: number | null;
}

/** A ranked compound after Agent 2 plausibility screening. */
export interface ScreenedCompound extends RankedCompound {
  plausibility: Plausibility;
  /** One-line rationale from the classifier (or null when truly trivial). */
  plausibilityReason: string | null;
  /** Number of PubMed hits matching the compound + sample-organism query. */
  pubmedHits: number;
  /** Top PubMed papers from the evidence lookup; passed to the synthesizer as seeds. */
  evidence: EvidencePaper[];
}

export interface Citation {
  title: string;
  authors_string: string;
  year: number | null;
  source: "pubmed" | "semantic_scholar";
  id: string;
  url: string;
  relevance_note: string;
}

export interface SynthesisResult {
  synthesis_paragraph: string;
  citations: Citation[];
  confidence: "high" | "medium" | "low";
  caveats: string | null;
}

/** A compound paired with its validated synthesis. */
export interface CompoundSynthesis {
  compound: ScreenedCompound;
  result: SynthesisResult;
  /** Number of citations dropped by deterministic validation. */
  droppedCitations: number;
}

export interface RunContext {
  sourceFile: string;
  sampleContext: string;
  selectedComparisons: string[];
}
