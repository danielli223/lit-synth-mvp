#!/usr/bin/env node
/**
 * Extract every NAMED compound from a Compound Discoverer export.
 *
 * No statistics, no ranking, no comparisons — identity only. Every row with a
 * Name is included. Compounds are de-duplicated by (name + formula): duplicate
 * rows are the same molecule re-detected as separate features, so only the
 * representative is researched; the rest are marked redundant and point to the
 * same unique id, to be mapped back after research.
 *
 *   node extract.mjs --xlsx <path>            # full JSON (unique list + row map)
 *   node extract.mjs --xlsx <path> --summary  # just the counts
 */
import { createRequire } from "node:module";
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
  console.error("Usage: extract.mjs --xlsx <path> [--summary]");
  process.exit(1);
}

const wb = XLSX.readFile(args.xlsx);
const sheetName = wb.SheetNames.includes("Compounds") ? "Compounds" : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });
const H = rows[0];

const exact = (label) => H.findIndex((h) => String(h ?? "").trim() === label);
const nameIdx = exact("Name");
const formulaIdx = exact("Formula") >= 0 ? exact("Formula") : exact("Molecular Formula");
const norm = (s) => String(s ?? "").trim();

const unique = new Map();   // key -> {uid, name, formula, feature_count, member_feature_ids}
const allRows = [];
let featureId = 0;

for (let r = 1; r < rows.length; r++) {
  const name = norm(rows[r][nameIdx]);
  if (!name) continue;                       // only named rows
  featureId++;
  const formula = formulaIdx >= 0 ? norm(rows[r][formulaIdx]) : "";
  const key = `${name.toLowerCase()}|${formula.toLowerCase()}`;

  let u = unique.get(key);
  let representative = false;
  if (!u) {
    u = { uid: unique.size + 1, name, formula, feature_count: 0, member_feature_ids: [] };
    unique.set(key, u);
    representative = true;                    // first occurrence is the one researched
  }
  u.feature_count++;
  u.member_feature_ids.push(featureId);

  allRows.push({ feature_id: featureId, name, formula, uid: u.uid, representative });
}

const out = {
  source: args.xlsx,
  total_named_rows: featureId,
  unique_count: unique.size,
  redundant_rows: featureId - unique.size,
  unique: [...unique.values()],
  rows: allRows,
};

if (args.summary) {
  console.log(JSON.stringify({
    source: out.source,
    total_named_rows: out.total_named_rows,
    unique_count: out.unique_count,
    redundant_rows: out.redundant_rows,
  }, null, 2));
} else {
  console.log(JSON.stringify(out, null, 2));
}
