/**
 * Offline mock implementation of {@link LLMClient}.
 *
 * Lets the entire pipeline run end-to-end with NO OpenAI API key:
 *   - generateStructured: deterministic keyword-based plausibility
 *     classification (industrial/lab-contamination patterns become "unlikely";
 *     anything else "plausible") and stub organism-keyword extraction.
 *   - generateWithTools: actually invokes the supplied PubMed / Semantic
 *     Scholar tools so the real retrieval + deterministic citation
 *     validation path is exercised, then cites the genuinely retrieved
 *     papers and injects one bogus citation to prove validation drops it.
 *
 * Selected automatically when OPENAI_API_KEY is absent, or forced via
 * LIT_SYNTH_MOCK=1 / the CLI --mock flag.
 */
import type { z } from "zod";
import type {
  GenerateOptions,
  GenerateWithToolsOptions,
  LLMClient,
  LLMMessage,
  LLMTool,
  ToolCallLogEntry,
  ToolRunResult,
} from "./client.js";

const CONTAMINANT_PATTERNS = [
  /phthalate/i,
  /\bPEG\b/i,
  /polyethylene glycol/i,
  /polyether/i,
  /siloxane/i,
  /silicone/i,
  /\bDMSO\b/i,
  /dimethyl sulfoxide/i,
  /acetonitrile/i,
  /plasticizer/i,
  /\bTris\b/i,
  /erucamide/i,
  /\bPPG\b/i,
];
// Catalog-style identifiers, e.g. "NP-008993", "ZINC123456", "CHEMBL12345".
const CATALOG_ID = /\b([A-Z]{2,}-?\d{4,}|NP-?\d+)\b/;

function lastUser(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

export class MockProvider implements LLMClient {
  async generate(messages: LLMMessage[]): Promise<string> {
    return `[mock] ${lastUser(messages).slice(0, 120)}`;
  }

  async generateStructured<T>(
    messages: LLMMessage[],
    schema: z.ZodType<T>,
    schemaName: string,
  ): Promise<T> {
    if (schemaName === "plausibility_classifications") {
      const text = lastUser(messages);
      const classifications: Array<{
        name: string;
        plausibility: "known" | "plausible" | "unknown" | "unlikely";
        reason: string | null;
      }> = [];
      // Lines now look like: "12. Compound name\n   formula: ..."
      const re = /^\s*\d+\.\s+(.+?)\s*$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const name = m[1]!.trim();
        // Skip headers and the keyword summary line, just in case.
        if (/^(formula|PubMed|top|Sample|Candidates|Classify)/i.test(name))
          continue;
        if (CONTAMINANT_PATTERNS.some((p) => p.test(name))) {
          classifications.push({
            name,
            plausibility: "unlikely",
            reason: "matches a common lab/industrial contaminant pattern",
          });
        } else if (CATALOG_ID.test(name)) {
          classifications.push({
            name,
            plausibility: "unknown",
            reason: "looks like a database catalog identifier",
          });
        } else {
          classifications.push({
            name,
            plausibility: "plausible",
            reason: "(mock) no contaminant pattern matched",
          });
        }
      }
      return schema.parse({ classifications });
    }

    if (schemaName === "organism_keywords") {
      // Stub extraction: keep the first capitalized token (proxy for genus)
      // and the longest lowercase token (proxy for common name).
      const text = lastUser(messages);
      const tokens = text.split(/[\s,.;:()/]+/).filter((t) => t.length > 3);
      const genus = tokens.find((t) => /^[A-Z][a-z]+$/.test(t)) ?? null;
      const common = tokens
        .filter((t) => /^[a-z]{4,}$/.test(t))
        .sort((a, b) => b.length - a.length)
        .slice(0, 2);
      return schema.parse({ genus, common_names: common });
    }

    // Unknown structured call: best-effort empty parse.
    return schema.parse({} as unknown);
  }

  async generateWithTools<T>(
    messages: LLMMessage[],
    tools: LLMTool<any>[],
    schema: z.ZodType<T>,
    _schemaName: string,
    options: GenerateWithToolsOptions,
  ): Promise<ToolRunResult<T>> {
    const text = lastUser(messages);
    const compound =
      text.match(/Compound:\s*(.+)/)?.[1]?.trim() ?? "unknown compound";
    const organism =
      text.match(/organism[^:]*:\s*(.+)/i)?.[1]?.trim().split(/[.,\n]/)[0] ??
      "";

    const toolLog: ToolCallLogEntry[] = [];
    const collected: Array<{
      title: string;
      authors_string: string;
      year: number | null;
      source: "pubmed" | "semantic_scholar";
      id: string;
      url: string;
    }> = [];

    const pubmed = tools.find((t) => t.name === "search_pubmed");
    const s2 = tools.find((t) => t.name === "search_semantic_scholar");
    let budget = options.maxToolCalls;
    // Mirrors Agent 3's strategy: broad compound-name query first, then a
    // narrowed organism query only if the broad one is sparse.
    const organismWord = organism.split(/\s+/).pop() ?? "";
    const queries = [compound];
    if (organismWord && organismWord.length > 3) {
      queries.push(`${compound} ${organismWord}`);
    }

    async function call(
      tool: LLMTool<any> | undefined,
      source: "pubmed" | "semantic_scholar",
      query: string,
    ): Promise<number> {
      if (!tool || budget <= 0) return 0;
      budget--;
      const args = { query, max_results: 5 };
      try {
        const res = (await tool.execute(args)) as any[];
        toolLog.push({ tool: tool.name, args, result: res });
        const before = collected.length;
        for (const p of (res ?? []).slice(0, 2)) {
          collected.push({
            title: p.title ?? "(untitled)",
            authors_string: p.authors_string ?? "Unknown",
            year: p.year ?? null,
            source,
            id: String(source === "pubmed" ? p.pmid : p.paper_id),
            url: p.url ?? "",
          });
        }
        return collected.length - before;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[mock] ${tool.name} failed: ${msg}`);
        toolLog.push({ tool: tool.name, args, result: null, error: msg });
        return 0;
      }
    }

    // Prefer PubMed (no aggressive anonymous rate limit); fall back to
    // Semantic Scholar only if PubMed yields nothing.
    let hits = 0;
    for (const q of queries) {
      hits += await call(pubmed, "pubmed", q);
      if (hits >= 2) break;
    }
    if (hits === 0) {
      await call(s2, "semantic_scholar", queries[0]!);
    }

    const realCites = collected.slice(0, 4).map((c) => ({
      ...c,
      relevance_note: `Retrieved for "${compound}"; supports its presence/role in this sample context.`,
    }));

    // Intentional bogus citation — deterministic validation must drop it.
    const bogus = {
      title: "Fabricated reference that was never retrieved",
      authors_string: "Nobody et al.",
      year: 2099,
      source: "pubmed" as const,
      id: "MOCK-FAKE-0000",
      url: "https://example.com/not-real",
      relevance_note: "(should be removed by citation validation)",
    };

    const paragraph =
      realCites.length > 0
        ? `In this dataset, ${compound} was among the strongly differential features. ` +
          `Retrieved literature provides context for its occurrence and biological relevance ` +
          `in the described sample type. The strength and specificity of supporting reports vary, ` +
          `so the annotation should be treated as a hypothesis pending orthogonal confirmation. ` +
          `[mock synthesis — generated offline without an LLM]`
        : `No literature could be retrieved for ${compound} in this run, so support is currently ` +
          `absent. The compound remains a candidate but its annotation is unconfirmed. ` +
          `[mock synthesis — generated offline without an LLM]`;

    const output = schema.parse({
      synthesis_paragraph: paragraph,
      citations: [...realCites, bogus],
      confidence:
        realCites.length >= 2 ? "medium" : realCites.length === 1 ? "low" : "low",
      caveats:
        realCites.length === 0
          ? "Mock run: no papers retrieved (likely offline)."
          : null,
    });

    return { output, toolLog };
  }
}
