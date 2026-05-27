/**
 * Agent 2 — sample-plausibility screening.
 *
 * For each ranked candidate: ask "how likely is this compound to actually
 * occur in the user's sample?". This replaces the older generic-contamination
 * flag with a four-tier verdict grounded in PubMed counts. The classifier
 * itself is one batched cheap-model call; the evidence it sees is
 * deterministic (literal esearch hit counts), so the bottom of the list is
 * reliably enriched for industrial/lab contaminants without us hardcoding any
 * contaminant list.
 *
 * Pipeline:
 *   1. One LLM call: sampleContext -> {genus, common_names} for the PubMed query.
 *   2. Per-compound PubMed esearch (specific then loose), recording hit counts
 *      and the top PMIDs (passed to the synthesizer as seed citations).
 *   3. One batched LLM call: classify every candidate given that evidence.
 *
 * Uses src/llm/client only — never the OpenAI SDK directly.
 */
import { z } from "zod";
import { getLLMClient } from "../llm/client.js";
import { SCREEN_MODEL } from "../llm/models.js";
import { searchPubMed, pubmedCount } from "../tools/pubmed.js";
import type {
  EvidencePaper,
  Plausibility,
  RankedCompound,
  ScreenedCompound,
} from "../types.js";

const KEYWORDS_SYSTEM = `Extract PubMed search keywords for the sample described by the researcher. Return the scientific genus (or species) plus 1-3 common-name synonyms suitable for a Title/Abstract search. If the sample is not biological (e.g. wastewater, soil), return the matrix name and any organisms named. Keep terms short, no quotes, no operators.`;

const keywordsSchema = z.object({
  genus: z.string().nullable(),
  common_names: z.array(z.string()).max(4),
});

const CLASSIFY_SYSTEM = `You are a metabolomics plausibility judge. For each candidate compound, decide how likely it is to genuinely occur in the researcher's sample, using:
  - the PubMed evidence count we provide (specific match: "<compound>" AND organism keywords),
  - the loose-match count (compound name alone, indicates how studied it is at all),
  - the top retrieved paper titles,
  - the sample context (the researcher's own description),
  - the compound name itself (formula, chemical class hints).

Tiers (use exactly these strings):
  known     — at least one of the seed papers clearly reports this compound in the user's sample / organism, OR specific_hits >= 1 and a title plainly matches.
  plausible — reported in the same genus/family, in chemically/biologically similar matrices, or it is a primary metabolite (sugar, amino acid, common organic acid, common phenolic, common lipid) expected in any plant/animal tissue of this type.
  unknown   — sparse or ambiguous evidence; the researcher should review.
  unlikely  — no plausible biological origin in this sample (industrial chemicals, plasticizers, polyethers/PEG, silicones, common lab solvents, drug metabolites, database catalog identifiers like "NP-008993").

Reason field: one short clause, present-tense. Use null only when the verdict is "known" with an obvious match.`;

const classifySchema = z.object({
  classifications: z.array(
    z.object({
      name: z.string(),
      plausibility: z.enum(["known", "plausible", "unknown", "unlikely"]),
      reason: z.string().nullable(),
    }),
  ),
});

function normalize(p: string): Plausibility {
  if (p === "known" || p === "plausible" || p === "unlikely") return p;
  return "unknown";
}

function quote(name: string): string {
  // PubMed phrase search — strip quotes from the name itself.
  return `"${name.replace(/"/g, "")}"`;
}

/** Builds the PubMed query that combines compound name with sample keywords. */
function buildSpecificQuery(
  compoundName: string,
  genus: string | null,
  commonNames: string[],
): string | null {
  const terms: string[] = [];
  if (genus && genus.trim()) terms.push(`${genus.trim()}[Title/Abstract]`);
  for (const n of commonNames) {
    if (n && n.trim()) terms.push(`${n.trim()}[Title/Abstract]`);
  }
  if (terms.length === 0) return null;
  return `${quote(compoundName)}[Title/Abstract] AND (${terms.join(" OR ")})`;
}

async function extractKeywords(
  sampleContext: string,
): Promise<{ genus: string | null; commonNames: string[] }> {
  try {
    const client = getLLMClient();
    const out = await client.generateStructured(
      [
        { role: "system", content: KEYWORDS_SYSTEM },
        { role: "user", content: `Sample context:\n${sampleContext}` },
      ],
      keywordsSchema,
      "organism_keywords",
      { model: SCREEN_MODEL, reasoningEffort: "minimal" },
    );
    return {
      genus: out.genus?.trim() || null,
      commonNames: out.common_names.map((s) => s.trim()).filter(Boolean),
    };
  } catch {
    // Fall back: split the first noun phrase out of the sample context.
    const tokens = sampleContext.split(/[\s,.;:]+/).filter((t) => t.length > 3);
    return { genus: null, commonNames: tokens.slice(0, 2) };
  }
}

interface EvidenceLookup {
  specificHits: number;
  looseHits: number;
  topPapers: EvidencePaper[];
}

async function lookupEvidence(
  compound: RankedCompound,
  genus: string | null,
  commonNames: string[],
): Promise<EvidenceLookup> {
  const specificQuery = buildSpecificQuery(
    compound.name,
    genus,
    commonNames,
  );
  let specificHits = 0;
  let specificPmids: string[] = [];
  if (specificQuery) {
    try {
      const r = await pubmedCount(specificQuery, 3);
      specificHits = r.count;
      specificPmids = r.pmids;
    } catch {
      // Network/rate-limit hiccup — fall through to loose-only.
    }
  }

  let looseHits = 0;
  try {
    const r = await pubmedCount(`${quote(compound.name)}[Title/Abstract]`, 0);
    looseHits = r.count;
  } catch {
    looseHits = 0;
  }

  let topPapers: EvidencePaper[] = [];
  if (specificPmids.length > 0) {
    try {
      const papers = await searchPubMed(specificQuery!, 3);
      topPapers = papers.slice(0, 3).map((p) => ({
        pmid: p.pmid,
        title: p.title,
        year: p.year,
      }));
    } catch {
      topPapers = [];
    }
  }

  return { specificHits, looseHits, topPapers };
}

/**
 * Screens ranked candidates for sample plausibility. The returned array
 * preserves input order (re-sorting is done later by the pipeline).
 */
export async function screenCompounds(
  candidates: RankedCompound[],
  sampleContext: string,
): Promise<ScreenedCompound[]> {
  if (candidates.length === 0) return [];

  const { genus, commonNames } = await extractKeywords(sampleContext);

  // Evidence lookups in parallel — RateLimiter inside pubmed.ts serializes
  // the actual HTTP calls (3 req/s anon, 10 req/s with NCBI_API_KEY).
  const evidence = await Promise.all(
    candidates.map((c) => lookupEvidence(c, genus, commonNames)),
  );

  const listLines = candidates.map((c, i) => {
    const e = evidence[i]!;
    const titleLine =
      e.topPapers.length > 0
        ? e.topPapers
            .slice(0, 2)
            .map((p) => `    - "${p.title}"`)
            .join("\n")
        : "    - (no specific-match titles)";
    return [
      `${i + 1}. ${c.name}`,
      `   formula: ${c.formula ?? "n/a"} | ChemSpider hits: ${
        c.chemspiderResults ?? "n/a"
      } | match: ${c.chemspiderMatch ?? "n/a"}`,
      `   PubMed evidence — specific (compound + sample keywords): ${e.specificHits} hits; loose (compound alone): ${e.looseHits} hits`,
      `   top specific-match titles:`,
      titleLine,
    ].join("\n");
  });

  const keywordSummary = [
    genus ? `genus: ${genus}` : null,
    commonNames.length ? `common: ${commonNames.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ") || "(no sample keywords extracted)";

  const userPrompt = `Sample context:\n${sampleContext}\n\nPubMed sample keywords used: ${keywordSummary}\n\nCandidates:\n${listLines.join(
    "\n\n",
  )}\n\nClassify every compound. Use the exact compound name in your output.`;

  const client = getLLMClient();
  const { classifications } = await client.generateStructured(
    [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    classifySchema,
    "plausibility_classifications",
    { model: SCREEN_MODEL, reasoningEffort: "low" },
  );

  const byName = new Map<
    string,
    { plausibility: Plausibility; reason: string | null }
  >();
  for (const c of classifications) {
    byName.set(c.name.trim().toLowerCase(), {
      plausibility: normalize(c.plausibility),
      reason: c.reason ?? null,
    });
  }

  return candidates.map((c, i) => {
    const hit = byName.get(c.name.trim().toLowerCase());
    const e = evidence[i]!;
    return {
      ...c,
      plausibility: hit?.plausibility ?? "unknown",
      plausibilityReason: hit?.reason ?? null,
      pubmedHits: e.specificHits,
      evidence: e.topPapers,
    };
  });
}
