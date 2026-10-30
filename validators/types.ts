/**
 * The contract for bash validators. A validator decides about one command from its arguments (without
 * the command name, so one validator can serve several names). It is enabled in pi-gui-confirm.json:
 *
 *   "bashValidators": { "grep": "grep" }   // the command grep is decided by validators/grep.ts
 *
 * The core still applies, before the validator runs: the shell parser, the folder the command runs in,
 * unquoted globs, and excludedBashCommands. A validator replaces allowedBashCommands and the generic
 * argument check for its command, and may allow or reject for any reason.
 */
import type { Word } from "../pi-gui-confirm.ts";

/** The core's checks, resolved from the folder the command runs in. */
export interface ValidatorHelpers {
  /** The generic rule for one argument: flags pass, --name=value checks the value, anything else must be a path inside. */
  argumentIsInside(word: Word): boolean;
  /** Whether the word, read as a path (~ expanded, symlinks resolved), is inside the session folder. */
  isInside(word: Word): boolean;
}

export type Verdict = { allowed: true } | { allowed: false; reason: string };

/** Decides about a command from its arguments. Must be a validator file's default export. */
export type BashValidator = (args: Word[], helpers: ValidatorHelpers) => Verdict;
