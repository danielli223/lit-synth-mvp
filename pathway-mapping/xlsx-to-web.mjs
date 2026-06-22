#!/usr/bin/env node
/** Render the xlsx into a browser-viewable HTML page + per-sheet CSVs. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("pathway-membership.xlsx");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const csvCell = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

let html = `<!doctype html><html><head><meta charset="utf-8"><title>Pathway membership</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1a1a1a;max-width:1400px}
h1{font-size:20px} h2{font-size:16px;margin-top:28px;border-bottom:2px solid #444;padding-bottom:4px}
table{border-collapse:collapse;margin:10px 0;font-size:13px}
th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f0f0f0;position:sticky;top:0}
tr:nth-child(even){background:#fafafa}
.note{color:#666;font-size:12px}
</style></head><body>
<h1>Elderberry metabolites → 13 enriched SMPDB pathways (v2)</h1>
<p class="note">Same content as pathway-membership.xlsx. Generated for viewing without a spreadsheet app.</p>`;

for (const ws of wb.worksheets) {
  html += `<h2>${esc(ws.name)}</h2><table>`;
  const csvRows = [];
  ws.eachRow((row, rn) => {
    const cells = [];
    const csvLine = [];
    const last = row.cellCount;
    for (let i = 1; i <= last; i++) {
      const v = row.getCell(i).value;
      const text = (v && typeof v === "object" && v.richText) ? v.richText.map((t) => t.text).join("") : v;
      cells.push(rn === 1 ? `<th>${esc(text)}</th>` : `<td>${esc(text)}</td>`);
      csvLine.push(csvCell(text));
    }
    html += `<tr>${cells.join("")}</tr>`;
    csvRows.push(csvLine.join(","));
  });
  html += `</table>`;
  const safe = ws.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(`csv-${safe}.csv`, csvRows.join("\n"));
}
html += `</body></html>`;
writeFileSync("pathway-membership.html", html);
console.log("Wrote pathway-membership.html and per-sheet CSVs:");
wb.worksheets.forEach((ws) => console.log("  csv-" + ws.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".csv"));
