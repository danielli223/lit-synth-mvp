#!/usr/bin/env node
/**
 * Render a Markdown report to a PDF with clickable links.
 * Uses `marked` for md->html and the user's installed Chrome for html->pdf.
 *
 *   node make-pdf.mjs <input.md> [output.pdf]
 *
 * If output is omitted, writes alongside the input with the same basename.
 */
import { marked } from "marked";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname, basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

const execFileP = promisify(execFile);

const [, , inArg, outArg] = process.argv;
if (!inArg) {
  console.error("Usage: make-pdf.mjs <input.md> [output.pdf]");
  process.exit(1);
}

const inPath = resolve(inArg);
const outPath = outArg
  ? resolve(outArg)
  : join(dirname(inPath), basename(inPath, extname(inPath)) + ".pdf");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const md = await readFile(inPath, "utf8");
const html = marked.parse(md, { gfm: true });

const wrapped = `<!doctype html>
<html><head><meta charset="utf-8">
<title>${basename(inPath)}</title>
<style>
  @page { margin: 0.7in; }
  body { font: 11pt/1.5 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif;
         color: #1a1a1a; max-width: 7.2in; margin: 0 auto; }
  h1 { font-size: 22pt; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
  h2 { font-size: 16pt; margin-top: 1.4em; border-bottom: 1px solid #eee; padding-bottom: .15em; }
  h3 { font-size: 13pt; margin-top: 1.2em; color: #222; }
  a { color: #0b5fa3; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; background: #f4f4f4;
         padding: 1px 4px; border-radius: 3px; font-size: 92%; }
  pre { background: #f4f4f4; padding: 10pt; border-radius: 4px; overflow-x: auto; }
  table { border-collapse: collapse; margin: 1em 0; font-size: 10pt; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 5pt 8pt; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  ol li, ul li { margin: .25em 0; }
  blockquote { border-left: 3px solid #ccc; margin: 1em 0; padding: .25em 1em; color: #555; }
</style>
</head><body>
${html}
</body></html>`;

const tmpHtml = join(tmpdir(), `elderberry-pdf-${process.pid}.html`);
await writeFile(tmpHtml, wrapped, "utf8");

try {
  await execFileP(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${outPath}`,
    `file://${tmpHtml}`,
  ]);
  console.log(`Wrote ${outPath}`);
} finally {
  await unlink(tmpHtml).catch(() => {});
}
