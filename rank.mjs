#!/usr/bin/env node
/**
 * Rank Compound Discoverer compounds by composite statistical score.
 * Self-contained — resolves `xlsx` from this skill's own node_modules.
 * Intentionally omits any plausibility classification or contaminant filtering.
 *
 * Filter: adj.p < 0.05 AND |log2 FC| > 1
 * Score:  |log2 FC| × -log10(adj.p + 1e-300)
 *
 *   node rank.mjs --xlsx <path> --list
 *   node rank.mjs --xlsx <path> --comparisons 3,9,15 --top 5
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
  if (next && !next.startsWith("--")) {
    args[key] = next;
    i++;
  } else {
    args[key] = true;
  }
}

const xlsxPath = args.xlsx;
if (!xlsxPath) {
  console.error("Usage: rank.mjs --xlsx <path> [--list | --comparisons 3,9,15 --top 5]");
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheetName = wb.SheetNames.includes("Compounds") ? "Compounds" : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false });
const header = rows[0];

const findCol = (predicate) => header.findIndex((h) => predicate(String(h ?? "").trim()));
const nameIdx = findCol((h) => h === "Name");
const formulaIdx = findCol((h) => h === "Formula" || h === "Molecular Formula");
const mzIdx = findCol((h) => /m\/z|Calc\.? MW|Mass/i.test(h) && !/RT/i.test(h));
const rtIdx = findCol((h) => /^RT( \[min\])?$/i.test(h));

const log2Cols = header
  .map((h, i) => ({ h: String(h ?? ""), i }))
  .filter(({ h }) => h.startsWith("Log2 Fold Change:"));
const adjPCols = header
  .map((h, i) => ({ h: String(h ?? ""), i }))
  .filter(({ h }) => h.startsWith("Adj. P-value:"));

const stripPrefix = (h, prefix) => h.slice(prefix.length).trim();
const log2Map = new Map(log2Cols.map(({ h, i }) => [stripPrefix(h, "Log2 Fold Change:"), i]));
const adjPMap = new Map(adjPCols.map(({ h, i }) => [stripPrefix(h, "Adj. P-value:"), i]));
const comparisonNames = log2Cols.map(({ h }) => stripPrefix(h, "Log2 Fold Change:"));

if (args.list) {
  console.log(JSON.stringify({
    sheet: sheetName,
    rows: rows.length - 1,
    available_comparisons: comparisonNames.map((n, i) => ({ n: i + 1, name: n })),
  }, null, 2));
  process.exit(0);
}

const comparisons = String(args.comparisons || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n));
const topN = parseInt(args.top ?? "5", 10);

if (comparisons.length === 0) {
  console.error("Pass --comparisons 3,9,15 (use --list to see available numbers).");
  process.exit(1);
}

const selectedDisplayNames = comparisons
  .map((n) => comparisonNames[n - 1])
  .filter((x) => x != null);
if (selectedDisplayNames.length !== comparisons.length) {
  console.error(`Invalid comparison number(s). Available: 1..${comparisonNames.length}`);
  process.exit(1);
}

const candidates = [];
const seen = new Set();

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const name = row[nameIdx];
  if (!name || typeof name !== "string" || !name.trim()) continue;
  const key = name.trim().toLowerCase();
  if (seen.has(key)) continue;

  let best = null;
  for (const cmp of selectedDisplayNames) {
    const li = log2Map.get(cmp);
    const pi = adjPMap.get(cmp);
    if (li == null || pi == null) continue;
    const fc = row[li];
    const p = row[pi];
    if (typeof fc !== "number" || !Number.isFinite(fc)) continue;
    const abs = Math.abs(fc);
    if (best === null || abs > best.absLog2Fc) {
      best = {
        comparison: cmp,
        absLog2Fc: abs,
        adjP: typeof p === "number" && Number.isFinite(p) ? p : NaN,
      };
    }
  }
  if (!best) continue;
  if (!Number.isFinite(best.adjP)) continue;
  if (best.adjP >= 0.05) continue;
  if (best.absLog2Fc <= 1) continue;

  const compositeScore = best.absLog2Fc * -Math.log10(best.adjP + 1e-300);
  candidates.push({
    name: name.trim(),
    formula: formulaIdx >= 0 ? row[formulaIdx] || null : null,
    mz: mzIdx >= 0 ? row[mzIdx] || null : null,
    rt: rtIdx >= 0 ? row[rtIdx] || null : null,
    bestComparison: best.comparison,
    absLog2Fc: best.absLog2Fc,
    adjP: best.adjP,
    compositeScore,
  });
  seen.add(key);
}

candidates.sort((a, b) => b.compositeScore - a.compositeScore);

console.log(JSON.stringify({
  source: xlsxPath,
  selected: selectedDisplayNames,
  total_passed_filter: candidates.length,
  top: candidates.slice(0, topN),
}, null, 2));
