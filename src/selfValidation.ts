/**
 * selfValidation.ts - Forces model to self-validate before finishing.
 *
 * Inspired by Rakuten's report on Fable 5: "At the highest effort setting,
 * Claude Fable 5 reflects on and validates its own work. For us, that's what
 * makes highly autonomous operations possible."
 *
 * Implementation: when the agent is about to finish a turn (finish_reason
 * = "stop") AND it touched files in this turn, we inject a synthetic
 * system message that BLOCKS the finish and forces the model to answer:
 *   1. What did I change?
 *   2. What tests did I run to verify?
 *   3. What errors still remain?
 *   4. What edge cases did I consider?
 *
 * Only after the model has answered these questions (in a pensar() call
 * or as text) do we let it actually finish.
 *
 * Throttle: at most 1 self-validation per turn (don't loop forever).
 */

import * as history from "./history.js";
import * as log from "./logger.js";
import { getEffortLevel } from "./effortLevels.js";

let validationCountThisTurn = 0;
const MAX_VALIDATIONS_PER_TURN = 1;

/** Reset counter - call at the start of each user turn. */
export function resetSelfValidation(): void {
  validationCountThisTurn = 0;
}

/**
 * Returns true if we should block the finish_reason and force self-validation.
 * Conditions:
 *   - Model touched files this turn (otherwise it was just chatting)
 *   - Haven't already validated this turn
 *   - Effort level is Medium or higher (low effort = quick tasks, skip)
 */
export function shouldSelfValidate(touchedFilesCount: number): boolean {
  if (touchedFilesCount === 0) return false;
  if (validationCountThisTurn >= MAX_VALIDATIONS_PER_TURN) return false;
  const effort = getEffortLevel();
  if (effort === "low") return false; // user opted for speed
  return true;
}

/**
 * Inject the self-validation prompt as a system message.
 * Returns the prompt that was injected (for logging).
 */
import { t } from "./i18n.js";

export function injectSelfValidationPrompt(touchedFiles: string[]): string {
  validationCountThisTurn++;

  const fileList = touchedFiles.length > 5
    ? touchedFiles.slice(0, 5).join("\n  - ") + `\n  - ... and ${touchedFiles.length - 5} more`
    : touchedFiles.join("\n  - ");

  const prompt = t("prompt.self_validation", fileList);

  history.addSystemMessage(prompt);
  log.debug(`[SELF_VAL] Injected self-validation prompt (turn validations: ${validationCountThisTurn})`);
  return prompt;
}
