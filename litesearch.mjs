#!/usr/bin/env node
/**
 * Lean literature search tool. Returns COMPACT hits — {pmid, title, year, journal}
 * only — so the agent reads ~10x fewer tokens than raw esummary / Europe PMC "core".
 * For PubMed it does esearch + esummary in ONE call (titles included), saving a round-trip.
 *
 *   node litesearch.mjs --db pubmed     --query 'sambunigrin AND (Sambucus OR elderberry)' [--n 6]
 *   node litesearch.mjs --db europepmc  --query '"betulalbuside" AND elderberry' [--n 6]
 *
 * Output: { db, query, hitCount, hits:[{pmid,title,year,journal}] }
 */
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
}
if (!args.query) { console.error('usage: litesearch.mjs --db pubmed|europepmc --query "<query>" [--n 6]'); process.exit(1); }
const db = args.db === "europepmc" ? "europepmc" : "pubmed";
const N = Math.min(Number(args.n) || 6, 10);
const UA = "elderberry-lit-synth/1.0 (research; jackli2046@gmail.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) { await sleep(500 * (t + 1)); continue; }
      if (!r.ok) return { __status: r.status };
      return await r.json();
    } catch (e) { if (t === tries - 1) return { __error: String((e && e.message) || e) }; await sleep(400 * (t + 1)); }
  }
  return { __error: "exhausted" };
}
const yr = (s) => (String(s || "").match(/\d{4}/) || ["n.d."])[0];

let result;
if (db === "pubmed") {
  const es = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${N}&term=${encodeURIComponent(args.query)}`);
  const ids = es?.esearchresult?.idlist || [];
  const hitCount = Number(es?.esearchresult?.count || ids.length);
  let hits = [];
  if (ids.length) {
    await sleep(150);
    const su = await getJSON(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`);
    const res = su?.result || {};
    hits = ids.map((id) => res[id]).filter(Boolean).map((r) => ({ pmid: r.uid, title: (r.title || "").replace(/\s*\.\s*$/, ""), year: yr(r.pubdate), journal: r.source || "" }));
  }
  result = { db, query: args.query, hitCount, hits };
} else {
  // resultType=lite is far smaller than core; we only need id/title/year/journal
  const j = await getJSON(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=lite&pageSize=${N}&query=${encodeURIComponent(args.query)}`);
  const list = j?.resultList?.result || [];
  const hits = list.filter((r) => r.pmid).map((r) => ({ pmid: r.pmid, title: (r.title || "").replace(/\s*\.\s*$/, ""), year: yr(r.pubYear), journal: r.journalTitle || "" }));
  result = { db, query: args.query, hitCount: j?.hitCount ?? hits.length, hits };
}
console.log(JSON.stringify(result, null, 2));
