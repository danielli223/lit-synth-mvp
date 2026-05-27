/**
 * Interactive terminal prompts for the analyze pipeline checkpoints.
 */
import { input, editor, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { parseNumberSelection } from "../util/selection.js";
import type { ScreenedCompound } from "../types.js";

/**
 * Prompts for sample context. Tries an $EDITOR pop; if no editor is
 * available, falls back to a single-line prompt.
 */
export async function gatherSampleContext(): Promise<string> {
  const message =
    "Describe your sample, organism, tissue, and research question:";
  try {
    const text = await editor({
      message,
      postfix: ".md",
      waitForUserInput: false,
    });
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  } catch {
    // Fall through to the inline prompt.
  }
  return (
    await input({
      message: `${message} (no $EDITOR found — type inline)`,
      validate: (v) =>
        v.trim().length > 0 ? true : "Sample context is required.",
    })
  ).trim();
}

/**
 * Shows the available pairwise comparisons and asks the user to pick 1–3.
 */
export async function selectComparisons(
  comparisons: string[],
): Promise<string[]> {
  console.log(chalk.bold("\nAvailable pairwise comparisons:"));
  comparisons.forEach((c, i) => {
    console.log(`  ${chalk.cyan(String(i + 1).padStart(3))}. ${c}`);
  });

  const answer = await input({
    message:
      "Which comparisons matter for your research question? Pick 1 to 3 (comma-separated numbers, e.g. 1,3,5):",
    validate: (raw) => {
      const { values, errors } = parseNumberSelection(
        raw,
        1,
        comparisons.length,
      );
      if (errors.length) return errors.join("; ");
      if (values.length < 1 || values.length > 3)
        return "Pick between 1 and 3 comparisons.";
      return true;
    },
  });

  const { values } = parseNumberSelection(answer, 1, comparisons.length);
  return values.map((n) => comparisons[n - 1]!);
}

/**
 * Asks which compounds to synthesize. Default (empty input) = all KNOWN +
 * PLAUSIBLE. Caps the selection at `maxSynthesize`.
 */
export async function selectCandidates(
  rows: ScreenedCompound[],
  maxSynthesize: number,
): Promise<number[]> {
  const defaultIdx = rows
    .map((r, i) =>
      r.plausibility === "known" || r.plausibility === "plausible" ? i + 1 : -1,
    )
    .filter((n) => n > 0);

  const answer = await input({
    message: `Enter compound numbers to synthesize (comma-separated, ranges allowed e.g. 1-5,8,12-15). Default is all KNOWN + PLAUSIBLE. Max ${maxSynthesize}:`,
    validate: (raw) => {
      if (!raw.trim()) return true; // default path
      const { errors } = parseNumberSelection(raw, 1, rows.length);
      return errors.length ? errors.join("; ") : true;
    },
  });

  let selected: number[];
  if (!answer.trim()) {
    selected = defaultIdx;
    if (selected.length === 0) {
      console.log(
        chalk.yellow(
          "No KNOWN/PLAUSIBLE compounds to default to — select numbers explicitly.",
        ),
      );
      return [];
    }
  } else {
    selected = parseNumberSelection(answer, 1, rows.length).values;
  }

  if (selected.length > maxSynthesize) {
    console.log(
      chalk.yellow(
        `Selection of ${selected.length} exceeds the cap of ${maxSynthesize}; keeping the first ${maxSynthesize}.`,
      ),
    );
    selected = selected.slice(0, maxSynthesize);
  }
  return selected;
}

export async function confirmSynthesis(n: number): Promise<boolean> {
  return confirm({
    message: `Synthesize these ${n} compound${n === 1 ? "" : "s"}?`,
    default: false,
  });
}
