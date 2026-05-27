/**
 * Terminal table rendering for the candidate list, with colored plausibility
 * badges. `known`/`plausible` rows are bright; `unknown`/`unlikely` rows are
 * dimmed.
 */
import Table from "cli-table3";
import chalk from "chalk";
import type { Plausibility, ScreenedCompound } from "../types.js";

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function badge(p: Plausibility): string {
  switch (p) {
    case "known":
      return chalk.green("KNOWN");
    case "plausible":
      return chalk.cyan("PLAUSIBLE");
    case "unknown":
      return chalk.yellow("UNKNOWN");
    case "unlikely":
      return chalk.red("UNLIKELY");
  }
}

export function renderCandidateTable(rows: ScreenedCompound[]): string {
  const table = new Table({
    head: [
      "#",
      "Name",
      "Formula",
      "|log2FC|",
      "adj.p",
      "PMID hits",
      "Match",
      "Plausibility",
    ].map((h) => chalk.bold(h)),
    colWidths: [5, 32, 14, 10, 12, 11, 13, 14],
    wordWrap: false,
    style: { head: [], border: [] },
  });

  rows.forEach((c, i) => {
    const dim = c.plausibility === "unknown" || c.plausibility === "unlikely";
    const cell = (s: string) => (dim ? chalk.dim(s) : s);
    table.push([
      cell(String(i + 1)),
      cell(truncate(c.name, 30)),
      cell(truncate(c.formula ?? "—", 12)),
      cell(c.absLog2Fc.toFixed(2)),
      cell(c.adjPValue.toExponential(1)),
      cell(String(c.pubmedHits)),
      cell(truncate(c.chemspiderMatch ?? "—", 11)),
      badge(c.plausibility),
    ]);
  });

  return table.toString();
}

/** Lines like "[12] UNLIKELY: matches phthalate pattern". */
export function renderFlagReasons(rows: ScreenedCompound[]): string[] {
  const out: string[] = [];
  rows.forEach((c, i) => {
    if (c.plausibility === "known" || c.plausibility === "plausible") return;
    out.push(
      `${chalk.bold(`[${i + 1}]`)} ${badge(c.plausibility)}: ${
        c.plausibilityReason ?? "(no reason given)"
      }`,
    );
  });
  return out;
}
