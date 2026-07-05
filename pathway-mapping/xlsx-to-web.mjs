#!/usr/bin/env node
/** Render the xlsx into a browser-viewable HTML page + per-sheet CSVs.
 *  Honors merged cells (colspan) and the styled header fill so the web view
 *  matches pathway-membership.xlsx. */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("pathway-membership.xlsx");

const HEAD_ARGB = "FF274472";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const csvCell = (s) => { const v = String(s ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const refRC = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { r: +m[2], c }; };
const text = (v) => {
  if (v && typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if (v.hyperlink) return v.text != null ? v.text : v.hyperlink;
    if ("result" in v) return v.result;
  }
  return v;
};
const hrefOf = (v) => (v && typeof v === "object" && v.hyperlink) ? v.hyperlink : null;
const isHead = (cell) => cell.fill && cell.fill.fgColor && cell.fill.fgColor.argb === HEAD_ARGB;

let html = `<!doctype html><html><head><meta charset="utf-8"><title>Pathway membership</title>
<style>
body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1a1a1a;max-width:1500px}
h1{font-size:21px;margin:0 0 4px} h2{font-size:16px;margin:32px 0 6px;color:#274472;border-bottom:2px solid #274472;padding-bottom:4px}
.lead{color:#666;font-size:12px;margin:0 0 8px}
table{border-collapse:collapse;margin:8px 0 4px;font-size:13px}
th,td{border:1px solid #cbd5e1;padding:5px 9px;text-align:left;vertical-align:top}
th{background:#274472;color:#fff;position:sticky;top:0}
td.b{font-weight:600;color:#274472}
td.title{font-size:16px;font-weight:700;color:#1f3a5f;border:none;background:none;padding:8px 9px 2px}
td.cap{color:#666;font-style:italic;border:none;background:none}
td.num{text-align:center}
tbody tr:nth-child(even) td:not(.title):not(.cap){background:#f4f8fc}
</style></head><body>
<h1>Elderberry metabolites → 13 enriched SMPDB pathways (v2)</h1>
<p class="lead">Same content as pathway-membership.xlsx. Generated for viewing without a spreadsheet app.</p>`;

for (const ws of wb.worksheets) {
  // merge map: covered (non-anchor) cells to skip, and colspan per anchor
  const covered = new Set(), span = new Map();
  let ncols = 0;
  for (const m of (ws.model.merges || [])) {
    const [a, b] = m.split(":"), p = refRC(a), q = refRC(b);
    span.set(p.r + "," + p.c, q.c - p.c + 1);
    for (let r = p.r; r <= q.r; r++) for (let c = p.c; c <= q.c; c++) if (!(r === p.r && c === p.c)) covered.add(r + "," + c);
  }
  ws.eachRow((row, rn) => row.eachCell({ includeEmpty: false }, (cell, col) => { ncols = Math.max(ncols, col + ((span.get(rn + "," + col) || 1) - 1)); }));

  html += `<h2>${esc(ws.name)}</h2><table>`;
  const csvRows = [];
  ws.eachRow((row, rn) => {
    const cells = [], csvLine = [];
    for (let c = 1; c <= ncols; c++) {
      if (covered.has(rn + "," + c)) continue;
      const cell = row.getCell(c), t = text(cell.value), sp = span.get(rn + "," + c);
      const href = hrefOf(cell.value);
      const inner = href ? `<a href="${esc(href)}">${esc(t)}</a>` : esc(t);
      const attr = sp ? ` colspan="${sp}"` : "";
      if (isHead(cell)) {
        cells.push(`<th${attr}>${inner}</th>`);
      } else {
        const cls = [];
        if (cell.font && cell.font.size >= 14) cls.push("title");
        else if (cell.font && cell.font.italic) cls.push("cap");
        else if (cell.font && cell.font.bold) cls.push("b");
        if (cell.alignment && cell.alignment.horizontal === "center") cls.push("num");
        cells.push(`<td${attr}${cls.length ? ` class="${cls.join(" ")}"` : ""}>${inner}</td>`);
      }
      csvLine.push(csvCell(t));
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
