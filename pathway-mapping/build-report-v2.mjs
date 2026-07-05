#!/usr/bin/env node
/**
 * Deliverable: which of the 388 identified metabolites are members of the 13
 * impacted pathways. Membership = EXACT identity (InChIKey/PubChem CID) to a
 * canonical SMPDB pathway member. Compounds that only match as a related form
 * (stereoisomer / parent / derivative) are set aside on a separate tab, not
 * counted as members. Pathway membership is sourced from SMPDB (smpdb.ca).
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const COMP = JSON.parse(readFileSync("compounds-388.json", "utf8")).compounds;
const RES = JSON.parse(readFileSync("recheck-result.json", "utf8")).result;

const COMPARISON_TAG = { "Both": "Both (Conventional + Organic)", "Conventional": "GAP Conventional vs No GAP", "Organic": "GAP Organic vs No GAP" };
const norm = (s) => String(s ?? "").trim().toLowerCase();
const stripName = (s) => norm(s).replace(/\(.*?\)/g, "").replace(/^l-|^d-|^dl-|^\(s\)-|^\(r\)-/, "").replace(/\bacid\b/g, "").replace(/[^a-z0-9]/g, "");
// skeleton = first InChIKey block (atom connectivity) — same molecule detected under several
// names/stereo forms (e.g. DL- vs L-glutamate) shares it. stereoDefined ranks the L-form above a racemate.
const skelKey = (c) => String(c.inchikey_skeleton || (c.inchikey || "").split("-")[0] || ("id" + c.id)).toUpperCase();
const stereoDefined = (c) => { const b = (c.inchikey || "").split("-")[1]; return b && b !== "UHFFFAOYSA" ? 1 : 0; };
// a same-skeleton match is only the SAME molecule if the stereochemistry is compatible:
// identical, or undefined on at least one side. Both defined-and-different = different stereoisomers.
const stereoBlock = (ik) => String(ik || "").toUpperCase().split("-")[1] || "";
const stereoCompatible = (a, b) => {
  const fa = String(a || "").toUpperCase(), fb = String(b || "").toUpperCase();
  if (fa && fa === fb) return true;
  const sa = stereoBlock(fa), sb = stereoBlock(fb);
  if (!sa || !sb) return true;
  return sa === "UHFFFAOYSA" || sb === "UHFFFAOYSA";
};

const ourBySkel = new Map(), ourByName = new Map(), ourByCID = new Map(), ourById = new Map();
for (const c of COMP) {
  ourById.set(c.id, c);
  if (c.inchikey_skeleton) { const k = c.inchikey_skeleton.toUpperCase(); (ourBySkel.get(k) || ourBySkel.set(k, []).get(k)).push(c); }
  const sn = stripName(c.name); if (sn) (ourByName.get(sn) || ourByName.set(sn, []).get(sn)).push(c);
  if (c.pubchem_cid) ourByCID.set(String(c.pubchem_cid), c);
}
const confRank = { high: 3, medium: 2, low: 1 };

function detMatch(members) { // id -> {basis, member}
  const out = new Map();
  for (const m of members) {
    const ik = (m.inchikey || "").toUpperCase();
    if (ik.includes("-")) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) cand.forEach((c) => { if (!out.has(c.id) && stereoCompatible(c.inchikey, m.inchikey)) out.set(c.id, { basis: "inchikey", member: m.name }); }); }
    if (m.pubchem_cid && ourByCID.has(String(m.pubchem_cid))) { const c = ourByCID.get(String(m.pubchem_cid)); if (!out.has(c.id)) out.set(c.id, { basis: "pubchem_cid", member: m.name }); }
  }
  return out;
}
function resolveAgent(h) {
  if (h.compound_id && ourById.has(h.compound_id)) return h.compound_id;
  const ik = (h.inchikey || "").toUpperCase();
  if (ik.includes("-")) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) { const byc = cand.find((x) => String(x.pubchem_cid) === String(h.pubchem_cid)); return (byc || cand[0]).id; } }
  if (h.pubchem_cid && ourByCID.has(String(h.pubchem_cid))) return ourByCID.get(String(h.pubchem_cid)).id;
  const cand = ourByName.get(stripName(h.compound_name)); return cand ? cand[0].id : null;
}

const pathways = [];
const compoundPathways = new Map();
for (const p of RES) {
  const tag = COMPARISON_TAG[p.comparison] || p.comparison;
  const det = detMatch(p.canonical.members || []);
  const agentById = new Map();
  for (const h of (p.agentMatch && p.agentMatch.matched) || []) {
    const id = resolveAgent(h); if (!id) continue;
    const prev = agentById.get(id);
    if (!prev || (confRank[h.confidence] || 0) > (confRank[prev.confidence] || 0)) agentById.set(id, { basis: h.match_basis, confidence: h.confidence, member: h.member_name });
  }
  const ids = new Set([...det.keys(), ...agentById.keys()]);
  const members = [];
  for (const id of ids) {
    const d = det.get(id), a = agentById.get(id);
    const conf = d ? "high" : (a ? a.confidence : "low");
    const basis = d ? d.basis : (a ? a.basis : "name");
    const member = (d && d.member) || (a && a.member) || "";
    members.push({ c: ourById.get(id), confidence: conf, basis, member });
    if (!compoundPathways.has(id)) compoundPathways.set(id, new Set());
    compoundPathways.get(id).add(p.pathway);
  }
  members.sort((x, y) => (confRank[y.confidence] - confRank[x.confidence]) || (stereoDefined(y.c) - stereoDefined(x.c)) || x.c.name.localeCompare(y.c.name));
  // collapse same-molecule detections (skeleton level) for the row view — picks the L-form as representative
  const repByIK = new Map(); const rowMembers = [];
  for (const m of members) {
    const ik = skelKey(m.c);
    if (repByIK.has(ik)) { repByIK.get(ik).dups.push(m.c); continue; }
    const rep = { ...m, dups: [] }; repByIK.set(ik, rep); rowMembers.push(rep);
  }
  pathways.push({ name: p.pathway, comparison: tag, members, rowMembers, smpdb_id: p.canonical.smpdb_id });
}

// unique-compound detail (one row per distinct compound, best confidence)
const detail = new Map();
for (const p of pathways) for (const m of p.members) {
  const cur = detail.get(m.c.id);
  if (!cur || confRank[m.confidence] > confRank[cur.confidence]) detail.set(m.c.id, { c: m.c, basis: m.basis, confidence: m.confidence });
}

// --- restrict the deliverable to exact members (high confidence); set derivatives aside ---
const isHigh = (m) => m.confidence === "high";
for (const p of pathways) p.highMembers = p.rowMembers.filter(isHigh);
const highDetail = [...detail.values()].filter((d) => d.confidence === "high");
const uniqueCount = highDetail.length;
const relatedMap = new Map();
for (const p of pathways) for (const m of p.rowMembers) if (!isHigh(m)) {
  const e = relatedMap.get(m.c.id) || { c: m.c, members: new Set(), basis: m.basis, pathways: new Set() };
  if (m.member) e.members.add(m.member);
  e.pathways.add(p.name); relatedMap.set(m.c.id, e);
}
const related = [...relatedMap.values()].sort((a, b) => a.c.name.localeCompare(b.c.name));

// canonical-member DB-ID index (HMDB / KEGG / PubChem) so each compound traces to its database record
const memberByCID = new Map(), memberBySkel = new Map();
for (const pw of RES) for (const m of (pw.canonical.members || [])) {
  if (m.pubchem_cid && !memberByCID.has(String(m.pubchem_cid))) memberByCID.set(String(m.pubchem_cid), m);
  const sk = (m.inchikey || "").toUpperCase().split("-")[0];
  if (sk && !memberBySkel.has(sk)) memberBySkel.set(sk, m);
}
const memberFor = (c) => (c.pubchem_cid && memberByCID.get(String(c.pubchem_cid))) || memberBySkel.get((c.inchikey || "").toUpperCase().split("-")[0]) || null;

// ---- XLSX ----
const wb = new ExcelJS.Workbook();
const NAME_GLOSS = { "H-Met(O)-OH": "Methionine sulfoxide (H-Met(O)-OH)" };
const disp = (n) => NAME_GLOSS[n] || n;
const label = (m) => disp(m.c.name) + (m.dups.length ? ` [+${m.dups.length} dup]` : "");
const totalMemberships = pathways.reduce((a, p) => a + p.highMembers.length, 0);

// distinct molecules: collapse the same compound detected under several names/forms (e.g. DL-/L-glutamate ×3)
const distinctMap = new Map();
for (const d of highDetail) { const k = skelKey(d.c); (distinctMap.get(k) || distinctMap.set(k, []).get(k)).push(d); }
const distinct = [...distinctMap.values()].map((g) => {
  g.sort((a, b) => (stereoDefined(b.c) - stereoDefined(a.c)) || a.c.name.localeCompare(b.c.name));
  const rep = g[0], paths = new Set();
  for (const d of g) for (const p of (compoundPathways.get(d.c.id) || [])) paths.add(p);
  return { rep, alt: g.slice(1).map((d) => `${d.c.name} (CID ${d.c.pubchem_cid})`), paths: [...paths] };
});
const distinctCount = distinct.length, detectionCount = highDetail.length;
const padSmp = (id) => { const m = /^SMP0*(\d+)$/.exec(id || ""); return m ? "SMP" + m[1].padStart(7, "0") : (id || ""); };
const smpUrl = (p) => (p.smpdb_id ? "https://smpdb.ca/view/" + padSmp(p.smpdb_id) : "");

// ---- shared styling helpers ----
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF274472" } };
const HEAD_FONT = { bold: true, color: { argb: "FFFFFFFF" } };
const ZEBRA = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
const EDGE = { style: "thin", color: { argb: "FFCBD5E1" } };
const BOX = { top: EDGE, left: EDGE, bottom: EDGE, right: EDGE };
const ACCENT = { argb: "FF274472" };
const LINK = { color: { argb: "FF1155CC" }, underline: true };
function dress(ws, { head, ncols, firstData, lastData, wrap = [], center = [], headHeight = 24 }) {
  const wset = new Set(wrap), cset = new Set(center);
  const hr = ws.getRow(head);
  for (let c = 1; c <= ncols; c++) {
    const cell = hr.getCell(c);
    cell.font = HEAD_FONT; cell.fill = HEAD_FILL; cell.border = BOX;
    cell.alignment = { vertical: "middle", horizontal: cset.has(c) ? "center" : "left", wrapText: true };
  }
  hr.height = headHeight;
  let z = 0;
  for (let r = firstData; r <= (lastData || ws.rowCount); r++) {
    const row = ws.getRow(r), zebra = (z++ % 2 === 1);
    for (let c = 1; c <= ncols; c++) {
      const cell = row.getCell(c);
      cell.border = BOX;
      cell.alignment = { vertical: "top", horizontal: cset.has(c) ? "center" : "left", wrapText: wset.has(c) };
      if (zebra) cell.fill = ZEBRA;
    }
  }
}
const linkCell = (cell, url) => { if (!url) return; cell.value = { text: url.replace(/^https:\/\//, ""), hyperlink: url }; cell.font = LINK; };
const linkText = (cell, txt, url) => { if (txt == null || txt === "") return; cell.value = url ? { text: String(txt), hyperlink: url } : String(txt); if (url) cell.font = LINK; };

// lit-synth per-compound judgement (from the 388 report): colour the "Detection" cell so a reader
// can see at a glance which detections are trusted vs. likely artifacts. Green=native, amber=unsure,
// orange=processing artifact, red=contaminant/foreign, grey=unresolved.
const DET_FILL = {
  "native — plausibly belongs": "FFD9EAD3",
  "undetermined (native vs. artifact)": "FFFFF2CC",
  "oxidation / processing artifact": "FFFCE4D6",
  "synthetic — contaminant / carry-over": "FFF4CCCC",
  "foreign — shouldn't be in elderberry": "FFF4CCCC",
  "identity unresolved": "FFEAEAEA",
};
const detFill = (d) => (DET_FILL[d] ? { type: "pattern", pattern: "solid", fgColor: { argb: DET_FILL[d] } } : null);

// ===== Summary sheet =====
const sSum = wb.addWorksheet("Summary");
[5, 34, 13, 13, 11, 58, 16, 30, 40].forEach((w, i) => (sSum.getColumn(i + 1).width = w));
const tRow = sSum.addRow(["Elderberry metabolites found in the 13 impacted pathways"]);
sSum.mergeCells(1, 1, 1, 9);
tRow.getCell(1).font = { bold: true, size: 14, color: { argb: "FF1F3A5F" } };
tRow.getCell(1).alignment = { vertical: "middle" };
tRow.height = 28;
sSum.addRow([]);
const uRow = sSum.addRow(["Distinct compounds found in the pathways", "", distinctCount]);
sSum.mergeCells(3, 1, 3, 2);
uRow.getCell(1).font = { bold: true };
uRow.getCell(3).font = { bold: true, size: 12, color: ACCENT };
const cRow = sSum.addRow([`${distinctCount} distinct compounds, from ${detectionCount} detections (some were detected under more than one name — e.g. glutamate ×3 — and are collapsed to one row here). Only EXACT identity matches (PubChem CID / InChIKey to the pathway's metabolite list) are counted as members; chemically-related forms are on the "Related forms — not counted" tab. ${totalMemberships} compound×pathway memberships total.`]);
sSum.mergeCells(4, 1, 4, 9);
cRow.getCell(1).font = { color: { argb: "FF333333" } };
cRow.getCell(1).alignment = { wrapText: true, vertical: "middle" };
cRow.height = 56;
const srcRow = sSum.addRow(["Sources: pathway membership is from SMPDB (smpdb.ca) — see the 'Source (SMPDB)' link on the 'Pathways → Compounds' tab. Each compound's PubChem / HMDB / KEGG IDs are on the 'Compound detail' tab. The 'Occurrence (lit.)' and 'Detection' columns are the lit-synth literature judgement per compound — Detection is colour-coded: green = native/plausible, amber = undetermined (native vs. artifact), orange = likely processing artifact."]);
sSum.mergeCells(5, 1, 5, 9);
srcRow.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
srcRow.getCell(1).alignment = { wrapText: true, vertical: "middle" };
srcRow.height = 30;
sSum.addRow([]); // row 6
sSum.addRow(["#", "Compound", "Formula", "PubChem CID", "# pathways", "Pathways it appears in", "Occurrence (lit.)", "Detection (lit-synth judgement)", "Note"]); // row 7
const sumRows = distinct
  .map((g) => ({ g, n: g.paths.length }))
  .sort((a, b) => (b.n - a.n) || a.g.rep.c.name.localeCompare(b.g.rep.c.name));
let rank = 0;
for (const r of sumRows) {
  rank++;
  const g = r.g;
  sSum.addRow([rank, disp(g.rep.c.name), g.rep.c.formula, g.rep.c.pubchem_cid, r.n, g.paths.join("; "), g.rep.c.occurrence || "", g.rep.c.detection || "", g.alt.length ? "also detected as: " + g.alt.join("; ") : ""]);
}
dress(sSum, { head: 7, ncols: 9, firstData: 8, wrap: [2, 6, 7, 8, 9], center: [1, 3, 4, 5] });
sumRows.forEach((r, i) => { const f = detFill(r.g.rep.c.detection); if (f) sSum.getCell(i + 8, 8).fill = f; });
sSum.views = [{ state: "frozen", ySplit: 7 }];
sSum.autoFilter = { from: { row: 7, column: 1 }, to: { row: 7 + sumRows.length, column: 9 } };

// ===== Pathways → Compounds =====
const maxC = Math.max(1, ...pathways.map((p) => p.highMembers.length));
const s1 = wb.addWorksheet("Pathways → Compounds");
const lr = s1.addRow(["Legend:  'Enriched in' = which enrichment comparison flagged the pathway (GAP = your treatment groups; Conventional and Organic each vs No-GAP; 'Both' = flagged in both).   '[+N dup]' = the same compound was also detected under N other names.   'Source (SMPDB)' links the pathway's official metabolite list."]);
s1.mergeCells(1, 1, 1, maxC + 4);
lr.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
lr.getCell(1).alignment = { wrapText: true, vertical: "middle" };
lr.height = 44;
const head1 = ["Pathway", "Enriched in", "# compounds", "Source (SMPDB)"];
for (let i = 1; i <= maxC; i++) head1.push("Compound " + i);
s1.addRow(head1);
for (const p of pathways) s1.addRow([p.name, p.comparison, p.highMembers.length, smpUrl(p), ...p.highMembers.map(label)]);
s1.getColumn(1).width = 40; s1.getColumn(2).width = 24; s1.getColumn(3).width = 12; s1.getColumn(4).width = 34;
for (let i = 5; i <= maxC + 4; i++) s1.getColumn(i).width = 24;
const wrap1 = [1, 2]; for (let i = 5; i <= maxC + 4; i++) wrap1.push(i);
dress(s1, { head: 2, ncols: maxC + 4, firstData: 3, wrap: wrap1, center: [3] });
pathways.forEach((p, i) => linkCell(s1.getCell(i + 3, 4), smpUrl(p)));
s1.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

// ===== Compound detail (one row per DISTINCT compound; DB-ID sources + blank Up/Down for next step) =====
const s2 = wb.addWorksheet("Compound detail");
s2.addRow(["Name", "Formula", "PubChem CID", "InChIKey", "HMDB ID", "KEGG ID", "# pathways", "Pathways", "Occurrence (lit.)", "Detection (lit-synth judgement)", "Up/Down — GAP Conv vs No GAP (fill in next step)", "Up/Down — GAP Org vs No GAP (fill in next step)", "Notes"]);
const detRows = distinct.slice().sort((a, b) => a.rep.c.name.localeCompare(b.rep.c.name));
for (const g of detRows) {
  const mem = memberFor(g.rep.c);
  s2.addRow([disp(g.rep.c.name), g.rep.c.formula, g.rep.c.pubchem_cid, g.rep.c.inchikey, (mem && mem.hmdb_id) || "", (mem && mem.kegg_id) || "", g.paths.length, g.paths.join("; "), g.rep.c.occurrence || "", g.rep.c.detection || "", "", "", g.alt.length ? "also detected as: " + g.alt.join("; ") : ""]);
}
s2.getColumn(1).width = 30; s2.getColumn(2).width = 13; s2.getColumn(3).width = 13; s2.getColumn(4).width = 30; s2.getColumn(5).width = 15; s2.getColumn(6).width = 11;
s2.getColumn(7).width = 11; s2.getColumn(8).width = 50; s2.getColumn(9).width = 16; s2.getColumn(10).width = 30; s2.getColumn(11).width = 26; s2.getColumn(12).width = 26; s2.getColumn(13).width = 34;
dress(s2, { head: 1, ncols: 13, firstData: 2, wrap: [1, 4, 8, 9, 10, 11, 12, 13], center: [7] });
// make the source IDs clickable links to their database records; colour the Detection cell by judgement
detRows.forEach((g, i) => {
  const r = i + 2, mem = memberFor(g.rep.c);
  if (g.rep.c.pubchem_cid) linkText(s2.getCell(r, 3), g.rep.c.pubchem_cid, "https://pubchem.ncbi.nlm.nih.gov/compound/" + g.rep.c.pubchem_cid);
  if (mem && mem.hmdb_id) linkText(s2.getCell(r, 5), mem.hmdb_id, "https://hmdb.ca/metabolites/" + mem.hmdb_id);
  if (mem && mem.kegg_id) linkText(s2.getCell(r, 6), mem.kegg_id, "https://www.kegg.jp/entry/" + mem.kegg_id);
  const f = detFill(g.rep.c.detection); if (f) s2.getCell(r, 10).fill = f;
});
s2.views = [{ state: "frozen", ySplit: 1 }];
s2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + detRows.length, column: 13 } };

// ===== Related forms (review) — NOT counted as members =====
const WHY = {
  "L-Pyroglutamic acid/5-Oxo-proline": "Cyclized (lactam) derivative of glutamate — interconverts with it but is a distinct molecule (and often a sample-prep artifact of glutamate/glutamine).",
  "N-Acetylglucosaminitol": "Reduced (sugar-alcohol) form of N-acetylglucosamine — a derivative, not the listed member.",
  "Cytidine": "Dephosphorylated parent nucleoside of cytidine monophosphate (CMP) — related, not identical.",
  "cis-4-Hydroxy-D-proline": "Different stereoisomer (cis-D) from the pathway's member trans-4-hydroxy-L-proline (CID 5810), which was NOT in the 388 — this peak is most likely ordinary trans-L-hydroxyproline mislabeled. Verify before counting.",
};
if (related.length) {
  const s3 = wb.addWorksheet("Related forms — not counted");
  [34, 13, 12, 40, 40, 46].forEach((w, i) => (s3.getColumn(i + 1).width = w));
  const rt = s3.addRow(["Related forms detected — NOT counted as pathway members (for your review)"]);
  s3.mergeCells(1, 1, 1, 6);
  rt.getCell(1).font = { bold: true, size: 13, color: { argb: "FF8A4B00" } };
  rt.getCell(1).alignment = { vertical: "middle" }; rt.height = 26;
  const rc = s3.addRow(["These compounds are chemically related to a pathway member (a stereoisomer, parent, or derivative) but are NOT the exact molecule, so they are excluded from the membership counts. Listed here only in case they matter when you check up/down-regulation."]);
  s3.mergeCells(2, 1, 2, 6);
  rc.getCell(1).font = { italic: true, color: { argb: "FF666666" } };
  rc.getCell(1).alignment = { wrapText: true, vertical: "middle" }; rc.height = 44;
  s3.addRow([]); // row 3
  s3.addRow(["Compound (detected)", "Formula", "PubChem CID", "Related to pathway member", "Pathway(s)", "Why it's not a direct member"]); // row 4
  for (const e of related) s3.addRow([e.c.name, e.c.formula, e.c.pubchem_cid, [...e.members].join("; "), [...e.pathways].join("; "), WHY[e.c.name] || `Related form (${e.basis}) of "${[...e.members].join("; ")}".`]);
  dress(s3, { head: 4, ncols: 6, firstData: 5, wrap: [1, 4, 5, 6], center: [3] });
  s3.views = [{ state: "frozen", ySplit: 4 }];
}

await wb.xlsx.writeFile("pathway-membership.xlsx");

// ---- markdown ----
let md = `# Elderberry metabolites found in the 13 impacted pathways\n\n`;
md += `**${distinctCount} distinct compounds** (from ${detectionCount} detections; some were detected under more than one name, e.g. glutamate ×3) are members of the 13 pathways — **${totalMemberships} compound×pathway memberships** total. Only exact identity matches (PubChem CID / InChIKey to the SMPDB pathway metabolite list) are counted.\n\n`;
md += `| Pathway | Enriched in | # | Compounds | Source |\n|---|---|---|---|---|\n`;
for (const p of pathways) md += `| ${p.name} | ${p.comparison} | ${p.highMembers.length} | ${p.highMembers.map(label).join(", ") || "—"} | [${padSmp(p.smpdb_id)}](${smpUrl(p)}) |\n`;
if (related.length) {
  md += `\n## Related forms detected — NOT counted as members (review)\n\n`;
  md += `| Compound (detected) | Related to member | Pathway(s) | Why |\n|---|---|---|---|\n`;
  for (const e of related) md += `| ${e.c.name} | ${[...e.members].join("; ")} | ${[...e.pathways].join("; ")} | ${WHY[e.c.name] || ("related form (" + e.basis + ")")} |\n`;
}
writeFileSync("pathway-membership.md", md);

console.log(`Written. ${distinctCount} distinct compounds (${detectionCount} detections), ${totalMemberships} memberships, ${related.length} related forms set aside.`);
for (const p of pathways) console.log(`  ${p.name} [${padSmp(p.smpdb_id)}]: ${p.highMembers.length} -> ${p.highMembers.map(label).join(", ")}`);
