#!/usr/bin/env node
/**
 * Fetch PubMed ABSTRACTS for given PMIDs, so an agent judges occurrence from the
 * actual abstract text — not just the title. Returns compact {pmid -> "title — abstract"}.
 * Pulls <ArticleTitle> + <AbstractText> from the XML (skips author/affiliation noise).
 *   node abstract.mjs --pmids 10854744,27734518
 * Uses the NCBI API key (env NCBI_API_KEY or ~/.ncbi_api_key) when present.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const KEYV = process.env.NCBI_API_KEY || (() => { try { return readFileSync(homedir() + "/.ncbi_api_key", "utf8").trim(); } catch { return ""; } })();
const KEY = KEYV ? `&api_key=${KEYV}` : "";
const UA = "elderberry-lit-synth/1.0 (research; jackli2046@gmail.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const idx = process.argv.indexOf("--pmids");
if (idx === -1 || !process.argv[idx + 1]) { console.error('usage: abstract.mjs --pmids 12345,67890'); process.exit(1); }
const pmids = process.argv[idx + 1].split(/[,\s]+/).filter(Boolean).slice(0, 12);

async function getText(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(400 * (t + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch { if (t === tries - 1) return null; await sleep(300 * (t + 1)); }
  }
  return null;
}
const strip = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#x?[0-9a-f]+;/gi, "").replace(/\s+/g, " ").trim();

const out = {};
for (const pmid of pmids) {
  const xml = await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml&rettype=abstract${KEY}`);
  if (!xml) { out[pmid] = "(abstract unavailable)"; await sleep(120); continue; }
  const title = strip((xml.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/) || [])[1]);
  const parts = [...xml.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => strip(m[1]));
  const abstract = parts.join(" ");
  out[pmid] = (title + (abstract ? " — " + abstract : " — (no abstract on record)")).slice(0, 1600);
  await sleep(120);
}
console.log(JSON.stringify(out, null, 2));
