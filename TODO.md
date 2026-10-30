# TODO

## Say why a tool call asks

Today the bash check only returns allowed or not (`bashIsAllowed` → `boolean`), so the dialog shows
the command but not what made it ask. Return a cause for every rejection and show it in the dialog,
and in the block reason when there is no UI (print/JSON mode). Causes to cover:

- The parser gave up (`parseBashCommands` → `undefined`): which construct, e.g. `$`, a redirection,
  an unfinished line, unsupported whitespace.
- `BASH_ENV` is set, or `shellPath` isn't bash or zsh (`shellIsSupported`).
- No allowed pattern matches a command, or an excluded pattern matches (which one).
- An argument points outside the session folder (which word, and where it resolves to).
- The folder a command runs in is unknown or outside, and which `cd` caused that.
- For non-bash tools: not in `alwaysAllow`, or the path is outside the session folder.

This also lets the tests assert the cause, not just allowed/asks, so a case can't pass for the
wrong reason.

## Validators per command

Refactor how bash commands are allowed. For each command, use an enabled validator for that command
if there is one; otherwise fall back to `allowedBashCommands`/`excludedBashCommands` plus the generic
argument check (`argumentIsInside`: every argument is treated as a possible path).

- Validators live in their own files (e.g. `validators/grep.ts`) and are enabled by the user in the
  config.
- A validator knows its command's options, so it can tell paths from other arguments: grep's search
  pattern isn't a path (`grep -rn "/api/" .` asks today), `-f`'s value is, `-R` follows symlinks.
- To decide: the validator interface (input: the parsed `ShellCommand` and the folder it runs in;
  output: allowed or a cause, see above); how validators are loaded (bundled and enabled by name, or
  any file path); whether `excludedBashCommands` still applies to commands with a validator.
- `cd` tracking, globs, `~`/`=`, `CDPATH` and `BASH_ENV` stay in the core check, for every command.

## Set up the rules in pi-gui-confirm.json

The real config hasn't been updated for the path check yet: its bare `grep`, `head`, `cd` and `echo`
entries only match those commands without arguments. Go through the commands to allow, one by one.
Starting points from earlier discussion:

- `ls( .*)?`, `grep( .*)?`, `head( .*)?`, `cd( .*)?`, `echo( .*)?`: every argument is checked as a
  path anyway, so `.*` is safe.
- Exclude flags that follow symlinks while recursing: `grep -R`/`-S`/`-O`, `ls -L`/`--dereference`.
- `git (status|log|diff|show)( .*)?` already exists; it should also exclude `--output` (writes a
  file), `--no-index` (diffs any two files) and `--ext-diff` (runs a program).
- Only commands that read; see "Only allow commands that read" in AGENTS.md.

May change once validators exist (above).

## Override the config from the user's pi folder

Today the config is only read from `pi-gui-confirm.json` next to the extension. Make it possible to
override it with a `pi-gui-confirm.json` in the user's pi folder (`~/.pi/agent/`, or wherever
`PI_CODING_AGENT_DIR` points; pi exports `getAgentDir()`), so the repo's file holds the defaults.
To decide:

- Merge per field: does the user's list replace the default list, or add to it? Adding is handy for
  `alwaysAllow`, but then a default can't be removed.
- If the user's file is invalid: every tool call asks, as today for an invalid config, with a warning
  that names the file.
- Read both on every tool call, as today, so changes apply immediately.

## Clean up tests that are no longer relevant

`pi-gui-confirm.test.ts` grew through several designs (the `{path}` token, the marker, then checking
every argument). Go through it and remove cases that only made sense for a dropped design or
duplicate another case, and regroup what is left if the `describe` blocks no longer fit.

## Get a second review of the bash check

The shell parser and the bash check (`parseBashCommands`, `bashIsAllowed` and the helpers in
`pi-gui-confirm.ts`) are security logic with many edge cases, and the code and its tests were written
in the same session. Have them reviewed by a fresh session or another model, given only `README.md`
and `AGENTS.md` as context, looking for:

- commands that are allowed but read outside the session folder, or run something unexpected
  (quoting, escapes, globs, separators, `cd` tracking, zsh differences);
- test cases that pass for the wrong reason (easier once the check reports a cause, see above);
- places where the code is hard to follow.

## Allow edits and writes in safe paths

`edit` and `write` always ask (`ALWAYS_ASK` in `pi-gui-confirm.ts`). pi's tools themselves can write
anywhere: absolute paths and `../` work. Allow them without asking for paths the user marks as safe,
inside the session folder. Things to handle:

- `write` creates files, so `realpathSync` fails and the check falls back to the path's text: through
  a symlinked folder, `link/new.txt` would be created outside. Resolve the nearest existing parent
  folder through `realpathSync` instead.
- Files inside the repo that make code run later must stay excluded, e.g. `.git/` (hooks,
  `core.fsmonitor` runs on `git status`), `.pi/` (extensions), `.envrc`, `package.json` scripts.
- A config field for the safe paths (globs relative to the session folder?), and how it interacts
  with the "show the change and wait for a yes" rule in `~/.pi/agent/AGENTS.md`.
