#!/usr/bin/env node
/**
 * Render the always-agentic 10-compound test run into a comparison markdown report.
 *   node gen-test-report.mjs <workflow-output.json> <out.md>
 *
 * CITATION POLICY: the agent cites EVERY source it reasoned from, as {type,id,role,note}:
 *   - type:"pubmed" id:<PMID>  -> metadata fetched VERBATIM from esummary (model never writes it)
 *   - type:"pubchem" id:<CID>  -> structure/identity anchor (PubChem link)
 *   - type:"lotus"  id:<QID>  -> occurrence anchor (LOTUS/Wikidata link)
 * Every compound therefore has >=1 citation; no claim is left unanchored. A PMID that
 * does not resolve in esummary is dropped + flagged (fabrication guard).
 */
import fs from "node:fs";
import { fetchPubmedMeta } from "./cite.mjs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: gen-test-report.mjs <in.json> <out.md>"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const results = raw.result || raw;

const V3 = {
  5:   { prov: "Unknown", disp: "identity-unresolved", nolit: true,  role: "rescue / honest-fail control" },
  9:   { prov: "Unknown", disp: "undetermined",        nolit: true,  role: "rescue target (alkamide)" },
  14:  { prov: "Unknown", disp: "undetermined",        nolit: true,  role: "rescue target (terpene glucoside)" },
  57:  { prov: "Unknown", disp: "undetermined",        nolit: true,  role: "rescue target (diterpenoid)" },
  60:  { prov: "Non-plant", disp: "synthetic",         nolit: true,  role: "rescue target (nitro-fatty acid)" },
  62:  { prov: "Non-plant", disp: "synthetic",         nolit: true,  role: "rescue target (TEMPO reagent)" },
  82:  { prov: "Unknown", disp: "undetermined",        nolit: true,  role: "rescue target (lysophospholipid)" },
  240: { prov: "Unknown", disp: "identity-unresolved", nolit: false, role: "rescue target (mis-spelled name)" },
  346: { prov: "Elderberry", disp: "native-plausible", nolit: false, role: "positive control" },
  349: { prov: "Elderberry", disp: "native-plausible", nolit: false, role: "positive control" },
};

const provLabel = (p) => ({
  elderberry: "Elderberry (Sambucus)", other_berry: "Other berry", other_plant: "Other plant",
  non_plant: "Non-plant", unknown: "Unknown",
}[p] || p);
const dispLabel = (d) => ({
  native_plausible: "native-plausible", oxidation_processing: "oxidation / processing",
  synthetic_contaminant: "synthetic — contaminant",
  foreign: "foreign", misannotation: "foreign", // legacy alias
  identity_unresolved: "identity-unresolved", undetermined: "undetermined",
}[d] || d);

results.sort((a, b) => a.uid - b.uid);

// ---- strict metadata for the PubMed-typed citations ----
const pubmedIds = results.flatMap((r) => (r.citations || []).filter((c) => c.type === "pubmed").map((c) => c.id));
const META = await fetchPubmedMeta(pubmedIds);

const isDropped = (c) => c.type === "pubmed" && !(META[String(c.id)] && META[String(c.id)].found);
const validCites = (r) => (r.citations || []).filter((c) => !isDropped(c));
const paperCites = (r) => validCites(r).filter((c) => c.type === "pubmed");

function renderCite(c, n) {
  const tag = `_[${c.role}]_`;
  if (c.type === "pubmed") {
    const m = META[String(c.id)];
    return `${n}. ${tag} ${m.authors} (${m.year}). ${m.title}. *${m.journal}*. [PMID ${c.id}](https://pubmed.ncbi.nlm.nih.gov/${c.id}/) — ${c.note}`;
  }
  if (c.type === "pubchem") {
    return `${n}. ${tag} **PubChem CID ${c.id}** — structure/identity record. [pubchem.ncbi.nlm.nih.gov/compound/${c.id}](https://pubchem.ncbi.nlm.nih.gov/compound/${c.id}) — ${c.note}`;
  }
  if (c.type === "lotus") {
    return `${n}. ${tag} **LOTUS / Wikidata ${c.id}** — occurrence record. [wikidata.org/wiki/${c.id}](https://www.wikidata.org/wiki/${c.id}) — ${c.note}`;
  }
  return `${n}. ${tag} ${c.id} — ${c.note}`;
}

// ---- corpus stats ----
const allValid = results.flatMap(validCites);
const nPapers = allValid.filter((c) => c.type === "pubmed").length;
const nPubchem = allValid.filter((c) => c.type === "pubchem").length;
const nLotus = allValid.filter((c) => c.type === "lotus").length;
const droppedPmids = [...new Set(results.flatMap((r) => (r.citations || []).filter(isDropped).map((c) => c.id)))];
const uncited = results.filter((r) => validCites(r).length === 0).map((r) => r.uid);
const withPaper = results.filter((r) => paperCites(r).length > 0).length;

let md = "";
md += "# Elderberry Lit-Synth — Always-Agentic Query Step (10-compound test, v2: cite-everything)\n\n";
md += `Generated: 2026-06-14 · Source study: \`All compounds before screening_2026.xlsx\` (subset)\n\n`;
md += "**What this tests.** A prototype of the redesigned *query step*: one Claude subagent per compound drives its own PubChem + PubMed + Europe PMC + LOTUS research (nothing templated), then reasons **only from what it retrieved**.\n\n";
md += "**Citation policy (this version).** The agent must **cite every source it actually reasoned from** — including non-elderberry papers and hits it considered and rejected — as one of three anchor types: a **PubMed paper** (PMID), the **PubChem** identity record (CID), or the **LOTUS/Wikidata** occurrence record (QID). It writes only the id + role + a short *note on what the source contributed*; all paper metadata is fetched **verbatim from PubMed esummary**. Because every claim must be anchored, **no compound is uncited**. A `context`/`identity` citation never upgrades the provenance label — provenance still needs `occurrence`-grade evidence or a LOTUS QID listing the taxon.\n\n";

md += "## Headline\n\n";
md += `- **${withPaper}/10 compounds now carry primary-paper citations**, and **${uncited.length === 0 ? "every compound" : `${10 - uncited.length}/10`} is anchored** to at least one verifiable source.\n`;
md += `- Total evidence trail: **${nPapers} PubMed papers · ${nPubchem} PubChem identity records · ${nLotus} LOTUS occurrence records** = ${allValid.length} citations.\n`;
md += `- Paper metadata is verbatim from esummary; ${droppedPmids.length ? `**${droppedPmids.length} unresolved PMID(s) auto-dropped** (${droppedPmids.join(", ")})` : "every agent-supplied PMID resolved"}.\n`;
md += `- **uid 57** (which had 0 citations before) now shows the maize/avocado annotations and false-friend hits it reasoned from — cited as \`context\`, so it stays honestly \`unknown\` while exposing its full evidence trail.\n`;
if (uncited.length) md += `- ⚠ Still uncited (investigate): ${uncited.join(", ")}.\n`;
md += "\n";

md += "## Before / after\n\n";
md += "| uid | compound | v3 (hardcoded) | agentic | papers | total cites | provenance |\n";
md += "|---|---|---|---|:--:|:--:|---|\n";
for (const r of results) {
  const v = V3[r.uid] || {};
  const before = `${v.prov || "?"}${v.nolit ? " · no-lit" : ""}`;
  const short = r.name.length > 38 ? r.name.slice(0, 36) + "…" : r.name;
  md += `| ${r.uid} | ${short} | ${before} | ${dispLabel(r.disposition)} | ${paperCites(r).length} | ${validCites(r).length} | ${provLabel(r.provenance)} |\n`;
}
md += "\n";

md += "## Results\n\n";
for (const r of results) {
  const v = V3[r.uid] || {};
  md += `### ${r.uid}. ${r.name}\n\n`;
  md += `_Test role: ${v.role || "—"}_\n\n`;
  md += `**NEW agentic verdict — Biogenic provenance: ${provLabel(r.provenance)}  ·  Detection disposition: ${dispLabel(r.disposition)}  ·  ${validCites(r).length} sources cited (below)**\n\n`;
  md += `Formula: ${r.formula}`;
  if (r.identity && r.identity.cid) md += ` · PubChem CID ${r.identity.cid} · InChIKey ${r.identity.inchikey || "—"}`;
  md += "\n\n";
  const oldStr = v.nolit ? `${v.prov || "?"} — "no literature retrieved"` : `${v.prov || "?"}`;
  md += `> **Comparison only — this is the OLD result we replaced.** The old hardcoded pipeline returned: _${oldStr}_.`;
  if (v.nolit) md += ` That "no literature retrieved" was the **bug** — the new run below retrieved ${validCites(r).length} sources for this compound.`;
  md += `\n\n`;
  if (r.occurrence_basis) md += `Occurrence basis: ${r.occurrence_basis}\n\n`;
  md += r.paragraph + "\n\n";

  const vc = validCites(r);
  md += `Evidence trail _(every source the agent reasoned from · ${vc.length} citations)_:\n\n`;
  vc.forEach((c, i) => { md += renderCite(c, i + 1) + "\n"; });
  md += "\n";
  const bad = (r.citations || []).filter(isDropped);
  if (bad.length) md += `> ⚠ ${bad.length} agent-supplied PMID(s) did not resolve in PubMed esummary and were dropped: ${bad.map((c) => c.id).join(", ")}\n\n`;

  const tries = (r.identity && r.identity.names_considered && r.identity.names_considered.length) || 0;
  md += `<details><summary><b>Search trace</b> — ${tries} names considered, ${r.search_trace.length} queries run</summary>\n\n`;
  md += "| db | query | hits | kept |\n|---|---|:--:|---|\n";
  for (const s of r.search_trace) {
    const q = (s.query || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    md += `| ${s.db} | ${q} | ${s.n_hits} | ${(s.kept_pmids || []).join(", ") || "—"} |\n`;
  }
  md += "\n</details>\n\n---\n\n";
}

fs.writeFileSync(outPath, md);
console.log(`wrote ${outPath}`);
console.log(`citations: ${nPapers} papers + ${nPubchem} pubchem + ${nLotus} lotus = ${allValid.length}; dropped PMIDs: ${droppedPmids.join(", ") || "none"}; uncited compounds: ${uncited.join(", ") || "none"}`);
