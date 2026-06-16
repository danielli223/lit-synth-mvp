#!/usr/bin/env node
/**
 * Render the agentic results to ONE self-contained CSV: one row per compound, with
 * every repeating field collapsed into a single cell (References one-per-line, Names
 * considered joined by " | ", Search queries one-per-line). Nothing is lost. The two-axis
 * verdict leads — "Documented occurrence (lit.)" (the most specific tier the retrieved
 * literature cites the compound occurring in — NOT verified ground truth) and "What this
 * detection is" (disposition) — then "Occurrence basis (LOTUS/Wikidata)", which holds ONLY
 * the curated occurrence_basis record (paper citations stay in References). Rows grouped by
 * tier; References also list the LOTUS/Wikidata record. (Mirrors gen-xlsx.mjs.)
 *   node gen-csv.mjs <workflow-output.json> <out.csv>
 * (CSV holds no row-height/wrap — for the formatted look open the matching .xlsx.)
 */
import fs from "node:fs";
import { fetchPubmedMeta } from "./cite.mjs";
import { effectiveTier } from "./tier.mjs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: gen-csv.mjs <in.json> <out.csv>"); process.exit(1); }
const results = (() => { const r = JSON.parse(fs.readFileSync(inPath, "utf8")); return (r.result || r).slice(); })();

const TIERS = [
  ["elderberry", "Elderberry"], ["other_berry", "Other berry"], ["other_plant", "Other plant"],
  ["non_plant", "Non-plant"], ["unknown", "Source not established"],
];
const TIER_LABEL = Object.fromEntries(TIERS);
const TIER_RANK = Object.fromEntries(TIERS.map(([k], i) => [k, i]));
const dispLabel = (d) => ({
  native_plausible: "native — plausibly belongs", oxidation_processing: "oxidation / processing artifact",
  synthetic_contaminant: "synthetic — contaminant / carry-over", misannotation: "misannotation",
  identity_unresolved: "identity unresolved", undetermined: "undetermined (native vs. artifact)",
}[d] || d);
const effective = effectiveTier; // shared occurrence invariant (tier.mjs) — same across all renderers

const META = await fetchPubmedMeta(results.flatMap((r) => (r.citations || []).filter((c) => c.type === "pubmed").map((c) => c.id)));
const ROLE_ORDER = { occurrence: 0, identity: 1, context: 2 };
const isDropped = (c) => c.type === "pubmed" && !(META[String(c.id)] && META[String(c.id)].found);
const lotusRef = (qid) => `LOTUS Natural Products Database (Wikidata ${qid}). https://www.wikidata.org/wiki/${qid}`;
const refText = (c) => {
  if (c.type === "pubmed") { const m = META[String(c.id)]; if (!m || !m.found) return null; const j = m.journal ? ` ${m.journal}.` : ""; return `${m.authors} (${m.year}). ${m.title}.${j} https://pubmed.ncbi.nlm.nih.gov/${c.id}/`; }
  if (c.type === "pubchem") return `PubChem Compound Summary, CID ${c.id}. https://pubchem.ncbi.nlm.nih.gov/compound/${c.id}`;
  if (c.type === "lotus") return lotusRef(c.id);
  return String(c.id);
};
// ONE consolidated LOTUS reference line carrying the curated taxa (from occurrence_basis)
// + the Wikidata link, so the occurrence record lives in References (no separate column).
const lotusLine = (r) => {
  const cite = (r.citations || []).find((c) => c.type === "lotus" && !isDropped(c));
  const qid = (cite && cite.id) || (String(r.occurrence_basis || "").match(/Q\d{4,}/) || [])[0];
  if (!qid) return null;
  const url = `https://www.wikidata.org/wiki/${qid}`;
  const basis = String(r.occurrence_basis || "").trim();
  if (basis) return basis.includes(url) ? basis : `${basis}. ${url}`;
  return `LOTUS Natural Products Database (Wikidata ${qid})${cite && cite.note ? `: ${cite.note}` : ""}. ${url}`;
};
const refs = (r) => {
  const papers = (r.citations || [])
    .filter((c) => !isDropped(c) && c.type !== "lotus")
    .slice().sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9))
    .map(refText).filter(Boolean);
  const ll = lotusLine(r);
  const lines = ll ? [ll, ...papers] : papers; // occurrence record first
  return lines.map((t, i) => `${i + 1}. ${t}`).join("\n");
};
const namesJoined = (r) => (r.identity?.names_considered || []).join(" | ");
const traceJoined = (r) => (r.search_trace || [])
  .map((s) => `[${s.db}] ${s.query} — ${s.n_hits} hits${(s.kept_pmids || []).length ? `; kept ${s.kept_pmids.join(",")}` : ""}`)
  .join("\n");

for (const r of results) r._eff = effective(r);
results.sort((a, b) => (TIER_RANK[a._eff.tier] - TIER_RANK[b._eff.tier]) || a.name.localeCompare(b.name));

const rows = results.map((r) => ({
  "Name": r.name,
  "Formula": r.formula,
  "Documented occurrence (lit.)": TIER_LABEL[r._eff.tier],
  "What this detection is": dispLabel(r.disposition),
  "What it is": r.what_it_is,
  "Where it's been reported": r.where_reported,
  "Could it be in elderberry?": r.assessment,
  "PubChem CID": r.identity?.cid || "",
  "InChIKey": r.identity?.inchikey || "",
  "Names considered": namesJoined(r),
  "References": refs(r),
  "Search queries": traceJoined(r),
}));

const cell = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const cols = Object.keys(rows[0]);
const csv = [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
fs.writeFileSync(outPath, csv);
console.log(`wrote ${outPath} (${rows.length} compounds, ${cols.length} columns)`);
