#!/usr/bin/env node
/**
 * Build the pathway-membership deliverable (xlsx + markdown) from the verified
 * workflow result, resolving every confirmed hit back to the 388-compound file.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const compoundsDoc = JSON.parse(readFileSync("compounds-388.json", "utf8"));
const COMPOUNDS = compoundsDoc.compounds;
const result = JSON.parse(readFileSync("workflow-result.json", "utf8")).result;

// ---- indexes over our 388 compounds ----
const norm = (s) => String(s ?? "").trim().toLowerCase();
const strip = (s) => norm(s)
  .replace(/\(our\s*id[^)]*\)/g, "")
  .replace(/\(id[^)]*\)/g, "")
  .replace(/\(cid[^)]*\)/g, "")
  .replace(/\s*\/.*$/, "")        // drop "/ GABA" style alt names
  .replace(/[\s.,;:-]+$/, "")
  .trim();

const byFullIK = new Map();
const bySkel = new Map();
const byCID = new Map();
const byName = new Map();
const byStripName = new Map();
const byId = new Map();
for (const c of COMPOUNDS) {
  byId.set(c.id, c);
  if (c.inchikey) byFullIK.set(c.inchikey.toUpperCase(), c);
  if (c.inchikey_skeleton) {
    const k = c.inchikey_skeleton.toUpperCase();
    if (!bySkel.has(k)) bySkel.set(k, []);
    bySkel.get(k).push(c);
  }
  if (c.pubchem_cid) byCID.set(String(c.pubchem_cid), c);
  if (c.name) { byName.set(norm(c.name), c); byStripName.set(strip(c.name), c); }
}

function resolve(hit) {
  const ik = (hit.inchikey || "").toUpperCase();
  // explicit "id N" embedded in the verify pass's compound_name
  const idm = /\b(?:our\s+)?id\s*[:#]?\s*(\d+)\b/i.exec(hit.compound_name || "");
  if (ik && byFullIK.has(ik)) return { c: byFullIK.get(ik), how: "inchikey" };
  if (hit.pubchem_cid && byCID.has(String(hit.pubchem_cid))) return { c: byCID.get(String(hit.pubchem_cid)), how: "pubchem_cid" };
  if (idm && byId.has(Number(idm[1]))) return { c: byId.get(Number(idm[1])), how: "id" };
  if (ik) {
    const skel = ik.split("-")[0];
    const cand = bySkel.get(skel);
    if (cand && cand.length === 1) return { c: cand[0], how: "inchikey_skeleton" };
    if (cand && cand.length > 1) {
      // disambiguate by cid then name
      const byc = cand.find((x) => String(x.pubchem_cid) === String(hit.pubchem_cid));
      if (byc) return { c: byc, how: "pubchem_cid" };
      const bn = cand.find((x) => strip(x.name) === strip(hit.compound_name));
      return { c: bn || cand[0], how: "inchikey_skeleton" };
    }
  }
  const n = norm(hit.compound_name);
  if (byName.has(n)) return { c: byName.get(n), how: "name" };
  const sn = strip(hit.compound_name);
  if (sn && byStripName.has(sn)) return { c: byStripName.get(sn), how: "name" };
  return { c: null, how: "UNRESOLVED" };
}

const confRank = { high: 3, medium: 2, low: 1, "": 0, undefined: 0 };

// ---- normalize membership per pathway ----
const pathways = [];
const compoundPathways = new Map(); // our_id -> Set(pathway names)
const unresolved = [];

for (const r of result) {
  const ch = (r.verify && r.verify.confirmed_hits) || [];
  const perId = new Map(); // our_id -> {c, basis, confidence, set_member}
  for (const h of ch) {
    const { c, how } = resolve(h);
    if (!c) { unresolved.push({ pathway: r.pathway, hit: h.compound_name }); continue; }
    const prev = perId.get(c.id);
    const conf = (h.confidence || "").toLowerCase();
    if (!prev || (confRank[conf] || 0) > (confRank[prev.confidence] || 0)) {
      perId.set(c.id, { c, basis: h.match_basis || how, confidence: conf || "high", set_member: h.set_member_name || "" });
    }
    if (!compoundPathways.has(c.id)) compoundPathways.set(c.id, new Set());
    compoundPathways.get(c.id).add(r.pathway);
  }
  // collapse EXACT full-InChIKey duplicates for the row view; keep all for detail
  const members = [...perId.values()];
  const repByIK = new Map();
  const collapsed = [];
  for (const m of members.sort((a, b) => (confRank[b.confidence] - confRank[a.confidence]) || (a.c.id - b.c.id))) {
    const ik = (m.c.inchikey || ("noik:" + m.c.id)).toUpperCase();
    if (repByIK.has(ik)) { repByIK.get(ik).dups.push(m.c); continue; }
    const rep = { ...m, dups: [] };
    repByIK.set(ik, rep);
    collapsed.push(rep);
  }
  pathways.push({
    name: r.pathway,
    short: r.short,
    comparison: r.comparison,
    members,            // all distinct our_ids (incl. exact dups)
    rowMembers: collapsed, // exact-IK-collapsed, for the wide row sheet
    setSize: (r.map && r.map.set_member_count) || ((r.map && r.map.set_members) ? r.map.set_members.length : 0),
    gaps: (r.verify && r.verify.coverage_gaps) || [],
    rejected: (r.verify && r.verify.rejected_hits) || [],
    notes: (r.verify && r.verify.notes) || "",
    sources: (r.verify && r.verify.sources) || (r.map && r.map.sources) || [],
  });
}

// ---------- XLSX ----------
const wb = new ExcelJS.Workbook();
wb.creator = "pathway-membership-mapping";

const label = (m) => m.c.name + (m.confidence !== "high" ? ` (${m.confidence})` : "") + (m.dups && m.dups.length ? ` [+${m.dups.length} dup]` : "");

// Sheet 1: pathways as rows, compounds across columns
const maxC = Math.max(...pathways.map((p) => p.rowMembers.length));
const s1 = wb.addWorksheet("Pathways → Compounds");
const head1 = ["Pathway", "Enriched in", "# compounds"];
for (let i = 1; i <= maxC; i++) head1.push("Compound " + i);
s1.addRow(head1);
for (const p of pathways) {
  const row = [p.name, p.comparison, p.rowMembers.length, ...p.rowMembers.map(label)];
  s1.addRow(row);
}
s1.getRow(1).font = { bold: true };
s1.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
s1.getColumn(1).width = 42; s1.getColumn(2).width = 26; s1.getColumn(3).width = 12;
for (let i = 4; i <= maxC + 3; i++) s1.getColumn(i).width = 24;

// Sheet 2: compound detail (every distinct our_id that appears in >=1 pathway)
const s2 = wb.addWorksheet("Compound detail");
s2.addRow(["Name", "Formula", "PubChem CID", "InChIKey", "# pathways", "Pathways", "Match basis", "Confidence", "Same-InChIKey duplicate of", "Up/Down — GAP Conv vs No GAP", "Up/Down — GAP Org vs No GAP", "Notes"]);
s2.getRow(1).font = { bold: true };
// gather best record per our_id across pathways
const detail = new Map();
for (const p of pathways) for (const m of p.members) {
  const cur = detail.get(m.c.id);
  if (!cur || confRank[m.confidence] > confRank[cur.confidence]) {
    detail.set(m.c.id, { c: m.c, basis: m.basis, confidence: m.confidence });
  }
}
// duplicate map by full inchikey
const ikGroups = new Map();
for (const { c } of detail.values()) {
  if (!c.inchikey) continue;
  const k = c.inchikey.toUpperCase();
  if (!ikGroups.has(k)) ikGroups.set(k, []);
  ikGroups.get(k).push(c);
}
const sortedDetail = [...detail.values()].sort((a, b) => a.c.name.localeCompare(b.c.name));
for (const d of sortedDetail) {
  const paths = [...(compoundPathways.get(d.c.id) || [])];
  const grp = d.c.inchikey ? (ikGroups.get(d.c.inchikey.toUpperCase()) || []) : [];
  const dup = grp.filter((x) => x.id !== d.c.id).map((x) => x.name).join("; ");
  s2.addRow([d.c.name, d.c.formula, d.c.pubchem_cid, d.c.inchikey, paths.length, paths.join("; "), d.basis, d.confidence, dup, "", "", ""]);
}
s2.getColumn(1).width = 30; s2.getColumn(4).width = 30; s2.getColumn(6).width = 50;
s2.getColumn(10).width = 26; s2.getColumn(11).width = 26;

// Sheet 3: coverage gaps
const s3 = wb.addWorksheet("Coverage gaps");
s3.addRow(["Pathway", "SMPDB set size", "# detected in our 388", "Set members NOT detected"]);
s3.getRow(1).font = { bold: true };
for (const p of pathways) {
  s3.addRow([p.name, p.setSize, p.members.length, p.gaps.join("; ")]);
}
s3.getColumn(1).width = 42; s3.getColumn(4).width = 90;

// Sheet 4: methods / notes
const s4 = wb.addWorksheet("Methods & notes");
s4.getColumn(1).width = 28; s4.getColumn(2).width = 110;
const add4 = (k, v) => s4.addRow([k, v]);
s4.getRow(1).font = { bold: true };
add4("Deliverable", "Membership of the 388 identified elderberry compounds in 13 enriched SMPDB pathway metabolite sets.");
add4("Compound universe", `${COMPOUNDS.length} named compounds from ${compoundsDoc.source} (${compoundsDoc.with_inchikey} with InChIKey/CID).`);
add4("Pathway sets", "MetaboAnalyst SMPDB 'pathway-associated metabolite sets' (the library behind the enrichment plots). Members from SMPDB/PathBank + HMDB + KEGG.");
add4("Matching priority", "InChIKey first-block (skeleton) > PubChem CID > name/synonym (L-/D- & free-acid/conjugate-base treated as same molecule).");
add4("Verification", "Every candidate membership was independently re-derived and adversarially verified against SMPDB/HMDB/KEGG; false positives rejected.");
add4("Confidence", "high = exact InChIKey/CID identity; medium/low = synonym or stereo/skeleton-only judgement calls — review before use.");
add4("Hub metabolites", "L-Glutamate and alpha-ketoglutaric acid are members of many of these sets (transamination hubs); recurrence across pathways is expected, not an error.");
add4("Cofactors", "SMPDB sets include ubiquitous cofactors (water, CO2, ATP, NAD, phosphate, PLP, THF...). These are listed under coverage gaps when not detected; they are rarely meaningful 'hits'.");
add4("Duplicate entries", "Your export lists glutamate up to 3x (L-Glutamic acid / L-Glutamate share a full InChIKey; DL-Glutamic acid is the same skeleton). Sheet 1 collapses exact-InChIKey duplicates ([+n dup]); Sheet 2 lists each and flags the duplicate.");
add4("624 vs 388", "Enrichment input was ~624 volcano-selected compounds (p<0.01, log2>4); only named/identified compounds map to sets. We mapped the 388 identified set; 'Coverage gaps' shows set members not present in it.");
add4("Scope", "Membership only — no up/down-regulation and no statistics (your next step). Up/Down columns in Sheet 2 are left blank for you.");
add4("Unresolved hits", unresolved.length ? unresolved.map((u) => `${u.hit} [${u.pathway}]`).join("; ") : "none — all confirmed hits resolved to the 388 file.");
s4.addRow([]);
s4.addRow(["Per-pathway notes & sources", ""]).font = { bold: true };
for (const p of pathways) {
  if (p.notes) add4(p.name, p.notes);
  if (p.rejected.length) add4(p.name + " — rejected", p.rejected.map((x) => `${x.compound_name}: ${x.reason}`).join(" | "));
}

await wb.xlsx.writeFile("pathway-membership.xlsx");

// ---------- Markdown ----------
let md = `# Elderberry metabolites → enriched SMPDB pathway membership\n\n`;
md += `Membership of the **${COMPOUNDS.length} identified compounds** in the **13 enriched pathways** (MetaboAnalyst SMPDB pathway-associated metabolite sets). `;
md += `Each hit was matched by InChIKey → PubChem CID → name and **adversarially verified** against SMPDB/HMDB/KEGG.\n\n`;
md += `| Pathway | Enriched in | # | Compounds detected in our ${COMPOUNDS.length} |\n|---|---|---|---|\n`;
for (const p of pathways) {
  md += `| ${p.name} | ${p.comparison} | ${p.rowMembers.length} | ${p.rowMembers.map(label).join(", ") || "—"} |\n`;
}
md += `\n## Notes\n`;
md += `- **Confidence:** unmarked = high (exact InChIKey/CID). \`(medium)\`/\`(low)\` = synonym or stereo-only calls — review.\n`;
md += `- **\`[+n dup]\`** = n additional entries in your export with the same InChIKey (same molecule, listed separately in Sheet 2).\n`;
md += `- **Hub metabolites** L-glutamate and α-ketoglutarate recur across many sets by design (transamination hubs).\n`;
md += `- **Scope:** membership only; up/down-regulation and statistics are your next step.\n\n`;
md += `## Coverage gaps (set members not detected in our ${COMPOUNDS.length})\n`;
for (const p of pathways) {
  md += `- **${p.name}** (${p.members.length}/${p.setSize} detected): ${p.gaps.join("; ") || "all members detected"}\n`;
}

writeFileSync("pathway-membership.md", md);

// normalized json for the record
writeFileSync("results-normalized.json", JSON.stringify({ pathways: pathways.map((p) => ({
  pathway: p.name, comparison: p.comparison, set_size: p.setSize,
  detected: p.members.map((m) => ({ id: m.c.id, name: m.c.name, formula: m.c.formula, pubchem_cid: m.c.pubchem_cid, inchikey: m.c.inchikey, basis: m.basis, confidence: m.confidence })),
  coverage_gaps: p.gaps, rejected: p.rejected,
})), unresolved }, null, 2));

// console summary
console.log("Wrote pathway-membership.xlsx, pathway-membership.md, results-normalized.json");
console.log("Unresolved confirmed hits:", unresolved.length);
if (unresolved.length) console.log(JSON.stringify(unresolved, null, 2));
console.log("\nPer pathway (row view, exact-IK-collapsed):");
for (const p of pathways) console.log(`  ${p.name}: ${p.rowMembers.length} -> ${p.rowMembers.map(label).join(", ")}`);
console.log("\nDistinct compounds appearing in >=1 pathway:", detail.size);
