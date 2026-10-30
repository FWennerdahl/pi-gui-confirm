/**
 * Accepts any arguments without checking them: for commands trusted with any arguments, where even the
 * automatic path check of allowedBashCommands is unwanted, like echo and pwd (echo /etc only prints
 * "/etc").
 *
 * The core still checks, before this runs: unquoted globs (the shell turns echo /etc/* into a listing
 * of /etc), the folder the command runs in, and excludedBashCommands.
 */
import type { BashValidator } from "./types.ts";

const anyArguments: BashValidator = () => ({ allowed: true });

export default anyArguments;
