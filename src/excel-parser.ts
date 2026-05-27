/**
 * Deterministic parse stage.
 *
 * Reads the "Compounds" sheet of a Compound Discoverer export and extracts
 * only the columns the pipeline needs. Unnamed features are discarded here;
 * deduplication is deferred until the user has chosen comparisons (Stage 1).
 */
// SheetJS `xlsx` is CJS; under NodeNext ESM the namespace import does not
// expose readFile/utils — the default (esModuleInterop) does.
import XLSX from "xlsx";
import type { CompoundRow, ParsedWorkbook } from "./types.js";

const LOG2FC_PREFIX = "Log2 Fold Change: ";
const ADJP_PREFIX = "Adj. P-value: ";
const SHEET_NAME = "Compounds";

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Parses the workbook at `filePath`. Throws on a missing/invalid sheet. */
export function parseWorkbook(filePath: string): ParsedWorkbook {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheet = wb.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(
      `Sheet "${SHEET_NAME}" not found. Available sheets: ${wb.SheetNames.join(
        ", ",
      )}`,
    );
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  });
  if (rows.length < 2) {
    throw new Error(`Sheet "${SHEET_NAME}" has no data rows.`);
  }

  const header = (rows[0] as unknown[]).map((h) => String(h ?? "").trim());
  const col = (name: string): number => header.indexOf(name);

  const idx = {
    name: col("Name"),
    formula: col("Formula"),
    mz: col("m/z"),
    rt: col("RT [min]"),
    csResults: col("# ChemSpider Results"),
    csMatch: col("Annot. Source: ChemSpider Search"),
  };
  if (idx.name < 0) {
    throw new Error('Required column "Name" not found in the Compounds sheet.');
  }

  // Discover comparison columns. A comparison is keyed by the suffix after
  // the "Log2 Fold Change: " prefix; the matching adjusted p-value column
  // shares that same suffix.
  const log2fcCols = new Map<string, number>();
  const adjPCols = new Map<string, number>();
  header.forEach((h, i) => {
    if (h.startsWith(LOG2FC_PREFIX)) {
      log2fcCols.set(h.slice(LOG2FC_PREFIX.length), i);
    } else if (h.startsWith(ADJP_PREFIX)) {
      adjPCols.set(h.slice(ADJP_PREFIX.length), i);
    }
  });
  const comparisons = [...log2fcCols.keys()];

  const out: CompoundRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    const name = toStringOrNull(row[idx.name]);
    if (!name) continue; // drop unnamed features

    const log2fc: Record<string, number | null> = {};
    const adjP: Record<string, number | null> = {};
    for (const [cmp, ci] of log2fcCols) {
      log2fc[cmp] = toNumber(row[ci]);
      const pi = adjPCols.get(cmp);
      adjP[cmp] = pi === undefined ? null : toNumber(row[pi]);
    }

    out.push({
      name,
      formula: idx.formula >= 0 ? toStringOrNull(row[idx.formula]) : null,
      mz: idx.mz >= 0 ? toNumber(row[idx.mz]) : null,
      rt: idx.rt >= 0 ? toNumber(row[idx.rt]) : null,
      chemspiderResults:
        idx.csResults >= 0 ? toNumber(row[idx.csResults]) : null,
      chemspiderMatch:
        idx.csMatch >= 0 ? toStringOrNull(row[idx.csMatch]) : null,
      log2fc,
      adjP,
    });
  }

  return { comparisons, rows: out };
}

/**
 * Deduplicates rows by compound name. Among rows sharing a name, the one with
 * the strongest signal across the user-selected comparisons is kept
 * (largest max|log2FC|; ties broken by the smallest adjusted p-value).
 */
export function dedupByName(
  rows: CompoundRow[],
  selectedComparisons: string[],
): CompoundRow[] {
  const signal = (row: CompoundRow): { fc: number; p: number } => {
    let fc = 0;
    let p = Infinity;
    for (const cmp of selectedComparisons) {
      const v = row.log2fc[cmp];
      if (v != null && Math.abs(v) > fc) {
        fc = Math.abs(v);
        const pv = row.adjP[cmp];
        p = pv != null ? pv : Infinity;
      }
    }
    return { fc, p };
  };

  const best = new Map<string, CompoundRow>();
  for (const row of rows) {
    const existing = best.get(row.name);
    if (!existing) {
      best.set(row.name, row);
      continue;
    }
    const a = signal(row);
    const b = signal(existing);
    if (a.fc > b.fc || (a.fc === b.fc && a.p < b.p)) {
      best.set(row.name, row);
    }
  }
  return [...best.values()];
}
