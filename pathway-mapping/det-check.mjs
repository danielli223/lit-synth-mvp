#!/usr/bin/env node
/**
 * DETERMINISTIC cross-check: ignore the agents' matching entirely. Take the
 * pathway member lists (with InChIKeys) the agents fetched, and the 388
 * compounds, and compute the intersection with a plain algorithm:
 *   - InChIKey first-block (skeleton) exact set-intersection
 *   - exact normalized-name intersection
 * Then diff against what the agents CONFIRMED, to expose any misses.
 */
import { readFileSync } from "node:fs";
const COMP = JSON.parse(readFileSync("compounds-388.json", "utf8")).compounds;
const RES = JSON.parse(readFileSync("workflow-result.json", "utf8")).result;

const norm = (s) => String(s ?? "").trim().toLowerCase();
const stripName = (s) => norm(s)
  .replace(/^l-|^d-|^dl-/, "")
  .replace(/\bacid\b/g, "")
  .replace(/[^a-z0-9]/g, "");

// our indexes
const ourBySkel = new Map();   // skeleton -> [compounds]
const ourByName = new Map();   // stripped name -> [compounds]
const ourByCID  = new Map();
for (const c of COMP) {
  if (c.inchikey_skeleton) {
    const k = c.inchikey_skeleton.toUpperCase();
    (ourBySkel.get(k) || ourBySkel.set(k, []).get(k)).push(c);
  }
  const sn = stripName(c.name);
  if (sn) (ourByName.get(sn) || ourByName.set(sn, []).get(sn)).push(c);
  if (c.pubchem_cid) ourByCID.set(String(c.pubchem_cid), c);
}

function agentConfirmedIds(p) {
  // resolve agent confirmed hits to our ids (skeleton/cid/name)
  const ids = new Set();
  for (const h of (p.verify && p.verify.confirmed_hits) || []) {
    const ik = (h.inchikey || "").toUpperCase();
    let c = null;
    if (ik) { const cand = ourBySkel.get(ik.split("-")[0]); if (cand) c = cand.find(x => x.inchikey.toUpperCase() === ik) || cand[0]; }
    if (!c && h.pubchem_cid && ourByCID.has(String(h.pubchem_cid))) c = ourByCID.get(String(h.pubchem_cid));
    if (!c) { const cand = ourByName.get(stripName(h.compound_name)); if (cand) c = cand[0]; }
    if (c) ids.add(c.id);
  }
  return ids;
}

let grandDetOnly = new Set();
console.log("pathway | det(skeleton+name) | agent_confirmed | DET-ONLY (agent missed)");
for (const p of RES) {
  const members = (p.map && p.map.set_members) || [];
  const detIds = new Map(); // our id -> how
  let membersWithIK = 0;
  for (const m of members) {
    const ik = (m.inchikey || "").toUpperCase();
    if (ik && ik.includes("-")) {
      membersWithIK++;
      const cand = ourBySkel.get(ik.split("-")[0]);
      if (cand) for (const c of cand) if (!detIds.has(c.id)) detIds.set(c.id, "skeleton:" + m.name);
    }
    const sn = stripName(m.name);
    const candN = ourByName.get(sn);
    if (candN) for (const c of candN) if (!detIds.has(c.id)) detIds.set(c.id, "name:" + m.name);
  }
  const agentIds = agentConfirmedIds(p);
  const detOnly = [...detIds.keys()].filter(id => !agentIds.has(id));
  detOnly.forEach(id => grandDetOnly.add(id));
  const nameOf = (id) => COMP.find(c => c.id === id).name;
  console.log(`\n${p.pathway}`);
  console.log(`  members=${members.length} (with InChIKey=${membersWithIK}) | det=${detIds.size} | agent=${agentIds.size}`);
  if (detOnly.length) console.log(`  *** DET-ONLY (in member list + our 388, but agent did NOT confirm): ${detOnly.map(id => nameOf(id)+" [id"+id+"]").join(", ")}`);
  else console.log(`  (no misses — deterministic ⊆ agent)`);
}
console.log("\n==== distinct compounds the deterministic join found that an agent missed somewhere: " + grandDetOnly.size + " ====");
