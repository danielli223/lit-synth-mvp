/**
 * Orchestrates the three-stage interactive pipeline.
 *
 *   Stage 1  Context gathering   (parse, sample context, comparison pick)
 *   Stage 2  Filter + flag       (Agent 1 ranking, Agent 2 screening)
 *   Stage 3  Literature synthesis (Agent 3 per compound) + report
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { parseWorkbook, dedupByName } from "../excel-parser.js";
import { rankCompounds, sortByPlausibility, DEFAULT_THRESHOLDS } from "../ranking.js";
import { screenCompounds } from "../agents/screen-agent.js";
import { synthesizeCompound } from "../agents/synthesis-agent.js";
import { writeReport } from "../export/markdown.js";
import {
  gatherSampleContext,
  selectComparisons,
  selectCandidates,
  confirmSynthesis,
} from "../ui/prompts.js";
import { renderCandidateTable, renderFlagReasons } from "../ui/table.js";
import { withSpinner } from "../ui/spinner.js";
import { parseNumberSelection } from "../util/selection.js";
import type { CompoundSynthesis } from "../types.js";

export interface AnalyzeOptions {
  xlsxPath: string;
  outputPath: string;
  maxCandidates: number;
  maxSynthesize: number;
  /** When true, skip all prompts and use the supplied values. */
  nonInteractive?: boolean;
  context?: string;
  comparisons?: string;
  select?: string;
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<void> {
  const xlsxPath = resolve(opts.xlsxPath);
  if (!existsSync(xlsxPath)) {
    throw new Error(`File not found: ${xlsxPath}`);
  }
  const maxCandidates = Number.isFinite(opts.maxCandidates)
    ? Math.max(1, opts.maxCandidates)
    : 40;
  const maxSynthesize = Number.isFinite(opts.maxSynthesize)
    ? Math.max(1, Math.min(opts.maxSynthesize, 20))
    : 20;

  // ---- Stage 1: Context gathering ----------------------------------------
  console.log(chalk.bold("\nStage 1 — Context\n"));
  const parsed = parseWorkbook(xlsxPath);
  if (parsed.comparisons.length === 0) {
    throw new Error(
      'No "Log2 Fold Change:" comparison columns found in the export.',
    );
  }
  console.log(
    chalk.dim(
      `Parsed ${parsed.rows.length} named feature rows; ${parsed.comparisons.length} pairwise comparisons available.`,
    ),
  );

  let sampleContext: string;
  let selectedComparisons: string[];
  if (opts.nonInteractive) {
    sampleContext = (opts.context ?? "").trim();
    if (!sampleContext) {
      throw new Error("--non-interactive requires --context.");
    }
    const { values, errors } = parseNumberSelection(
      opts.comparisons ?? "",
      1,
      parsed.comparisons.length,
    );
    if (errors.length || values.length < 1 || values.length > 3) {
      throw new Error(
        `--comparisons must be 1-3 valid numbers (1-${parsed.comparisons.length}). ${errors.join("; ")}`,
      );
    }
    selectedComparisons = values.map((n) => parsed.comparisons[n - 1]!);
  } else {
    sampleContext = await gatherSampleContext();
    selectedComparisons = await selectComparisons(parsed.comparisons);
  }
  console.log(
    chalk.dim(`Using comparisons: ${selectedComparisons.join("; ")}`),
  );

  const deduped = dedupByName(parsed.rows, selectedComparisons);
  console.log(
    chalk.dim(`${deduped.length} unique named compounds after dedup.`),
  );

  // ---- Stage 2: Filtering and plausibility screening ---------------------
  console.log(chalk.bold("\nStage 2 — Filter & screen for sample plausibility\n"));
  const screened = await withSpinner(
    "Ranking compounds and checking each against PubMed for the sample...",
    async () => {
      const ranked = rankCompounds(deduped, selectedComparisons, {
        ...DEFAULT_THRESHOLDS,
        maxCandidates,
      });
      if (ranked.length === 0) {
        throw new Error(
          "No compounds passed the ranking thresholds (adj.p < 0.05, |log2FC| > 1) for the selected comparisons.",
        );
      }
      const plausibilityScored = await screenCompounds(ranked, sampleContext);
      // Re-sort: plausibility tier first, composite score second.
      return sortByPlausibility(plausibilityScored);
    },
    "Ranking and screening complete",
  );

  console.log();
  console.log(renderCandidateTable(screened));
  const reasons = renderFlagReasons(screened);
  if (reasons.length) {
    console.log();
    reasons.forEach((r) => console.log(r));
  }
  console.log();

  let selectedIndices: number[];
  if (opts.nonInteractive) {
    const spec = (opts.select ?? "default").trim().toLowerCase();
    if (spec === "default" || spec === "clean" || spec === "") {
      selectedIndices = screened
        .map((r, i) =>
          r.plausibility === "known" || r.plausibility === "plausible"
            ? i + 1
            : -1,
        )
        .filter((n) => n > 0);
    } else {
      const { values, errors } = parseNumberSelection(
        spec,
        1,
        screened.length,
      );
      if (errors.length) {
        throw new Error(`--select: ${errors.join("; ")}`);
      }
      selectedIndices = values;
    }
    if (selectedIndices.length > maxSynthesize) {
      console.log(
        chalk.yellow(
          `Selection of ${selectedIndices.length} exceeds cap ${maxSynthesize}; keeping first ${maxSynthesize}.`,
        ),
      );
      selectedIndices = selectedIndices.slice(0, maxSynthesize);
    }
    console.log(
      chalk.dim(
        `Non-interactive: synthesizing ${selectedIndices.length} compound(s).`,
      ),
    );
  } else {
    selectedIndices = await selectCandidates(screened, maxSynthesize);
  }
  if (selectedIndices.length === 0) {
    console.log(chalk.yellow("Nothing selected. Exiting."));
    return;
  }
  if (!opts.nonInteractive) {
    const ok = await confirmSynthesis(selectedIndices.length);
    if (!ok) {
      console.log(chalk.yellow("Aborted before synthesis."));
      return;
    }
  }

  // ---- Stage 3: Literature synthesis -------------------------------------
  console.log(chalk.bold("\nStage 3 — Literature synthesis\n"));
  const chosen = selectedIndices.map((n) => screened[n - 1]!);
  const syntheses: CompoundSynthesis[] = [];

  for (let i = 0; i < chosen.length; i++) {
    const compound = chosen[i]!;
    const tag = `[${i + 1}/${chosen.length}]`;
    process.stdout.write(`${tag} Processing: ${compound.name}...\n`);
    try {
      const synthesis = await synthesizeCompound(compound, sampleContext);
      syntheses.push(synthesis);
      const dropped =
        synthesis.droppedCitations > 0
          ? chalk.yellow(
              ` (${synthesis.droppedCitations} citation(s) dropped)`,
            )
          : "";
      console.log(
        `${tag} ${compound.name}: ${
          synthesis.result.citations.length
        } citations, confidence: ${synthesis.result.confidence}${dropped}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(
        chalk.red(`${tag} ${compound.name}: synthesis failed — ${msg}`),
      );
    }
  }

  if (syntheses.length === 0) {
    console.log(chalk.red("\nNo syntheses produced; report not written."));
    return;
  }

  const savedPath = await writeReport(opts.outputPath, {
    sourceFile: xlsxPath,
    sampleContext,
    selectedComparisons,
    candidates: screened,
    syntheses,
    selectedIndices,
  });
  console.log(chalk.green(`\nSaved report to ${savedPath}`));
}
