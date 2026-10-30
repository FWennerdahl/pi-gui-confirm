# AGENTS.md

Guidance for agents working on pi-gui-confirm. Personal project: one maintainer, no reviewers.

## What this is

A Pi extension that asks for confirmation before tool calls, unless `pi-gui-confirm.json` allows them.
It enforces confirmation in Pi itself, so it doesn't depend on the model following instructions.

| File | Purpose |
|---|---|
| `pi-gui-confirm.ts` | The extension: config loading, shell command parser, bash check, dialog |
| `pi-gui-confirm.json` | The user's allow lists (read on every tool call) |
| `bash-summary.ts` | Optional: replaces the bash tool with one that takes a `summary` for the dialog title |
| `pi-gui-confirm.test.ts` | Tests for the parser and the bash check (`node:test`) |
| `validators/` | Per-command validators (`grep.ts`), their contract (`types.ts`) and their tests |
| `README.md` | User documentation: config fields and the rules for shell commands |
| `TODO.md` | Open work and ideas |

## Working with the maintainer

- Discuss design before implementing. Explain trade-offs with concrete example commands, and
  recommend one option. Implement only when asked.
- Prefer the simplest design that is safe. If a design grows complex, stop and say so; the simpler
  option is often the right one.
- Don't commit, don't create branches, don't stash or otherwise touch git state. The maintainer
  reviews the diff and commits. If a command would change git state, say so first.
- Before running something non-obvious (scripts, anything outside the repo), say what and why.

## Human readability

Code and docs are read by a person reviewing diffs, so optimize for that:

- Plain names and short functions. A comment says *why*, not what; give an example when the reason
  isn't obvious (e.g. `// $OLDPWD: only known after an earlier cd in the same line`).
- Doc comments on every function that isn't trivial, in one or two sentences.
- No clever regex or type tricks when a few plain lines do the same.
- README and TODO.md: short sentences, concrete examples, no filler.

## Design decisions

These hold until the maintainer decides otherwise (then update this file, see below).

- **Fail safe.** When the check can't tell, it asks. Never widen what is allowed to avoid a prompt;
  an extra prompt is always the acceptable failure.
- **`edit` and `write` always ask** (`ALWAYS_ASK`), whatever the config says. Planned change: see
  TODO.md.
- **Shell parsing.** `parseBashCommands` splits a line into commands and words, removing quotes and
  escapes like bash/zsh do. Anything it doesn't fully understand (`$`, backticks, redirections,
  subshells, groups, syntax errors, unusual whitespace) makes the whole line ask.
- **Patterns** in `allowedBashCommands`/`excludedBashCommands` are plain regexes matched against the
  whole normalized command (words joined by single spaces). Exclusions are `{ pattern, reason }`; a
  missing or empty reason reports the pattern instead. There is no `{path}` token: it was tried
  and dropped as too complex.
- **Every argument is checked as a possible path** (`argumentIsInside`). Which arguments a program
  reads as paths isn't known, so all of them must stay inside the session folder (`ctx.cwd`).
  Flags pass, but every possible attached value (every rest of the word) is checked as a path;
  `--name=value` and `name=value` check the value; quotes don't exempt a word. Accepted cost: arguments
  that only look like outside paths ask (`grep -r "/api/" .`), unless the command has a validator.
- **Validators** (`validators/<name>.ts`, enabled per command in `bashValidators`) decide about one
  command instead of `allowedBashCommands` and the generic check, and may allow or reject for any
  reason, with a reason. The core still applies first: the parser, the folder tracking, unquoted
  globs, and `excludedBashCommands` (always an override). A validator gets only the arguments, so
  one validator can serve several command names. Validators are loaded by dynamic `import()`, so a
  new one needs only a file and a config entry. They must be conservative: where they can't tell
  what a word is, they check it like any other argument.
- **Folder tracking.** `cd` moves the tracked folder only when it runs for certain and goes to an
  existing folder; otherwise the folder becomes unknown and later commands ask. The folder each
  command runs in must be inside the session folder too.
- **Shells.** bash and zsh are supported with the same rules. Any other `shellPath`, or `BASH_ENV`
  being set, makes every bash command ask. `shellCommandPrefix` and `~/.zshenv` are trusted as the
  user's own configuration.
- **Only allow commands that read.** The path check limits where commands look, not what they do;
  commands that write, create files or run other programs must not be allowed.

## What must pass

Run both after every change:

```sh
npm run typecheck   # tsc
npm test            # node --test *.test.ts validators/*.test.ts
```

- `npm test` needs Node 22.18 or later (`engines` in `package.json`; it runs TypeScript directly).
  If `node` or `npm` isn't found, or the version is older, tell the maintainer instead of guessing a
  path to a Node installation.
- `tsc` must report no errors.
- Every change in behavior gets test cases in `pi-gui-confirm.test.ts`, or in
  `validators/<name>.test.ts` for a validator, with a short comment on cases whose outcome isn't
  obvious. Tests use their own config and fixture folders, never `pi-gui-confirm.json`.
- Update `README.md` when the config or the rules users rely on change.

## TODO.md

- When asked what is left to do, read `TODO.md` and answer from it.
- When a side track or idea comes up that isn't being done now, propose adding it to `TODO.md`, with
  enough context to pick it up cold. Add it only after the maintainer agrees.
- When an item is done, or part of one, suggest removing it or the completed part, so `TODO.md` only
  lists what is still open.

## Keeping this file up to date

This file describes decisions, not history. When a decision or change makes part of it wrong or
incomplete (a design decision is reversed, a check is added, the file layout changes, a planned
change from TODO.md lands), propose the matching edit to `AGENTS.md` in the same piece of work, and
point it out to the maintainer.
