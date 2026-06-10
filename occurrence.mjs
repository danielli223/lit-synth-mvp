#!/usr/bin/env node
/**
 * Gather structured occurrence EVIDENCE for one compound. Does NOT decide the
 * answer — it only collects and lightly classifies facts so Claude can reason.
 *
 *   PubChem   : name -> CID, InChIKey, formula, synonym count   (identity)
 *   LOTUS      : InChIKey -> organisms it is documented in (via Wikidata)   (occurrence)
 *   Europe PMC : full-text hit counts at elderberry / berry / plant scope    (literature depth)
 *
 * Output is JSON evidence. LOTUS occurrence is reported, never used to skip the
 * reasoned paragraph downstream — a hit is evidence, not a verdict.
 *
 *   node occurrence.mjs --name "Cyanidin 3-O-glucoside" [--formula C21H21O11] [--json]
 *
 * Every source is independently fault-tolerant: a failure yields a null/empty
 * block and an `errors` note, never a non-zero exit, so a batch run never dies
 * on one compound.
 */

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[key] = next; i++; }
  else args[key] = true;
}
if (!args.name) {
  console.error('Usage: occurrence.mjs --name "<compound>" [--formula <formula>]');
  process.exit(1);
}

const UA = "elderberry-lit-synth/1.0 (research; jackli2046@gmail.com)";
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, opts = {}, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) } });
      if (r.status === 429 || r.status >= 500) { await sleep(500 * (t + 1)); continue; }
      if (!r.ok) return { __status: r.status };
      return await r.json();
    } catch (e) {
      if (t === tries - 1) return { __error: String(e && e.message || e) };
      await sleep(400 * (t + 1));
    }
  }
  return { __error: "exhausted retries" };
}

// ---- Berry genera (scientific genus -> elderberry vs other-berry classification of LOTUS organisms) ----
// Sambucus is the elderberry tier itself. The rest are curated edible-berry genera.
const SAMBUCUS = new Set(["sambucus"]);
const BERRY_GENERA = new Set([
  "vaccinium", "ribes", "vitis", "lycium", "physalis", "berberis", "mahonia",
  "shepherdia", "myrciaria", "plinia", "lonicera", "fragaria", "rubus", "morus",
  "empetrum", "amelanchier", "hippophae", "aronia", "schisandra", "schizandra",
  "sorbus", "gaylussacia", "elaeagnus", "hylocereus", "selenicereus", "euterpe",
  "aristotelia",
]);
const genusOf = (taxon) => String(taxon || "").trim().split(/\s+/)[0].toLowerCase();

// ---------- 1. PubChem: identity ----------
async function pubchem(name) {
  const base = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound";
  const cids = await getJSON(`${base}/name/${encodeURIComponent(name)}/cids/JSON`);
  const cid = cids?.IdentifierList?.CID?.[0];
  if (!cid) { if (cids?.__error) errors.push("pubchem:" + cids.__error); return null; }
  const props = await getJSON(`${base}/cid/${cid}/property/InChIKey,MolecularFormula,IUPACName/JSON`);
  const p = props?.PropertyTable?.Properties?.[0] || {};
  return { cid, inchikey: p.InChIKey || null, formula: p.MolecularFormula || null, iupac_name: p.IUPACName || null };
}

// ---------- 2. LOTUS via Wikidata: organisms a compound is documented in ----------
const sparqlEsc = (s) => String(s).replace(/["\\]/g, "\\$&");          // neutralize quotes/backslashes in SPARQL string literals
const INCHIKEY_RE = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;                      // standard InChIKey shape; only trust well-formed keys
const TAXA_LIMIT = 1000;

async function lotus({ inchikey, name }) {
  // `sel` is the graph pattern that binds ?compound. InChIKey is the reliable
  // structural match; fall back to the English label.
  const runTaxa = async (sel, extra = "", limit = TAXA_LIMIT) => {
    const q = `SELECT DISTINCT ?taxonName WHERE { ${sel} ?compound wdt:P703 ?taxon . ?taxon wdt:P225 ?taxonName . ${extra} } LIMIT ${limit}`;
    const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q);
    const j = await getJSON(url, { headers: { Accept: "application/sparql-results+json" } });
    if (!j?.results?.bindings) { if (j?.__error || j?.__status) errors.push("lotus:" + (j.__error || j.__status)); return null; }
    return [...new Set(j.results.bindings.map((b) => b.taxonName?.value).filter(Boolean))];
  };

  const labelSel = `?compound rdfs:label "${sparqlEsc(name)}"@en .`;
  let sel = inchikey && INCHIKEY_RE.test(inchikey) ? `?compound wdt:P235 "${inchikey}" .` : null;
  let taxa = sel ? await runTaxa(sel) : null;
  if (!taxa || taxa.length === 0) {                                    // no inchikey match -> try the label
    const byLabel = await runTaxa(labelSel);
    if (byLabel && byLabel.length) { sel = labelSel; taxa = byLabel; }
  }
  if (!sel || !taxa) return { matched: false, in_sambucus: false, sambucus_species: [], in_other_berry: false, berry_genera: [], n_other_organisms: 0 };

  const truncated = taxa.length >= TAXA_LIMIT;
  // Truncation-proof Sambucus check: a dedicated, name-filtered query that can
  // never be hidden past the LIMIT, so in_sambucus is authoritative even for
  // ubiquitous compounds documented in 1000+ organisms.
  const samb = (await runTaxa(sel, `FILTER(STRSTARTS(?taxonName, "Sambucus"))`, 50)) || taxa.filter((t) => SAMBUCUS.has(genusOf(t)));
  const sambucus_species = [...new Set(samb)];
  const berryHits = taxa.filter((t) => BERRY_GENERA.has(genusOf(t)));
  const berry_genera = [...new Set(berryHits.map((t) => genusOf(t)))];
  const others = taxa.filter((t) => !SAMBUCUS.has(genusOf(t)) && !BERRY_GENERA.has(genusOf(t)));
  return {
    matched: taxa.length > 0,
    n_taxa: taxa.length,
    truncated,                                                         // berry/other classification may be partial when true
    in_sambucus: sambucus_species.length > 0,
    sambucus_species,
    in_other_berry: berryHits.length > 0,
    berry_genera,
    berry_examples: [...new Set(berryHits)].slice(0, 8),
    n_other_organisms: others.length,
    other_examples: others.slice(0, 12),
  };
}

// ---------- 3. Europe PMC: full-text literature depth at three scopes ----------
async function europepmc(name) {
  const q = (extra) => `"${String(name).replace(/"/g, '\\"')}" AND (${extra})`;
  const search = async (extra) => {
    const url = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=4&query=" + encodeURIComponent(q(extra));
    const j = await getJSON(url);
    if (j?.hitCount == null) { if (j?.__error || j?.__status) errors.push("europepmc:" + (j.__error || j.__status)); return null; }
    return {
      hitCount: j.hitCount,
      top: (j.resultList?.result || []).slice(0, 4).map((r) => ({
        pmid: r.pmid || null, pmcid: r.pmcid || null, doi: r.doi || null,
        title: r.title || null, year: r.pubYear || null, source: r.source || null,
        isOpenAccess: r.isOpenAccess === "Y",
      })),
    };
  };
  const [elderberry, berries, plants] = await Promise.all([
    search("Sambucus OR elderberry"),
    search("blueberry OR cranberry OR grape OR blackcurrant OR raspberry OR berry"),
    search("plant OR fruit OR leaf OR phytochemical OR botanical"),
  ]);
  return { elderberry, berries, plants };
}

// ---------- run (sources are independent; identity feeds occurrence) ----------
const pc = await pubchem(args.name);
const [lo, epmc] = await Promise.all([
  lotus({ inchikey: pc?.inchikey, name: args.name }),
  europepmc(args.name),
]);

const out = {
  query: { name: args.name, formula: args.formula || pc?.formula || null },
  pubchem: pc,
  lotus: lo,
  europepmc: epmc,
  errors: errors.length ? errors : undefined,
  note: "Evidence only. LOTUS occurrence does NOT decide inclusion or replace the reasoned paragraph — every compound is still reasoned and reported.",
};
console.log(JSON.stringify(out, null, 2));
