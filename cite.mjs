#!/usr/bin/env node
/**
 * Resolve PubMed PMIDs to VERBATIM bibliographic metadata via NCBI esummary.
 * The model never writes authors/year/title/journal — it only chooses a PMID +
 * role; this tool supplies the metadata from the API, so it cannot be wrong, and
 * any PMID that does not resolve is reported as found:false (caught, not cited).
 *
 *   node cite.mjs --pmids 27484408,10854744        # -> JSON map pmid -> meta
 *   import { fetchPubmedMeta } from "./cite.mjs"     # -> async (pmids[]) => map
 */
import process from "node:process";

const UA = "elderberry-lit-synth/1.0 (research; jackli2046@gmail.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (t + 1)); continue; }
      if (!r.ok) return { __status: r.status };
      return await r.json();
    } catch (e) {
      if (t === tries - 1) return { __error: String((e && e.message) || e) };
      await sleep(500 * (t + 1));
    }
  }
  return { __error: "exhausted retries" };
}

function fmtAuthors(list) {
  const names = (list || [])
    .filter((a) => !a.authtype || a.authtype === "Author")
    // strip footnote/affiliation markers NCBI sometimes leaks into the name (e.g. "Ebinger1a JE");
    // author surnames never contain digits, so a digit-run after a letter is an artifact.
    .map((a) => String(a.name || "").replace(/([A-Za-z])\d+[a-z]?/g, "$1").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!names.length) return "[authors not listed]";
  return names.length > 8 ? names.slice(0, 8).join(", ") + ", et al." : names.join(", ");
}

/**
 * @param {string[]} pmids
 * @returns {Promise<Record<string,{found:boolean, authors?:string, year?:string, title?:string, journal?:string}>>}
 */
export async function fetchPubmedMeta(pmids) {
  const uniq = [...new Set((pmids || []).filter(Boolean).map(String).map((s) => s.trim()))];
  const out = {};
  const CHUNK = 150;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const ids = uniq.slice(i, i + CHUNK);
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
    const j = await getJSON(url);
    const res = (j && j.result) || {};
    for (const id of ids) {
      const r = res[id];
      if (!r || r.error || (!r.title && !r.authors)) { out[id] = { found: false }; continue; }
      const year = String(r.pubdate || r.sortpubdate || r.epubdate || "").match(/\d{4}/);
      out[id] = {
        found: true,
        authors: fmtAuthors(r.authors),
        year: year ? year[0] : "n.d.",
        title: String(r.title || "").replace(/\s*\.\s*$/, ""),
        journal: r.source || r.fulljournalname || "",
      };
    }
    if (i + CHUNK < uniq.length) await sleep(380); // respect eutils ~3 req/s
  }
  return out;
}

// ---- CLI ----
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const idx = process.argv.indexOf("--pmids");
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error('Usage: cite.mjs --pmids "27484408,10854744"');
    process.exit(1);
  }
  const pmids = process.argv[idx + 1].split(/[,\s]+/).filter(Boolean);
  const meta = await fetchPubmedMeta(pmids);
  console.log(JSON.stringify(meta, null, 2));
}
