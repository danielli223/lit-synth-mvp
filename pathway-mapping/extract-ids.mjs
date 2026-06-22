#!/usr/bin/env node
/**
 * Extract the identified compounds (name + formula + PubChem CID + InChIKey)
 * from the elderberry Compound Discoverer export, for pathway-membership mapping.
 *
 *   node extract-ids.mjs --xlsx <path> [--out compounds-388.json]
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) { args[key] = next; i++; }
  else args[key] = true;
}
if (!args.xlsx) {
  console.error("Usage: extract-ids.mjs --xlsx <path> [--out <file>]");
  process.exit(1);
}

const wb = XLSX.readFile(args.xlsx);
const sheetName = wb.SheetNames.includes("Compounds") ? "Compounds" : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });
const H = rows[0];
const idx = (label) => H.findIndex((h) => String(h ?? "").trim() === label);
const norm = (s) => String(s ?? "").trim();

const ni = idx("Name");
const fi = idx("Formula") >= 0 ? idx("Formula") : idx("Molecular Formula");
const ci = idx("PubChem CID");
const ki = idx("InChIKey");

const compounds = [];
for (let r = 1; r < rows.length; r++) {
  const name = norm(rows[r][ni]);
  if (!name) continue;
  compounds.push({
    id: compounds.length + 1,
    name,
    formula: fi >= 0 ? norm(rows[r][fi]) : "",
    pubchem_cid: ci >= 0 ? norm(rows[r][ci]) : "",
    inchikey: ki >= 0 ? norm(rows[r][ki]) : "",
    inchikey_skeleton: ki >= 0 ? norm(rows[r][ki]).split("-")[0] : "",
  });
}

const out = {
  source: args.xlsx,
  count: compounds.length,
  with_inchikey: compounds.filter((c) => c.inchikey).length,
  with_cid: compounds.filter((c) => c.pubchem_cid).length,
  compounds,
};

const outFile = args.out || "compounds-388.json";
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  source: out.source,
  count: out.count,
  with_inchikey: out.with_inchikey,
  with_cid: out.with_cid,
  out: outFile,
}, null, 2));
