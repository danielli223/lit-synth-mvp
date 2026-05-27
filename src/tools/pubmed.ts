/**
 * PubMed retrieval via NCBI E-utilities.
 *
 * Two-step: esearch (term -> PMIDs) then efetch (PMIDs -> metadata).
 * Rate limited to 3 req/s without an API key (10 req/s with NCBI_API_KEY).
 */
import { XMLParser } from "fast-xml-parser";
import { RateLimiter } from "../util/rate-limit.js";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export interface PubMedPaper {
  pmid: string;
  title: string;
  abstract: string;
  year: number | null;
  authors_string: string;
  journal: string;
}

const apiKey = process.env.NCBI_API_KEY?.trim() || undefined;
// 3 req/s anonymous -> ~350ms spacing; 10 req/s with key -> ~110ms.
const limiter = new RateLimiter(apiKey ? 110 : 350);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function plainText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join(" ");
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const parts: string[] = [];
    if (obj["#text"] != null) parts.push(String(obj["#text"]));
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("@_") || k === "#text") continue;
      parts.push(plainText(v));
    }
    return parts.join(" ");
  }
  return "";
}

export async function searchPubMed(
  query: string,
  maxResults = 10,
): Promise<PubMedPaper[]> {
  const retmax = Math.min(Math.max(maxResults, 1), 25);

  await limiter.wait();
  const esearchUrl = new URL(`${EUTILS}/esearch.fcgi`);
  esearchUrl.searchParams.set("db", "pubmed");
  esearchUrl.searchParams.set("term", query);
  esearchUrl.searchParams.set("retmax", String(retmax));
  esearchUrl.searchParams.set("retmode", "json");
  if (apiKey) esearchUrl.searchParams.set("api_key", apiKey);

  const esearchResp = await fetch(esearchUrl, {
    headers: { "User-Agent": "lit-synth-mvp/0.1" },
  });
  if (!esearchResp.ok) {
    throw new Error(`PubMed esearch failed: HTTP ${esearchResp.status}`);
  }
  const esearchJson = (await esearchResp.json()) as {
    esearchresult?: { idlist?: string[] };
  };
  const ids = esearchJson.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  await limiter.wait();
  const efetchUrl = new URL(`${EUTILS}/efetch.fcgi`);
  efetchUrl.searchParams.set("db", "pubmed");
  efetchUrl.searchParams.set("id", ids.join(","));
  efetchUrl.searchParams.set("retmode", "xml");
  if (apiKey) efetchUrl.searchParams.set("api_key", apiKey);

  const efetchResp = await fetch(efetchUrl, {
    headers: { "User-Agent": "lit-synth-mvp/0.1" },
  });
  if (!efetchResp.ok) {
    throw new Error(`PubMed efetch failed: HTTP ${efetchResp.status}`);
  }
  const doc = xml.parse(await efetchResp.text());

  const articles = toArray(
    doc?.PubmedArticleSet?.PubmedArticle as unknown,
  );
  const papers: PubMedPaper[] = [];

  for (const art of articles) {
    const a = art as Record<string, any>;
    const citation = a?.MedlineCitation;
    const article = citation?.Article;
    if (!article) continue;

    const pmid = String(
      typeof citation.PMID === "object"
        ? citation.PMID["#text"]
        : citation.PMID,
    );
    const title = plainText(article.ArticleTitle).trim();

    const abstractParts = toArray(article.Abstract?.AbstractText);
    const abstract = abstractParts.map(plainText).join(" ").trim();

    const authors = toArray(article.AuthorList?.Author)
      .map((au: any) => {
        const last = au?.LastName ?? "";
        const initials = au?.Initials ?? "";
        const collective = au?.CollectiveName;
        if (collective) return plainText(collective);
        return `${last}${initials ? " " + initials : ""}`.trim();
      })
      .filter(Boolean);
    const authors_string =
      authors.length > 3
        ? `${authors.slice(0, 3).join(", ")}, et al.`
        : authors.join(", ");

    const yearRaw =
      article.Journal?.JournalIssue?.PubDate?.Year ??
      citation?.DateCompleted?.Year ??
      null;
    const year = yearRaw ? Number(String(yearRaw).slice(0, 4)) : null;

    const journal =
      plainText(article.Journal?.Title) ||
      plainText(article.Journal?.ISOAbbreviation) ||
      "";

    papers.push({
      pmid,
      title,
      abstract,
      year: Number.isFinite(year) ? year : null,
      authors_string,
      journal,
    });
  }

  return papers;
}

export function pubmedUrl(pmid: string): string {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}

/**
 * Lightweight esearch — returns just the total hit count (and optionally the
 * top N PMIDs). One HTTP request, no efetch. Used by the screen agent to
 * count compound-in-organism hits cheaply.
 */
export async function pubmedCount(
  query: string,
  retmax = 0,
): Promise<{ count: number; pmids: string[] }> {
  await limiter.wait();
  const url = new URL(`${EUTILS}/esearch.fcgi`);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(Math.max(0, Math.min(retmax, 25))));
  url.searchParams.set("retmode", "json");
  if (apiKey) url.searchParams.set("api_key", apiKey);

  const resp = await fetch(url, {
    headers: { "User-Agent": "lit-synth-mvp/0.1" },
  });
  if (!resp.ok) {
    throw new Error(`PubMed esearch failed: HTTP ${resp.status}`);
  }
  const j = (await resp.json()) as {
    esearchresult?: { count?: string; idlist?: string[] };
  };
  return {
    count: Number(j.esearchresult?.count ?? 0) || 0,
    pmids: j.esearchresult?.idlist ?? [],
  };
}
