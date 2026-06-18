#!/usr/bin/env node
/**
 * Render the agentic results to a PRE-FORMATTED .xlsx with ALL per-compound data.
 * The two-axis verdict leads — "Documented occurrence (lit.)" (the most specific tier the
 * retrieved literature/databases cite the compound occurring in — NOT verified ground truth)
 * and "What this detection is" (detection disposition) — then "Occurrence basis (LOTUS/Wikidata)",
 * which holds ONLY the curated occurrence_basis record (paper citations stay in References).
 * Set column widths, wrapped text, bold frozen header (top row + Name column), and per-row
 * heights sized to the content (so rows are tall enough to show the wrapped text). Rows
 * grouped by tier; References also list the LOTUS/Wikidata record.
 *   node gen-xlsx.mjs <workflow-output.json> <out.xlsx>
 */
import fs from "node:fs";
import ExcelJS from "exceljs";
import { fetchPubmedMeta } from "./cite.mjs";
import { effectiveTier } from "./tier.mjs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: gen-xlsx.mjs <in.json> <out.xlsx>"); process.exit(1); }
const results = (() => { const r = JSON.parse(fs.readFileSync(inPath, "utf8")); return (r.result || r).slice(); })();

const TIERS = [
  ["elderberry", "Elderberry"], ["other_berry", "Other berry"], ["other_plant", "Other plant"],
  ["non_plant", "Non-plant"], ["unknown", "No documented occurrence"],
];
const TIER_LABEL = Object.fromEntries(TIERS);
const TIER_RANK = Object.fromEntries(TIERS.map(([k], i) => [k, i]));
const dispLabel = (d) => ({
  native_plausible: "native — plausibly belongs", oxidation_processing: "oxidation / processing artifact",
  synthetic_contaminant: "synthetic — contaminant / carry-over",
  foreign: "foreign — shouldn't be in elderberry", misannotation: "foreign — shouldn't be in elderberry", // legacy alias
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

const wb = new ExcelJS.Workbook();

// "How to read" legend tab (first sheet) — explains the method and columns C/D/F/G.
const guide = wb.addWorksheet("How to read");
guide.getColumn(1).width = 112;
const guideLines = [
  ["How to read this report", true],
  ["", false],
  ["For each compound, an AI agent looks it up in three databases: PubChem (what the molecule is), LOTUS/Wikidata (which plants and animals it's been found in), and PubMed/Europe PMC (published papers). Every claim links back to a real source, never made up. It then fills four columns:", false],
  ["", false],
  ["C — Documented occurrence: a label for where it's been found in nature (elderberry → other berry → other plant → non-plant → unknown), only allowed if a real paper or database record backs it.", false],
  ["F — Where it's been reported: the plain-text version of that evidence, the actual plants and papers behind C.", false],
  ["D — What this detection is: a separate call on the peak itself — is it a genuine elderberry compound, or not? It can be native (plausibly belongs), an oxidation/processing artifact, a synthetic contaminant, or foreign (shouldn't be in elderberry at all, when it can't be pinned to contaminant vs. artifact). Judged from chemistry, since the AI never sees the raw machine data.", false],
  ["G — Could it be in elderberry? A short paragraph combining C and D into a final answer.", false],
  ["", false],
  ["How they relate: C and D are the two facts (where it occurs × what this peak is), F is the evidence behind C, and G is the conclusion that ties C and D together.", false],
];
for (const [text, bold] of guideLines) {
  const row = guide.addRow([text]);
  row.getCell(1).alignment = { wrapText: true, vertical: "top" };
  row.getCell(1).font = bold ? { bold: true, size: 14 } : { size: 11 };
  row.height = bold ? 22 : Math.max(16, Math.ceil(String(text).length / 105) * 15);
}

const ws = wb.addWorksheet("Compounds", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
ws.columns = [
  { header: "Name", key: "name", width: 26 },
  { header: "Formula", key: "formula", width: 12 },
  { header: "Documented occurrence (lit.)", key: "tier", width: 22 },
  { header: "What this detection is", key: "disp", width: 24 },
  { header: "What it is", key: "what", width: 40 },
  { header: "Where it's been reported", key: "where", width: 46 },
  { header: "Could it be in elderberry?", key: "assess", width: 46 },
  { header: "PubChem CID", key: "cid", width: 12 },
  { header: "InChIKey", key: "inchikey", width: 28 },
  { header: "Names considered", key: "names", width: 40 },
  { header: "References", key: "refs", width: 70 },
  { header: "Search queries", key: "trace", width: 60 },
];

const hdr = ws.getRow(1);
hdr.font = { bold: true, size: 11 };
hdr.alignment = { vertical: "middle", wrapText: true };
hdr.height = 24;
hdr.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } }; });

// estimate wrapped-line count for a cell so we can size the row height
const estLines = (text, charsPerLine) => String(text ?? "").split("\n").reduce((n, seg) => n + Math.max(1, Math.ceil(seg.length / charsPerLine)), 0);

for (const r of results) {
  const refStr = refs(r);
  const traceStr = traceJoined(r);
  const row = ws.addRow({
    name: r.name, formula: r.formula, tier: TIER_LABEL[r._eff.tier],
    cid: r.identity?.cid || "", inchikey: r.identity?.inchikey || "", names: namesJoined(r),
    disp: dispLabel(r.disposition),
    what: r.what_it_is, where: r.where_reported, assess: r.assessment, refs: refStr, trace: traceStr,
  });
  row.alignment = { vertical: "top", wrapText: true };
  const lines = Math.max(estLines(refStr, 66), estLines(traceStr, 56), estLines(r.where_reported, 44), estLines(r.assessment, 44), estLines(r.what_it_is, 38), 3);
  row.height = Math.min(460, lines * 15);
}

await wb.xlsx.writeFile(outPath);
console.log(`wrote ${outPath} (${results.length} compounds; ${ws.columns.length} cols, two-axis verdict up front; wrap on, header+Name frozen, row heights sized to content)`);
