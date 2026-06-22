#!/usr/bin/env node
/**
 * Head-to-head: deterministic fingerprint join vs agent matching, on the SAME
 * canonical SMPDB member lists. Also vs the original 25-compound run.
 */
import { readFileSync, writeFileSync } from "node:fs";
const COMP = JSON.parse(readFileSync("compounds-388.json", "utf8")).compounds;
const RES = JSON.parse(readFileSync("recheck-result.json", "utf8")).result;
const ORIG = JSON.parse(readFileSync("results-normalized.json", "utf8")).pathways;

const norm = (s) => String(s ?? "").trim().toLowerCase();
const stripName = (s) => norm(s)
  .replace(/\(.*?\)/g, "")
  .replace(/^l-|^d-|^dl-|^\(s\)-|^\(r\)-/, "")
  .replace(/\bacid\b/g, "")
  .replace(/[^a-z0-9]/g, "");

const ourBySkel = new Map(), ourByName = new Map(), ourByCID = new Map(), ourById = new Map();
for (const c of COMP) {
  ourById.set(c.id, c);
  if (c.inchikey_skeleton) { const k = c.inchikey_skeleton.toUpperCase(); (ourBySkel.get(k) || ourBySkel.set(k, []).get(k)).push(c); }
  const sn = stripName(c.name); if (sn) (ourByName.get(sn) || ourByName.set(sn, []).get(sn)).push(c);
  if (c.pubchem_cid) ourByCID.set(String(c.pubchem_cid), c);
}
const nameOf = (id) => (ourById.get(id) || {}).name;

// deterministic: match a canonical member to our compounds
function detMatch(members) {
  const strict = new Set(), withName = new Set();
  for (const m of members) {
    const ik = (m.inchikey || "").toUpperCase();
    let got = false;
    if (ik.includes("-")) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) { cand.forEach((c) => { strict.add(c.id); }); got = true; } }
    if (m.pubchem_cid && ourByCID.has(String(m.pubchem_cid))) { strict.add(ourByCID.get(String(m.pubchem_cid)).id); got = true; }
    const sn = stripName(m.name); const candN = ourByName.get(sn);
    if (candN) candN.forEach((c) => withName.add(c.id));
  }
  strict.forEach((id) => withName.add(id));
  return { strict, withName };
}

// resolve an agent match entry to our id
function resolveAgent(h) {
  if (h.compound_id && ourById.has(h.compound_id)) return h.compound_id;
  const ik = (h.inchikey || "").toUpperCase();
  if (ik.includes("-")) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) { const byc = cand.find((x) => String(x.pubchem_cid) === String(h.pubchem_cid)); return (byc || cand[0]).id; } }
  if (h.pubchem_cid && ourByCID.has(String(h.pubchem_cid))) return ourByCID.get(String(h.pubchem_cid)).id;
  const cand = ourByName.get(stripName(h.compound_name)); if (cand) return cand[0].id;
  return null;
}

const origByPath = new Map(ORIG.map((p) => [p.pathway, new Set(p.detected.map((d) => d.id))]));

const perPathway = [];
const gDet = new Set(), gAgent = new Set(), gUnion = new Set(), gOrig = new Set();
for (const p of RES) {
  const det = detMatch(p.canonical.members || []);
  const agent = new Set();
  for (const h of (p.agentMatch && p.agentMatch.matched) || []) { const id = resolveAgent(h); if (id) agent.add(id); }
  const orig = origByPath.get(p.pathway) || new Set();
  const union = new Set([...det.strict, ...agent]);
  const detOnly = [...det.strict].filter((id) => !agent.has(id));
  const agentOnly = [...agent].filter((id) => !det.strict.has(id));
  const nameExtra = [...det.withName].filter((id) => !det.strict.has(id) && !agent.has(id));
  det.strict.forEach((id) => gDet.add(id)); agent.forEach((id) => gAgent.add(id));
  union.forEach((id) => gUnion.add(id)); orig.forEach((id) => gOrig.add(id));
  perPathway.push({ pathway: p.pathway, canon: (p.canonical.members || []).length,
    det: det.strict.size, agent: agent.size, union: union.size, orig: orig.size,
    detOnly: detOnly.map(nameOf), agentOnly: agentOnly.map(nameOf), nameOnly: nameExtra.map(nameOf),
    unionIds: [...union] });
}

console.log("PER-PATHWAY  (det = deterministic fingerprint join, agent = LLM reasoning, both on the SAME canonical list)\n");
console.log("pathway".padEnd(42), "canon", "orig", "det", "agent", "union");
for (const r of perPathway) {
  console.log(r.pathway.padEnd(42), String(r.canon).padStart(5), String(r.orig).padStart(4), String(r.det).padStart(3), String(r.agent).padStart(5), String(r.union).padStart(5));
}
console.log("\nDIFFS per pathway:");
for (const r of perPathway) {
  if (r.detOnly.length || r.agentOnly.length) {
    console.log(`\n${r.pathway}`);
    if (r.agentOnly.length) console.log(`   agent found, deterministic MISSED (fuzzy/synonym wins): ${r.agentOnly.join(", ")}`);
    if (r.detOnly.length) console.log(`   deterministic found, agent MISSED (recall win): ${r.detOnly.join(", ")}`);
  }
}
console.log("\n================ GLOBAL DISTINCT COMPOUNDS ================");
console.log("  original run:        ", gOrig.size);
console.log("  deterministic (canon):", gDet.size);
console.log("  agent (canon):        ", gAgent.size);
console.log("  UNION (best):         ", gUnion.size);
const addedVsOrig = [...gUnion].filter((id) => !gOrig.has(id)).map(nameOf).sort();
const lostVsOrig = [...gOrig].filter((id) => !gUnion.has(id)).map(nameOf).sort();
console.log("\n  NEW compounds the canonical re-run adds vs original ("+addedVsOrig.length+"):\n    ", addedVsOrig.join(", "));
console.log("\n  In original but NOT in canonical union ("+lostVsOrig.length+"):\n    ", lostVsOrig.join(", ") || "(none)");

writeFileSync("comparison.json", JSON.stringify({ perPathway,
  global: { orig: gOrig.size, det: gDet.size, agent: gAgent.size, union: gUnion.size,
    added_vs_orig: addedVsOrig, lost_vs_orig: lostVsOrig } }, null, 2));
