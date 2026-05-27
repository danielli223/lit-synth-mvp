#!/usr/bin/env node
/**
 * lit-synth — CLI entry point.
 *
 *   lit-synth analyze <path-to-xlsx> [--output report.md]
 *                                    [--max-candidates 40]
 *                                    [--max-synthesize 20]
 */
import "dotenv/config";
import { Command } from "commander";
import chalk from "chalk";
import { runAnalyze } from "./commands/analyze.js";

const program = new Command();

program
  .name("lit-synth")
  .description(
    "Filter a Compound Discoverer export, screen for contaminants, and synthesize literature for approved compounds.",
  )
  .version("0.1.0");

program
  .command("analyze")
  .description("Run the interactive analysis pipeline on an .xlsx export.")
  .argument("<xlsx>", "path to the Compound Discoverer .xlsx export")
  .option("-o, --output <file>", "output markdown report path", "report.md")
  .option(
    "--max-candidates <n>",
    "max ranked candidates to screen/display",
    "40",
  )
  .option(
    "--max-synthesize <n>",
    "max compounds to synthesize",
    "20",
  )
  .option("--mock", "force the offline mock LLM (no OpenAI key needed)")
  .option(
    "--non-interactive",
    "run without prompts (use --context/--comparisons/--select)",
  )
  .option(
    "--context <text>",
    "sample context (non-interactive mode)",
  )
  .option(
    "--comparisons <csv>",
    "comparison numbers, e.g. 1,3 (non-interactive mode)",
  )
  .option(
    "--select <spec>",
    'candidate selection: "clean" or a range spec like 1-5,8 (non-interactive mode)',
    "clean",
  )
  .action(
    async (
      xlsx: string,
      opts: {
        output: string;
        maxCandidates: string;
        maxSynthesize: string;
        mock?: boolean;
        nonInteractive?: boolean;
        context?: string;
        comparisons?: string;
        select: string;
      },
    ) => {
      try {
        if (opts.mock) process.env.LIT_SYNTH_MOCK = "1";
        await runAnalyze({
          xlsxPath: xlsx,
          outputPath: opts.output,
          maxCandidates: Number(opts.maxCandidates),
          maxSynthesize: Number(opts.maxSynthesize),
          nonInteractive: Boolean(opts.nonInteractive),
          context: opts.context,
          comparisons: opts.comparisons,
          select: opts.select,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${msg}`));
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv);
