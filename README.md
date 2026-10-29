# pi-gui-confirm

A [Pi](https://pi.dev) extension that asks for confirmation before tool calls, with allowlists for
read-only tools and shell commands. Built for pi-gui; also works in terminal Pi.

## Install

Add the extension to `~/.pi/agent/settings.json`, then start a new thread:

```json
"extensions": [
  "~/dev/pi-gui-confirm/pi-gui-confirm.ts",
  "~/dev/pi-gui-confirm/bash-summary.ts"
]
```

`bash-summary.ts` is optional (see below).

## Configuration

`pi-gui-confirm.json`, next to the extension. It is read on every tool call, so changes apply
immediately.

| Field | Meaning |
|---|---|
| `alwaysAllow` | Tool names that never ask. `*` is a wildcard, e.g. `"mcp__grafana__get_*"`. |
| `allowInsideWorkingDirectory` | Tool names that don't ask when their `path` is inside the session folder (no path means the session folder). |
| `allowedBashCommands` | Regular expressions for shell commands that don't ask. A pattern must match the whole command. |
| `excludedBashCommands` | Regular expressions for shell commands that ask even if allowed above. |

Shell command lines are split at `|`, `&`, `;`, `&&`, `||` and newlines, and every command must be
allowed. Patterns are matched against each command with quotes and escapes removed and words joined
by single spaces. Lines with `$`, backticks, `>`, `<`, `(`, `)`, `{` or `}` always ask.

### Paths in shell commands

An allowed command also needs every argument that could be a path to stay inside the session folder.
Which arguments a program reads as paths isn't known, so every argument is checked as if it were one:

```json
"allowedBashCommands": ["cd( .*)?", "ls( .*)?"]
```

- `ls -la stubs` is allowed; `ls /etc`, `ls ..` and `ls link` (a symlink pointing outside) ask.
- Flags pass. For `--name=value` the value is checked; a flag with something path-like attached
  (`-f/etc/passwd`) asks.
- Quotes don't matter: `ls "/etc"` asks too. Arguments that aren't paths but look like paths outside
  the folder ask as well, e.g. the search pattern in `grep -r "/api/" .`.
- Unquoted globs (`*.scala`) are checked like paths; `.*` and globs next to `..` ask.
- `~` and `~/…` are expanded; `~user`, `~+`, `~-` and zsh's `=cmd` ask.
- The folder each command runs in must be inside the session folder too. `cd` moves it when it runs
  for certain and goes to an existing folder; otherwise every later command asks
  (e.g. `grep -q x f && cd stubs; ls ..`).

This only limits where commands look, not what they do: leave out commands that write or run other
programs, and flags that follow symlinks while recursing (`grep -R`, `ls -L`), e.g. with
`excludedBashCommands`. Paths that don't exist are judged by their text, so don't allow commands that
create files (`touch`, `mkdir`): `touch link/new` would create a file outside through a symlink.

Every shell command asks when `BASH_ENV` is set, or when `shellPath` is a shell other than bash or zsh.
Trusted as your own configuration: `shellCommandPrefix` in Pi's settings and zsh's `~/.zshenv`. They
run before every command and can change what a command name means (aliases, functions, `CDPATH`).

Always:
- `edit` and `write` ask, whatever the config says.
- If the config is missing or invalid, every tool call asks and a warning is shown.
- Without a UI (print or JSON mode), calls that would ask are blocked.

## bash-summary (optional)

Replaces the `bash` tool with one that requires a short `summary` of what the command does.
The confirmation dialog shows it as the title, above the exact command. The summary is written
by the model: always check the command itself.

## License

MIT, see [LICENSE](LICENSE).
