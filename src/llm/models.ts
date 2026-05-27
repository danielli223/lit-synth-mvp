/**
 * Model selection (fetched from the OpenAI model list, May 2026).
 *
 * Per the build spec, Agent 2 uses the smallest current frontier model and
 * Agent 3 uses the strongest current model. The current family is GPT-5.x;
 * GPT-5.4 was selected over GPT-5.5 by explicit instruction.
 *
 *   - SCREEN_MODEL   = gpt-5.4-mini  (cheap batch plausibility classification)
 *   - SYNTHESIS_MODEL = gpt-5.4      (tool-using literature synthesis)
 *
 * Stable aliases are used so snapshots roll forward automatically.
 */
export const SCREEN_MODEL = "gpt-5.4-mini";
export const SYNTHESIS_MODEL = "gpt-5.4";
