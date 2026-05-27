/**
 * Deterministic citation validation. CRITICAL, non-negotiable.
 *
 * The LLM may only cite papers it actually retrieved during the session.
 * Every paper returned by every tool call is logged into id sets; any
 * citation whose id is not in the matching set is dropped, and a caveat
 * is appended noting how many were removed.
 */
import type { Citation, SynthesisResult } from "./types.js";

export interface RetrievedIds {
  pubmedPmids: Set<string>;
  semanticScholarIds: Set<string>;
}

export interface ValidationOutcome {
  result: SynthesisResult;
  droppedCount: number;
  droppedCitations: Citation[];
}

/**
 * Filters `result.citations` down to citations that were actually retrieved.
 * Returns a new SynthesisResult; the input is not mutated.
 */
export function validateCitations(
  result: SynthesisResult,
  retrieved: RetrievedIds,
): ValidationOutcome {
  const kept: Citation[] = [];
  const dropped: Citation[] = [];

  for (const c of result.citations ?? []) {
    const id = String(c.id ?? "").trim();
    let valid = false;
    if (id) {
      if (c.source === "pubmed") {
        valid = retrieved.pubmedPmids.has(id);
      } else if (c.source === "semantic_scholar") {
        valid = retrieved.semanticScholarIds.has(id);
      }
    }
    if (valid) kept.push(c);
    else dropped.push(c);
  }

  let caveats = result.caveats ?? null;
  if (dropped.length > 0) {
    const note = `${dropped.length} citation${
      dropped.length === 1 ? " was" : "s were"
    } dropped during validation.`;
    caveats = caveats ? `${caveats} ${note}` : note;
  }

  return {
    result: { ...result, citations: kept, caveats },
    droppedCount: dropped.length,
    droppedCitations: dropped,
  };
}
