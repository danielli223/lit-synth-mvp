/**
 * Agent 3 — literature synthesis with tools.
 *
 * Fresh agent invocation per compound. The model may call PubMed and
 * Semantic Scholar (max 10 tool calls). Every paper returned by every tool
 * call is logged into id sets, and the model's citations are then validated
 * deterministically against those sets (see validate-citations.ts).
 *
 * Uses src/llm/client only — never the OpenAI SDK directly.
 */
import { z } from "zod";
import { getLLMClient, type LLMTool } from "../llm/client.js";
import { SYNTHESIS_MODEL } from "../llm/models.js";
import { searchPubMed, pubmedUrl } from "../tools/pubmed.js";
import {
  searchSemanticScholar,
  s2Url,
} from "../tools/semantic-scholar.js";
import {
  validateCitations,
  type RetrievedIds,
} from "../validate-citations.js";
import type {
  CompoundSynthesis,
  ScreenedCompound,
  SynthesisResult,
} from "../types.js";

const SYSTEM_PROMPT = `You are a metabolomics literature synthesist. Given a compound and sample context, produce a 100-200 word publication-ready paragraph for the discussion section of a metabolomics paper, with citations.

Search strategy:
1. First try compound name + sample organism (e.g. 'cyanidin-3-glucoside Sambucus nigra')
2. If results are sparse, broaden to the genus or similar sample types
3. If still sparse, search for the compound's known role or class
4. Try compound name synonyms if initial search fails

Citation rules (critical):
- Cite only papers that appear in your tool call results from this session
- Never include a citation from your training data or memory
- If literature is sparse, say so explicitly rather than fabricating support
- Include a one-line relevance_note for each citation explaining why it supports your claim`;

const synthesisSchema = z.object({
  synthesis_paragraph: z.string(),
  citations: z.array(
    z.object({
      title: z.string(),
      authors_string: z.string(),
      year: z.number().int().nullable(),
      source: z.enum(["pubmed", "semantic_scholar"]),
      id: z.string(),
      url: z.string(),
      relevance_note: z.string(),
    }),
  ),
  confidence: z.enum(["high", "medium", "low"]),
  caveats: z.string().nullable(),
});

const searchArgsSchema = z.object({
  query: z.string().describe("Search query string."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe("Maximum number of papers to return (default 10)."),
});

/**
 * Synthesizes literature for one compound. Citations are validated before
 * the result is returned.
 */
export async function synthesizeCompound(
  compound: ScreenedCompound,
  sampleContext: string,
): Promise<CompoundSynthesis> {
  const retrieved: RetrievedIds = {
    pubmedPmids: new Set<string>(),
    semanticScholarIds: new Set<string>(),
  };

  const tools: LLMTool<z.infer<typeof searchArgsSchema>>[] = [
    {
      name: "search_pubmed",
      description:
        "Search PubMed (NCBI E-utilities) for papers. Returns pmid, title, abstract, year, authors_string, journal.",
      parameters: searchArgsSchema,
      execute: async ({ query, max_results }) => {
        const papers = await searchPubMed(query, max_results ?? 10);
        for (const p of papers) retrieved.pubmedPmids.add(p.pmid);
        return papers.map((p) => ({ ...p, url: pubmedUrl(p.pmid) }));
      },
    },
    {
      name: "search_semantic_scholar",
      description:
        "Search Semantic Scholar Graph API for papers. Returns paper_id, title, abstract, year, authors_string, venue, doi.",
      parameters: searchArgsSchema,
      execute: async ({ query, max_results }) => {
        const papers = await searchSemanticScholar(
          query,
          max_results ?? 10,
        );
        for (const p of papers)
          retrieved.semanticScholarIds.add(p.paper_id);
        return papers.map((p) => ({ ...p, url: s2Url(p) }));
      },
    },
  ];

  const seedLines = compound.evidence.length
    ? compound.evidence
        .map((p) => `  - PMID ${p.pmid}${p.year ? ` (${p.year})` : ""}: ${p.title}`)
        .join("\n")
    : "  (none — the screen stage found no specific-match PubMed papers)";

  const userPrompt = `Compound: ${compound.name}
Formula: ${compound.formula ?? "n/a"}
m/z: ${compound.mz ?? "n/a"} | RT: ${compound.rt ?? "n/a"} min
Strongest comparison: ${compound.bestComparison} (|log2FC|=${compound.absLog2Fc.toFixed(
    2,
  )}, adj.p=${compound.adjPValue.toExponential(2)})
Sample-plausibility verdict: ${compound.plausibility}${
    compound.plausibilityReason ? ` — ${compound.plausibilityReason}` : ""
  }
PubMed seed papers from the screen stage (verify by calling search_pubmed for these PMIDs; they are starting points, not free citations):
${seedLines}

Sample context provided by the researcher:
${sampleContext}

Synthesize the literature for this compound in this sample context. Cite only papers returned by your tool calls.`;

  const client = getLLMClient();
  const { output } = await client.generateWithTools<
    z.infer<typeof synthesisSchema>
  >(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    tools,
    synthesisSchema,
    "literature_synthesis",
    {
      model: SYNTHESIS_MODEL,
      maxToolCalls: 10,
      reasoningEffort: "medium",
    },
  );

  const { result, droppedCount } = validateCitations(
    output as SynthesisResult,
    retrieved,
  );

  return { compound, result, droppedCitations: droppedCount };
}
