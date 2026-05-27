/**
 * Semantic Scholar retrieval via the Graph API paper-search endpoint.
 *
 * Anonymous limit is ~100 requests / 5 min. We back off on HTTP 429.
 */
import { RateLimiter, sleep } from "../util/rate-limit.js";

const SEARCH_URL =
  "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,abstract,year,authors,venue,externalIds,url";

export interface S2Paper {
  paper_id: string;
  title: string;
  abstract: string;
  year: number | null;
  authors_string: string;
  venue: string;
  doi: string | null;
}

const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY?.trim() || undefined;
// ~100 req / 5 min anonymous -> ~3s spacing keeps us comfortably under.
const limiter = new RateLimiter(apiKey ? 1100 : 3100);

export async function searchSemanticScholar(
  query: string,
  maxResults = 10,
): Promise<S2Paper[]> {
  const limit = Math.min(Math.max(maxResults, 1), 25);
  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", FIELDS);

  const headers: Record<string, string> = {
    "User-Agent": "lit-synth-mvp/0.1",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  let attempt = 0;
  // Up to 3 attempts with exponential backoff on rate limiting.
  while (true) {
    await limiter.wait();
    const resp = await fetch(url, { headers });

    if (resp.status === 429 && attempt < 3) {
      attempt++;
      await sleep(2000 * attempt);
      continue;
    }
    if (!resp.ok) {
      throw new Error(
        `Semantic Scholar search failed: HTTP ${resp.status}`,
      );
    }

    const json = (await resp.json()) as {
      data?: Array<Record<string, any>>;
    };
    const data = json.data ?? [];

    return data.map((p): S2Paper => {
      const authors = (p.authors ?? [])
        .map((au: any) => au?.name)
        .filter(Boolean) as string[];
      const authors_string =
        authors.length > 3
          ? `${authors.slice(0, 3).join(", ")}, et al.`
          : authors.join(", ");
      return {
        paper_id: String(p.paperId ?? ""),
        title: String(p.title ?? "").trim(),
        abstract: String(p.abstract ?? "").trim(),
        year: typeof p.year === "number" ? p.year : null,
        authors_string,
        venue: String(p.venue ?? "").trim(),
        doi: p.externalIds?.DOI ? String(p.externalIds.DOI) : null,
      };
    });
  }
}

export function s2Url(paper: {
  paper_id: string;
  doi: string | null;
}): string {
  if (paper.doi) return `https://doi.org/${paper.doi}`;
  return `https://www.semanticscholar.org/paper/${paper.paper_id}`;
}
