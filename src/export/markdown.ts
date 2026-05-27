/**
 * Writes the final markdown report to disk.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Citation,
  CompoundSynthesis,
  ScreenedCompound,
} from "../types.js";

export interface ReportInput {
  sourceFile: string;
  sampleContext: string;
  selectedComparisons: string[];
  /** All ranked + screened candidates shown to the user (size M). */
  candidates: ScreenedCompound[];
  /** Compounds the user approved and that were synthesized (size N). */
  syntheses: CompoundSynthesis[];
  /** 1-based indices into `candidates` that the user selected. */
  selectedIndices: number[];
}

function formatCitation(c: Citation, n: number): string {
  const authors = c.authors_string || "Unknown authors";
  const year = c.year ? ` (${c.year})` : "";
  const venue =
    c.source === "pubmed" ? "PubMed" : c.url.includes("doi.org") ? "" : "Semantic Scholar";
  const venuePart = venue ? ` ${venue}.` : "";
  return [
    `${n}. ${authors}${year}. ${c.title}.${venuePart} [${c.url}](${c.url})`,
    `   Relevance: ${c.relevance_note}`,
  ].join("\n");
}

export async function writeReport(
  outputPath: string,
  data: ReportInput,
): Promise<string> {
  const abs = resolve(outputPath);
  const selectedSet = new Set(data.selectedIndices);
  const overrideCount = data.syntheses.filter(
    (s) =>
      s.compound.plausibility !== "known" &&
      s.compound.plausibility !== "plausible",
  ).length;

  const lines: string[] = [];
  lines.push("# Metabolomics Literature Synthesis Report", "");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source file: ${data.sourceFile}`);
  lines.push(`Sample context: ${data.sampleContext.replace(/\n+/g, " ")}`);
  lines.push(
    `Comparisons used: ${data.selectedComparisons.join("; ")}`,
    "",
  );

  lines.push("## Summary", "");
  lines.push(
    `${data.syntheses.length} compound${
      data.syntheses.length === 1 ? "" : "s"
    } synthesized from ${data.candidates.length} candidate${
      data.candidates.length === 1 ? "" : "s"
    } (${overrideCount} compound${
      overrideCount === 1 ? "" : "s"
    } below the plausible tier, included by user override).`,
    "",
  );

  lines.push("## Results", "");
  for (const s of data.syntheses) {
    const c = s.compound;
    lines.push(`### ${c.name}`, "");
    lines.push(
      `Formula: ${c.formula ?? "n/a"} | m/z: ${
        c.mz ?? "n/a"
      } | RT: ${c.rt ?? "n/a"} | Confidence: ${s.result.confidence}`,
      "",
    );
    lines.push(s.result.synthesis_paragraph.trim(), "");

    if (s.result.citations.length > 0) {
      lines.push("Citations:");
      s.result.citations.forEach((cit, i) => {
        lines.push(formatCitation(cit, i + 1));
      });
      lines.push("");
    } else {
      lines.push("Citations: none validated.", "");
    }

    if (s.result.caveats) {
      lines.push(`Caveats: ${s.result.caveats}`, "");
    }
    lines.push("---", "");
  }

  lines.push("## Appendix: Skipped Compounds", "");
  const skipped = data.candidates.filter(
    (_, i) => !selectedSet.has(i + 1),
  );
  if (skipped.length === 0) {
    lines.push("None — every candidate was synthesized.", "");
  } else {
    lines.push(
      "Compounds the user excluded (audit trail):",
      "",
      "| Name | Plausibility | PubMed hits | Reason |",
      "| --- | --- | --- | --- |",
    );
    for (const c of skipped) {
      lines.push(
        `| ${c.name} | ${c.plausibility} | ${c.pubmedHits} | ${
          c.plausibilityReason ?? ""
        } |`,
      );
    }
    lines.push("");
  }

  await writeFile(abs, lines.join("\n"), "utf8");
  return abs;
}
