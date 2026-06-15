#!/usr/bin/env node
/**
 * Render the structured agentic sample into a readable markdown report,
 * GROUPED BY PROVENANCE (prominence) TIER: elderberry > other berry > other plant
 * > non-plant > unknown.
 *   node gen-sample3.mjs <workflow-output.json> <out.md>
 *
 * Enforces the occurrence INVARIANT: a plant tier (elderberry/other_berry/other_plant)
 * with no role:"occurrence" citation is downgraded to "unknown" (and flagged), so the
 * grouping is honest. Paper metadata is verbatim from PubMed esummary; PubChem CID and
 * LOTUS QID are formatted as formal database references.
 */
import fs from "node:fs";
import { fetchPubmedMeta } from "./cite.mjs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) { console.error("usage: gen-sample3.mjs <in.json> <out.md>"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const results = (raw.result || raw).slice().sort((a, b) => a.uid - b.uid);

const TIERS = [
  ["elderberry", "Elderberry (Sambucus)"],
  ["other_berry", "Other berry"],
  ["other_plant", "Other plant"],
  ["non_plant", "Non-plant"],
  ["unknown", "Source not established (known compound, plant origin not documented)"],
];
const TIER_LABEL = Object.fromEntries(TIERS);
const dispLabel = (d) => ({
  native_plausible: "native — plausibly belongs to this sample", oxidation_processing: "oxidation / processing artifact",
  synthetic_contaminant: "synthetic — contaminant / carry-over", misannotation: "misannotation",
  identity_unresolved: "identity unresolved", undetermined: "origin undetermined",
}[d] || d);

// Occurrence invariant: a plant tier must be backed by a role:"occurrence" citation
// (a paper, or a LOTUS QID listing the taxon). Otherwise it is honestly "unknown".
function effectiveProvenance(r) {
  const p = r.provenance;
  const isPlant = p === "elderberry" || p === "other_berry" || p === "other_plant";
  if (!isPlant) return { prov: p, downgraded: false };
  const hasOccurrence = (r.citations || []).some((c) => c.role === "occurrence");
  if (hasOccurrence) return { prov: p, downgraded: false };
  return { prov: "unknown", downgraded: true, original: p };
}

const pubmedIds = results.flatMap((r) => (r.citations || []).filter((c) => c.type === "pubmed").map((c) => c.id));
const META = await fetchPubmedMeta(pubmedIds);

const ROLE_ORDER = { occurrence: 0, identity: 1, context: 2 };
const orderedCites = (r) => (r.citations || [])
  .filter((c) => !(c.type === "pubmed" && !(META[String(c.id)] && META[String(c.id)].found)))
  .slice().sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));

function renderRef(c, n) {
  const ann = ` _(${c.role}${c.note ? ` — ${c.note}` : ""})_`;
  if (c.type === "pubmed") {
    const m = META[String(c.id)];
    const jrnl = m.journal ? ` *${m.journal}*.` : "";
    return `${n}. ${m.authors} (${m.year}). ${m.title}.${jrnl} PMID: ${c.id}. <https://pubmed.ncbi.nlm.nih.gov/${c.id}/>${ann}`;
  }
  if (c.type === "pubchem") return `${n}. National Center for Biotechnology Information. PubChem Compound Summary for CID ${c.id}. <https://pubchem.ncbi.nlm.nih.gov/compound/${c.id}>${ann}`;
  if (c.type === "lotus") return `${n}. LOTUS Natural Products Database (Wikidata ${c.id}). <https://www.wikidata.org/wiki/${c.id}>${ann}`;
  return `${n}. ${c.id}${ann}`;
}

// assign each compound to its effective tier
const groups = Object.fromEntries(TIERS.map(([k]) => [k, []]));
for (const r of results) { const e = effectiveProvenance(r); r._eff = e; groups[e.prov].push(r); }

let md = "";
md += "# Elderberry Lit-Synth — Sample Report\n\n";
md += `Generated: 2026-06-14 · ${results.length} compounds · grouped by biogenic provenance tier · always-agentic query step (PubChem + PubMed + Europe PMC + LOTUS)\n\n`;
md += "Each compound was researched by its own agent (run in parallel), grounding every statement in a retrieved source. Within each tier, entries give a brief description, where it has been reported, a reasoned elderberry assessment, and formal references. A plant-tier label with no occurrence citation is downgraded to *Unknown* (occurrence invariant).\n\n";
md += "## Contents\n\n";
for (const [key, label] of TIERS) if (groups[key].length) md += `- **${label}** — ${groups[key].length}\n`;
md += "\n---\n\n";

for (const [key, label] of TIERS) {
  const group = groups[key];
  if (!group.length) continue;
  md += `# ${label} (${group.length})\n\n`;
  for (const r of group) {
    md += `## ${r.name}\n\n`;
    md += `*Detection disposition: ${dispLabel(r.disposition)}* · Formula: ${r.formula}`;
    if (r.identity && r.identity.cid) md += ` · PubChem CID ${r.identity.cid}`;
    md += "\n\n";
    if (r._eff.downgraded) md += `> ⚠ Agent proposed **${TIER_LABEL[r._eff.original] || r._eff.original}**, but no occurrence citation backs it — placed in *Unknown* per the occurrence invariant.\n\n`;
    if (r.occurrence_basis) md += `Occurrence basis: ${r.occurrence_basis}\n\n`;
    md += `- **What it is:** ${r.what_it_is}\n`;
    md += `- **Where it's been reported:** ${r.where_reported}\n`;
    md += `- **Could it be in elderberry?** ${r.assessment}\n\n`;
    const cites = orderedCites(r);
    md += `**References**\n\n`;
    cites.forEach((c, i) => { md += renderRef(c, i + 1) + "\n"; });
    md += "\n";
    const tries = (r.identity && r.identity.names_considered && r.identity.names_considered.length) || 0;
    md += `<details><summary>Search trace — ${tries} names considered, ${r.search_trace.length} queries run</summary>\n\n`;
    md += "| db | query | hits | kept |\n|---|---|:--:|---|\n";
    for (const s of r.search_trace) md += `| ${s.db} | ${(s.query || "").replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${s.n_hits} | ${(s.kept_pmids || []).join(", ") || "—"} |\n`;
    md += "\n</details>\n\n---\n\n";
  }
}

fs.writeFileSync(outPath, md);
const dg = results.filter((r) => r._eff.downgraded).length;
console.log(`wrote ${outPath} (${results.length} compounds; tiers: ${TIERS.filter(([k]) => groups[k].length).map(([k, l]) => l + "=" + groups[k].length).join(", ")}; ${dg} downgraded by invariant)`);
