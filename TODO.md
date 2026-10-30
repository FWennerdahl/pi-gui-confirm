# TODO

## Say why a tool call asks

Today the bash check only returns allowed or not (`bashIsAllowed` → `boolean`), so the dialog shows
the command but not what made it ask. Return a cause for every rejection and show it in the dialog,
and in the block reason when there is no UI (print/JSON mode). Causes to cover:

- The parser gave up (`parseBashCommands` → `undefined`): which construct, e.g. `$`, a redirection,
  an unfinished line, unsupported whitespace.
- `BASH_ENV` is set, or `shellPath` isn't bash or zsh (`shellIsSupported`).
- No allowed pattern matches a command, or an excluded pattern matches (its `reason`; missing or
  empty reasons are already replaced by one naming the pattern when the config is read).
- An argument points outside the session folder (which word, and where it resolves to).
- The folder a command runs in is unknown or outside, and which `cd` caused that.
- For non-bash tools: not in `alwaysAllow`, or the path is outside the session folder.

This also lets the tests assert the cause, not just allowed/asks, so a case can't pass for the
wrong reason.

## A validator for find

`find` reads like `ls -R`, but some of its options do much more, so it isn't allowed today. A
validator (`validators/find.ts`, see "Validators" in README.md) could allow it safely:

- Ask on options that run programs (`-exec`, `-execdir`, `-ok`, `-okdir`), delete (`-delete`) or
  write files (`-fprint`, `-fprint0`, `-fprintf`, `-fls`).
- Ask on following symlinks: `-L`, and the older `-follow`.
- Starting points (the words before the first option or expression, e.g. `src` in
  `find src -name '*.ts'`) are paths and must be inside the session folder; so are file arguments
  like `-newer FILE`.
- Values that are patterns, not paths, don't need the path check: `-name`, `-iname`, `-path`,
  `-ipath`, `-regex`, `-iregex` (e.g. `-path '/tmp/*'` matches text, it doesn't read `/tmp`).

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

## Get a second review of the bash check

The shell parser and the bash check (`parseBashCommands`, `bashIsAllowed` and the helpers in
`pi-gui-confirm.ts`) are security logic with many edge cases, and the code and its tests were written
in the same session. Have them reviewed by a fresh session or another model, given only `README.md`
and `AGENTS.md` as context, looking for:

- commands that are allowed but read outside the session folder, or run something unexpected
  (quoting, escapes, globs, separators, `cd` tracking, zsh differences);
- test cases that pass for the wrong reason (easier once the check reports a cause, see above);
- places where the code is hard to follow.

## Suggestions for pi

Changes for pi itself (`@earendil-works/pi-coding-agent`), to propose or open a PR for, not for this
repo. Before proposing, find the pi repository and look at how the relevant part works today.

### Export the path resolution used by the built-in tools

pi's tools resolve their `path` argument with `resolveToCwd` (`dist/core/tools/path-utils.js`), which
uses `normalizePath` (`dist/utils/paths.js`): it strips a leading `@`, turns `file://` URLs into
paths, expands `~` and normalizes Unicode spaces. Neither function is exported (not in
`dist/index.d.ts`, and the package's `exports` field only allows the main entry), so an extension that
checks paths before a tool runs, like pi-gui-confirm, has to copy these rules and keep them in sync.

Proposal: export `resolveToCwd` (or `resolvePath`/`normalizePath`) from the package's main entry, so
extensions can resolve a tool's path exactly as the tool will.

## Suggestions for pi-gui

Changes for the pi-gui project itself, to propose or open a PR for, not for this repo. Before
proposing, find the pi-gui repository and look at how the relevant part works today.

### Setting to show extension notifications

Extensions report problems with `ctx.ui.notify(message, "info" | "warning" | "error")`. pi defines
it as fire-and-forget for front ends: "the client can display the information or ignore it"
(`docs/rpc-extension-ui.md` in `@earendil-works/pi-coding-agent`). In pi-gui these messages don't
seem to appear, so pi-gui-confirm's config errors (`pi-gui-confirm.json could not be loaded, so
every tool call asks: …`) go unseen.

Proposal: a setting that decides whether extension notifications are shown, e.g. as a toast or in
the thread, possibly per level (show warnings and errors, hide info).

First confirm that pi-gui really drops them: break `pi-gui-confirm.json` on purpose (e.g. add `"("`
to `allowedBashCommands`), run a command, and see whether a warning appears. Restore the file after.

### Richer formatting in confirmation dialogs

The dialog from `ctx.ui.confirm(title, message)` shows the message as plain text. Allow richer
formatting: preformatted text (keeps line breaks and alignment, e.g. for commands and diffs), or
Markdown or HTML, depending on how the dialog is built today. pi-gui-confirm could then show, e.g.,
the command in a code block and the reason it asks as a separate line.

### Wider confirmation dialogs, with scrolling

The dialog is narrow, and long text (commands, diffs, JSON) overflows it. Let it grow to the width
of the thread's chat area, and add vertical and horizontal scrolling inside it when the text is
larger than that.

### Adjustable chat width

Add a way to make the chat area wider: by dragging its edge, or by setting a width explicitly.
