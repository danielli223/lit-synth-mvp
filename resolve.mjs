#!/usr/bin/env node
/**
 * Deterministic PRE-PASS (no model tokens): resolve PubChem identity + LOTUS
 * occurrence for every compound and emit COMPACT JSON the agent can read cheaply.
 * Offloads identity/occurrence so the agent only spends tokens on literature + reasoning.
 *
 *   node resolve.mjs --in compounds.json --out identities.json
 *   compounds.json = [{ "uid":1, "name":"...", "formula":"..." }, ...]
 *
 * Per compound it returns: identity {cid, inchikey, formula, clean_names[<=8]} and
 * lotus {in_sambucus, sambucus_species, berry_genera, n_other_plant, other_examples, qid}.
 * Every source is fault-tolerant: a failure yields nulls, never a non-zero exit.
 */
import fs from "node:fs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
}
if (!args.in || !args.out) { console.error("usage: resolve.mjs --in compounds.json --out identities.json"); process.exit(1); }

const UA = "elderberry-lit-synth/1.0 (research; jackli2046@gmail.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, opts = {}, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) } });
      if (r.status === 429 || r.status >= 500) { await sleep(500 * (t + 1)); continue; }
      if (!r.ok) return { __status: r.status };
      return await r.json();
    } catch (e) { if (t === tries - 1) return { __error: String((e && e.message) || e) }; await sleep(400 * (t + 1)); }
  }
  return { __error: "exhausted" };
}

// ---- name cleaning (deterministic; the agent only re-tries the ones this misses) ----
function nameCandidates(raw) {
  const out = [];
  const push = (s) => { s = (s || "").trim().replace(/\s+/g, " "); if (s && !out.includes(s)) out.push(s); };
  push(raw);
  const trail = raw.match(/\(([^()]+)\)\s*$/); if (trail) push(trail[1]);
  let s = raw.replace(/^\([^)]*[0-9RSEZ±+\-][^)]*\)-?\s*/i, "");
  s = s.replace(/^(?:DL|D|L|rac|RS)-\s*/i, "");
  push(s);
  push(s.replace(/(\d+)\((\d+)\)/g, "$1,$2"));
  push(raw.replace(/\s*\([^()]*\)\s*$/, ""));
  if (raw.includes("/")) raw.split("/").forEach(push);
  const tok = s.match(/([A-Za-z][A-Za-z0-9-]{3,})\s*$/); if (tok) push(tok[1]);
  return out;
}
const CAS_RE = /^\d{1,7}-\d{2}-\d$/;
const digitRatio = (s) => s.replace(/[^0-9]/g, "").length / Math.max(1, s.length);
const isGoodName = (s) => !!s && s.length >= 4 && s.length <= 40 && !CAS_RE.test(s)
  && !/^InChI|^[A-Z]{14}-[A-Z]{10}/.test(s) && (/[a-z]/.test(s) || s.length >= 5);
function cleanNames(synonyms, matched, raw) {
  const cand = [matched, ...(synonyms || [])].filter((x) => isGoodName(x) && /[A-Za-z]/.test(x));
  const uniq = [...new Set(cand)];
  uniq.sort((a, b) => digitRatio(a) - digitRatio(b) || a.length - b.length);
  if (!uniq.length) uniq.push(matched || raw);
  return uniq.slice(0, 8);
}

const SAMBUCUS = new Set(["sambucus"]);
const BERRY_GENERA = new Set(["vaccinium","ribes","vitis","lycium","physalis","berberis","mahonia","shepherdia","myrciaria","plinia","lonicera","fragaria","rubus","morus","empetrum","amelanchier","hippophae","aronia","schisandra","schizandra","sorbus","gaylussacia","elaeagnus","hylocereus","selenicereus","euterpe","aristotelia"]);
const genusOf = (t) => String(t || "").trim().split(/\s+/)[0].toLowerCase();

async function pubchem(name) {
  const base = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound";
  let cid = null, matched = null;
  for (const cand of nameCandidates(name)) {
    const cids = await getJSON(`${base}/name/${encodeURIComponent(cand)}/cids/JSON`);
    if (cids?.IdentifierList?.CID?.[0]) { cid = cids.IdentifierList.CID[0]; matched = cand; break; }
  }
  if (!cid) return { cid: null, inchikey: null, formula: null, clean_names: [name] };
  const props = await getJSON(`${base}/cid/${cid}/property/InChIKey,MolecularFormula,IUPACName/JSON`);
  const p = props?.PropertyTable?.Properties?.[0] || {};
  const syn = await getJSON(`${base}/cid/${cid}/synonyms/JSON`);
  const synonyms = syn?.InformationList?.Information?.[0]?.Synonym || [];
  return { cid: String(cid), inchikey: p.InChIKey || null, formula: p.MolecularFormula || null, clean_names: cleanNames(synonyms, matched, name) };
}

const INCHIKEY_RE = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;
async function lotus({ inchikey, name }) {
  const sparql = (q) => "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q);
  const runTaxa = async (sel, extra = "", limit = 1000) => {
    const j = await getJSON(sparql(`SELECT DISTINCT ?taxonName WHERE { ${sel} ?compound wdt:P703 ?taxon . ?taxon wdt:P225 ?taxonName . ${extra} } LIMIT ${limit}`), { headers: { Accept: "application/sparql-results+json" } });
    if (!j?.results?.bindings) return null;
    return [...new Set(j.results.bindings.map((b) => b.taxonName?.value).filter(Boolean))];
  };
  const sel = inchikey && INCHIKEY_RE.test(inchikey) ? `?compound wdt:P235 "${inchikey}" .` : (name ? `?compound rdfs:label "${String(name).replace(/["\\]/g, "\\$&")}"@en .` : null);
  if (!sel) return { matched: false, in_sambucus: false, sambucus_species: [], berry_genera: [], n_other_plant: 0, other_examples: [], qid: null };
  const taxa = (await runTaxa(sel)) || [];
  let qid = null;
  const qj = await getJSON(sparql(`SELECT ?compound WHERE { ${sel} } LIMIT 1`), { headers: { Accept: "application/sparql-results+json" } });
  const uri = qj?.results?.bindings?.[0]?.compound?.value; if (uri) qid = uri.split("/").pop();
  const samb = (await runTaxa(sel, `FILTER(STRSTARTS(?taxonName, "Sambucus"))`, 50)) || taxa.filter((t) => SAMBUCUS.has(genusOf(t)));
  const berry = taxa.filter((t) => BERRY_GENERA.has(genusOf(t)));
  const others = taxa.filter((t) => !SAMBUCUS.has(genusOf(t)) && !BERRY_GENERA.has(genusOf(t)));
  return {
    matched: taxa.length > 0,
    n_taxa: taxa.length,
    truncated: taxa.length >= 1000,
    in_sambucus: samb.length > 0,
    sambucus_species: [...new Set(samb)].slice(0, 4),
    berry_genera: [...new Set(berry.map(genusOf))],
    n_other_plant: others.length,
    other_examples: others.slice(0, 6),
    qid,
  };
}

// Normalize a molecular formula for comparison ("C18 H34 O4" -> "C18H34O4").
const normF = (f) => String(f || "").replace(/\s+/g, "").toUpperCase();

const compounds = JSON.parse(fs.readFileSync(args.in, "utf8"));
const out = [];
for (const c of compounds) {
  let id = await pubchem(c.name);
  // TRUST GUARD: only believe a deterministic resolution when the resolved formula
  // matches the given one. Hard systematic names resolve to the WRONG molecule
  // (e.g. "...triol" -> trichloroethylene), so a formula mismatch = do-not-trust.
  const formulaMatch = !!(id.formula && c.formula && normF(id.formula) === normF(c.formula));
  const identityOk = !!id.cid && formulaMatch;
  // Skip the LOTUS call entirely for an untrusted identity (it would return the wrong
  // compound's organisms). Only look up occurrence once identity is trusted.
  let lo = identityOk
    ? await lotus({ inchikey: id.inchikey, name: id.clean_names?.[0] })
    : { matched: false, n_taxa: 0, in_sambucus: false, sambucus_species: [], berry_genera: [], n_other_plant: 0, other_examples: [], qid: null };

  // Two INDEPENDENT signals (do NOT conflate):
  //  - needs_identity: identity is wrong/missing -> the agent must re-resolve it.
  //  - lotus_found: whether a curated occurrence record exists. Identity-fine-but-LOTUS-empty
  //    is common for real compounds; the agent then digs occurrence from the literature
  //    instead of pointlessly re-resolving a correct identity.
  const needs_identity = !identityOk;
  const note = !id.cid ? "no PubChem CID" : !formulaMatch ? `formula mismatch (resolved ${id.formula} != given ${c.formula})` : "identity verified";
  if (needs_identity) id = { cid: null, inchikey: null, formula: null, clean_names: [c.name] };

  out.push({ uid: c.uid, name: c.name, formula: c.formula, needs_identity, lotus_found: lo.matched, resolve_note: note, identity: id, lotus: lo });
  process.stderr.write(`uid ${c.uid}: ${needs_identity ? "RE-RESOLVE (" + note + ")" : "verified CID " + id.cid}${lo.matched ? (lo.in_sambucus ? " · LOTUS:Sambucus" : " · LOTUS:" + lo.n_taxa + "taxa") : " · LOTUS:none"}\n`);
  await sleep(250);
}
fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
const na = out.filter((o) => o.needs_identity).length;
console.log(`wrote ${args.out} (${out.length} compounds; ${out.length - na} identity-verified, ${na} need re-resolution)`);
