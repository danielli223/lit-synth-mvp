/** ora wrappers so long-running stages never look hung. */
import ora, { type Ora } from "ora";

export function startSpinner(text: string): Ora {
  return ora({ text, spinner: "dots" }).start();
}

/** Runs `fn` with a spinner; succeeds/fails the spinner around it. */
export async function withSpinner<T>(
  text: string,
  fn: (spinner: Ora) => Promise<T>,
  successText?: string,
): Promise<T> {
  const spinner = startSpinner(text);
  try {
    const result = await fn(spinner);
    spinner.succeed(successText ?? text);
    return result;
  } catch (e) {
    spinner.fail(`${text} — failed`);
    throw e;
  }
}
