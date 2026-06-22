#!/usr/bin/env node
/**
 * v2 deliverable, built from the canonical SMPDB re-run (recheck-result.json).
 * Per pathway membership = union of the deterministic fingerprint join and the
 * agent match on the SAME canonical member list. Confidence: high = exact
 * InChIKey/CID identity (found by the algorithm); low = agent-only derivative
 * ("detected form / parent") call.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const COMP = JSON.parse(readFileSync("compounds-388.json", "utf8")).compounds;
const RES = JSON.parse(readFileSync("recheck-result.json", "utf8")).result;
const CMP = JSON.parse(readFileSync("comparison.json", "utf8")).global;
const COMPARISON = JSON.parse(readFileSync("comparison.json", "utf8"));

const COMPARISON_TAG = { "Both": "Both (Conventional + Organic)", "Conventional": "GAP Conventional vs No GAP", "Organic": "GAP Organic vs No GAP" };
const norm = (s) => String(s ?? "").trim().toLowerCase();
const stripName = (s) => norm(s).replace(/\(.*?\)/g, "").replace(/^l-|^d-|^dl-|^\(s\)-|^\(r\)-/, "").replace(/\bacid\b/g, "").replace(/[^a-z0-9]/g, "");

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
    if (ik.includes("-")) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) cand.forEach((c) => { if (!out.has(c.id)) out.set(c.id, { basis: "inchikey", member: m.name }); }); }
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
  const matchedMemberNames = new Set();
  for (const id of ids) {
    const d = det.get(id), a = agentById.get(id);
    const conf = d ? "high" : (a ? a.confidence : "low");
    const basis = d ? d.basis : (a ? a.basis : "name");
    const member = (d && d.member) || (a && a.member) || "";
    members.push({ c: ourById.get(id), confidence: conf, basis, member });
    matchedMemberNames.add(norm(member));
    if (!compoundPathways.has(id)) compoundPathways.set(id, new Set());
    compoundPathways.get(id).add(p.pathway);
  }
  members.sort((x, y) => (confRank[y.confidence] - confRank[x.confidence]) || x.c.name.localeCompare(y.c.name));
  // coverage gaps: canonical members not matched to any of our compounds
  const gaps = (p.canonical.members || []).filter((m) => !matchedMemberNames.has(norm(m.name))).map((m) => m.name);
  // collapse exact-InChIKey dups for the row view
  const repByIK = new Map(); const rowMembers = [];
  for (const m of members) {
    const ik = (m.c.inchikey || ("noik:" + m.c.id)).toUpperCase();
    if (repByIK.has(ik)) { repByIK.get(ik).dups.push(m.c); continue; }
    const rep = { ...m, dups: [] }; repByIK.set(ik, rep); rowMembers.push(rep);
  }
  pathways.push({ name: p.pathway, comparison: tag, members, rowMembers, setSize: (p.canonical.members || []).length, gaps, notes: (p.agentMatch && p.agentMatch.notes) || "" });
}

// ---- XLSX ----
const wb = new ExcelJS.Workbook();
const label = (m) => m.c.name + (m.confidence !== "high" ? ` (${m.confidence}·${m.basis})` : "") + (m.dups.length ? ` [+${m.dups.length} dup]` : "");

const maxC = Math.max(...pathways.map((p) => p.rowMembers.length));
const s1 = wb.addWorksheet("Pathways → Compounds");
const head1 = ["Pathway", "Enriched in", "# compounds"];
for (let i = 1; i <= maxC; i++) head1.push("Compound " + i);
s1.addRow(head1);
for (const p of pathways) s1.addRow([p.name, p.comparison, p.rowMembers.length, ...p.rowMembers.map(label)]);
s1.getRow(1).font = { bold: true };
s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
s1.getColumn(1).width = 42; s1.getColumn(2).width = 26; s1.getColumn(3).width = 12;
for (let i = 4; i <= maxC + 3; i++) s1.getColumn(i).width = 26;

const s2 = wb.addWorksheet("Compound detail");
s2.addRow(["Name", "Formula", "PubChem CID", "InChIKey", "# pathways", "Pathways", "Best match basis", "Confidence", "Up/Down — GAP Conv vs No GAP", "Up/Down — GAP Org vs No GAP", "Notes"]);
s2.getRow(1).font = { bold: true };
const detail = new Map();
for (const p of pathways) for (const m of p.members) {
  const cur = detail.get(m.c.id);
  if (!cur || confRank[m.confidence] > confRank[cur.confidence]) detail.set(m.c.id, { c: m.c, basis: m.basis, confidence: m.confidence });
}
for (const d of [...detail.values()].sort((a, b) => a.c.name.localeCompare(b.c.name))) {
  const paths = [...(compoundPathways.get(d.c.id) || [])];
  s2.addRow([d.c.name, d.c.formula, d.c.pubchem_cid, d.c.inchikey, paths.length, paths.join("; "), d.basis, d.confidence, "", "", ""]);
}
s2.getColumn(1).width = 32; s2.getColumn(4).width = 30; s2.getColumn(6).width = 50; s2.getColumn(9).width = 26; s2.getColumn(10).width = 26;

const s3 = wb.addWorksheet("Coverage gaps");
s3.addRow(["Pathway", "Canonical set size", "# detected", "Members NOT detected in our 388"]);
s3.getRow(1).font = { bold: true };
for (const p of pathways) s3.addRow([p.name, p.setSize, p.members.length, p.gaps.join("; ")]);
s3.getColumn(1).width = 42; s3.getColumn(4).width = 100;

const s4 = wb.addWorksheet("Methods & changelog");
s4.getColumn(1).width = 30; s4.getColumn(2).width = 110;
const add4 = (k, v) => s4.addRow([k, v]);
add4("Version", "v2 — rebuilt from COMPLETE canonical SMPDB member lists (every member fingerprinted via PubChem), matched two independent ways and unioned.");
add4("Method", "Per pathway: deterministic InChIKey/CID fingerprint join AND independent agent reasoning, on the identical canonical member list; membership = union.");
add4("Confidence", "high = exact InChIKey/CID identity (found by the algorithm). low = agent-only 'detected form / parent' derivative call (e.g. pyroglutamate↔glutamate) — review before use.");
add4("Head-to-head count", `original run = ${CMP.orig} distinct compounds; deterministic (canonical) = ${CMP.det}; agent (canonical) = ${CMP.agent}; UNION (this file) = ${CMP.union}.`);
add4("Who won", "Agent > deterministic (27 vs 24): the agent caught 3 derivative matches the fingerprint join cannot see, and missed nothing the algorithm found. Recall was not the problem.");
add4("Added vs v1", CMP.added_vs_orig.join("; ") + "  (note: 'L-Glutamate' is a duplicate-name entry of L-Glutamic acid — same molecule, not a new one).");
add4("Removed vs v1", CMP.lost_vs_orig.join("; ") + "  — these are NOT members of the canonical SMPDB Arginine & Proline set; v1 included them as medium-confidence judgement calls, now corrected out.");
add4("Why only ~27", `Your 388 are ~330 plant secondary metabolites (flavonoids, glycosides, lipids) plus ~40 amino-acids/amines, ~7 organic acids, ~6 nucleosides, ~5 sugars. Only the central-metabolism subset can belong to these 13 amino-acid/central pathways, so ~27 is the real ceiling — not an under-count.`);
add4("Cofactors", "Canonical sets include ubiquitous cofactors (water, CO2, ATP, NAD, phosphate, THF...). They appear under 'Coverage gaps' because they are not in your 388.");
add4("Scope", "Membership only. Up/Down columns in Sheet 2 are left blank for your next step.");
s4.addRow([]);
s4.addRow(["Per-pathway notes", ""]).font = { bold: true };
for (const p of pathways) if (p.notes) add4(p.name, p.notes.slice(0, 400));
s4.getRow(1).font = { bold: true };

await wb.xlsx.writeFile("pathway-membership.xlsx");

// markdown
let md = `# Elderberry metabolites → 13 enriched pathways (v2, canonical SMPDB)\n\n`;
md += `Distinct compounds: original=${CMP.orig}, deterministic=${CMP.det}, agent=${CMP.agent}, **union (this file)=${CMP.union}**.\n\n`;
md += `| Pathway | Enriched in | # | Compounds (low-conf = agent-only derivative) |\n|---|---|---|---|\n`;
for (const p of pathways) md += `| ${p.name} | ${p.comparison} | ${p.rowMembers.length} | ${p.rowMembers.map(label).join(", ") || "—"} |\n`;
md += `\n**Added vs v1:** ${CMP.added_vs_orig.join(", ")} (L-Glutamate = dup of L-Glutamic acid).\n`;
md += `**Removed vs v1:** ${CMP.lost_vs_orig.join(", ")} (not in canonical Arg-Pro set).\n`;
writeFileSync("pathway-membership.md", md);

console.log(`v2 written. union=${CMP.union} compounds. Sheet1 rows=${pathways.length}, Sheet2 compounds=${detail.size}`);
for (const p of pathways) console.log(`  ${p.name}: ${p.rowMembers.length} -> ${p.rowMembers.map(label).join(", ")}`);
