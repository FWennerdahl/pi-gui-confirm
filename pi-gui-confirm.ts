/**
 * pi-gui-confirm: asks the user before any tool call that pi-gui-confirm.json doesn't allow.
 * Enforces confirmation in Pi itself, so it doesn't rely on the model following instructions.
 *
 * pi-gui-confirm.json (next to this file):
 *   alwaysAllow                 tool names that never ask
 *   allowInsideWorkingDirectory tool names that don't ask when their `path` is inside the session folder
 *     (tool names may use `*` as a wildcard, e.g. "mcp__grafana__get_*")
 *   allowedBashCommands         regular expressions for shell commands that don't ask; {path} and {paths}
 *                               mark words that must be paths inside the session folder
 *   excludedBashCommands        regular expressions for shell commands that ask even if allowed above
 * Each shell command in a pipe or list is checked separately, with quotes and escapes removed and words
 * joined by single spaces. A pattern must match the whole command. See README.md for the path rules.
 * The file is read on every tool call. If it is missing or invalid, every tool call asks.
 */
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface AllowList {
  alwaysAllow: string[];
  allowInsideWorkingDirectory: string[];
  allowedBashCommands: RegExp[];
  excludedBashCommands: RegExp[];
}

const NOTHING_ALLOWED: AllowList = {
  alwaysAllow: [],
  allowInsideWorkingDirectory: [],
  allowedBashCommands: [],
  excludedBashCommands: [],
};

// File-changing tools always ask, even if the config lists them, so the config can't silently drop that rule.
const ALWAYS_ASK = new Set(["edit", "write"]);

function configPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "pi-gui-confirm.json");
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value;
}

function regexList(value: unknown, field: string): RegExp[] {
  return stringList(value, field).map((pattern) => {
    let n = 0;
    const source = pattern.replace(/\{paths?\}/g, (token) =>
      `(?<__path${n++}>${token === "{path}" ? " \\S+" : "(?: \\S+)+"})`);
    try {
      return new RegExp(`^(?:${source})$`, "d"); // "d": capture positions, to find the path words
    } catch {
      throw new Error(`"${field}" has an invalid regular expression: ${pattern}`);
    }
  });
}

function loadAllowList(): AllowList {
  const config = JSON.parse(readFileSync(configPath(), "utf8"));
  return {
    alwaysAllow: stringList(config.alwaysAllow, "alwaysAllow"),
    allowInsideWorkingDirectory: stringList(config.allowInsideWorkingDirectory, "allowInsideWorkingDirectory"),
    allowedBashCommands: regexList(config.allowedBashCommands, "allowedBashCommands"),
    excludedBashCommands: regexList(config.excludedBashCommands, "excludedBashCommands"),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAny(patterns: string[], toolName: string): boolean {
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(toolName),
  );
}

type Separator = "start" | ";" | "&&" | "||" | "|" | "&";

interface Word {
  /** The word with quotes and escapes removed; whitespace inside it is replaced by placeholders. */
  text: string;
  /** Starts with an unquoted, unescaped character, so a leading ~ or = is expanded by the shell. */
  plainStart: boolean;
  /** Has an unquoted, unescaped *, ? or [, so the shell expands it to file names. */
  unquotedGlob: boolean;
}

interface ShellCommand {
  words: Word[];
  /** The words joined by single spaces: what the patterns are matched against. */
  text: string;
  /** Where each word starts in `text`. */
  offsets: number[];
  before: Separator;
  after: Separator | "end";
}

// Whitespace inside quoted or escaped words, so a word like 'a b' stays one word for the patterns.
const HIDDEN: Record<string, string> = { " ": "\uE000", "\t": "\uE001", "\n": "\uE002" };

function unhide(text: string): string {
  return text.replace(/[\uE000-\uE002]/g, (char) => " \t\n"[char.charCodeAt(0) - 0xe000]);
}

/**
 * Splits a shell command line into its commands (on |, &, ;, &&, || and newlines), with quotes and
 * escapes removed, or returns undefined if the line uses anything this check doesn't understand:
 * substitutions, variables, redirections, subshells, groups or syntax errors.
 * Callers must treat undefined as "ask".
 */
function parseBashCommands(commandLine: string): ShellCommand[] | undefined {
  // Ask on characters this parser can't represent exactly: its own whitespace placeholders, and
  // whitespace other than space, tab and newline, which JavaScript's \s matches but the shell treats
  // as part of a word.
  if (/[\uE000-\uE002]|[^\S \t\n]/.test(commandLine)) return undefined;

  const chars = [...commandLine];
  const commands: ShellCommand[] = [];
  let words: Word[] = [];
  let before = "start" as Separator; // "as": TypeScript doesn't see endCommand changing it
  let word = "";
  let inWord = false;
  let plainStart = false;
  let unquotedGlob = false;
  let quote: "'" | '"' | undefined;

  const addChar = (char: string, plain: boolean) => {
    if (!inWord) plainStart = plain;
    inWord = true;
    word += HIDDEN[char] ?? char;
  };
  const endWord = () => {
    if (inWord) words.push({ text: word, plainStart, unquotedGlob });
    word = "";
    inWord = false;
    unquotedGlob = false;
  };
  const endCommand = (after: Separator | "end") => {
    const offsets: number[] = [];
    let offset = 0;
    for (const w of words) {
      offsets.push(offset);
      offset += w.text.length + 1;
    }
    commands.push({ words, text: words.map((w) => w.text).join(" "), offsets, before, after });
    words = [];
    if (after !== "end") before = after;
  };

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else addChar(char, false);
      continue;
    }
    if (quote === '"') {
      if (char === "$" || char === "`") return undefined; // still expanded inside double quotes
      if (char === "\\") {
        const next = chars[++i];
        if (next === undefined) return undefined;
        if (next === "\n") continue; // line continuation
        if (!"$`\"\\".includes(next)) addChar("\\", false); // other backslashes are kept as is
        addChar(next, false);
      } else if (char === '"') {
        quote = undefined;
      } else {
        addChar(char, false);
      }
      continue;
    }
    if (char === "\\") {
      const next = chars[++i];
      if (next === undefined) return undefined;
      if (next !== "\n") addChar(next, false); // the escaped character, taken literally
      continue;
    }
    if ("`$<>(){}".includes(char)) return undefined;
    if (char === "'" || char === '"') {
      if (!inWord) plainStart = false;
      inWord = true;
      quote = char;
    } else if ("|&;\n".includes(char)) {
      let separator: Separator = ";";
      if (char === "&") separator = chars[i + 1] === "&" ? (i++, "&&") : "&";
      if (char === "|") {
        if (chars[i + 1] === "|") separator = (i++, "||");
        else separator = (chars[i + 1] === "&" && i++, "|"); // |& pipes stderr too
      }
      endWord();
      if (words.length === 0) {
        if (char === "\n") continue; // a blank line, or a line break after && || |
        return undefined; // e.g. "; ls" or "a && && b"
      }
      endCommand(separator);
    } else if (char === " " || char === "\t") {
      endWord();
    } else {
      if ("*?[".includes(char)) unquotedGlob = true;
      addChar(char, true);
    }
  }
  if (quote) return undefined;
  endWord();
  if (words.length > 0) endCommand("end");
  else if (before === "&&" || before === "||" || before === "|") return undefined; // unfinished line
  return commands.length > 0 ? commands : undefined;
}

/** Where a word points, resolved from `base`, or undefined if the shell may expand it to somewhere else. */
function wordPath(word: Word, base: string): string | undefined {
  const text = unhide(word.text);
  if (word.plainStart && text.startsWith("=")) return undefined; // zsh: =cmd is the path of cmd
  // A glob starting with a dot can match .. (bash), and .. next to a glob is hard to follow.
  if (word.unquotedGlob && /(^|\/)(\.[^/]*[*?[]|\.\.(\/|$))/.test(text)) return undefined;
  if (word.plainStart && text.startsWith("~")) {
    if (text !== "~" && !text.startsWith("~/")) return undefined; // ~user, ~+, ~-
    return process.env.HOME ? resolve(process.env.HOME + text.slice(1)) : undefined;
  }
  return resolve(base, text);
}

/** The words a pattern captured with {path} or {paths}, or undefined if it doesn't match. */
function pathWords(pattern: RegExp, command: ShellCommand): Word[] | undefined {
  const match = pattern.exec(command.text);
  if (!match) return undefined;
  const ranges = Object.entries(match.indices?.groups ?? {})
    .filter(([name, range]) => name.startsWith("__path") && range !== undefined)
    .map(([, range]) => range!);
  return command.words.filter((_, i) =>
    ranges.some(([start, end]) => command.offsets[i] > start && command.offsets[i] < end));
}

/** Whether a command is allowed, with its paths resolved from `base` (the physical folder it runs in). */
function commandIsAllowed(command: ShellCommand, allowList: AllowList, root: string, base: string): boolean {
  if (allowList.excludedBashCommands.some((pattern) => pattern.test(command.text))) return false;
  const isInsideRoot = (word: Word) => {
    const path = wordPath(word, base);
    return path !== undefined && isInside(root, path);
  };
  // Globs expand to paths wherever they are, so they are checked in every position.
  if (!command.words.slice(1).filter((word) => word.unquotedGlob).every(isInsideRoot)) return false;
  return allowList.allowedBashCommands.some((pattern) => pathWords(pattern, command)?.every(isInsideRoot));
}

/** Where a cd goes (following the path by text, as cd does), or undefined if that can't be known in advance. */
function cdTarget(words: Word[], dir: string, oldDir: string | undefined): string | undefined {
  const args = words.slice(1);
  if (args.length === 0) return process.env.HOME;
  if (args.length > 1) return undefined; // options such as -P, zsh's "cd old new"
  const [arg] = args;
  const text = unhide(arg.text);
  if (text === "-") return oldDir; // $OLDPWD: only known after an earlier cd in the same line
  if (text.startsWith("-") || text.startsWith("+") || arg.unquotedGlob) return undefined;
  const fromHereOnly = /^(\/|\.\.?(\/|$))/.test(text) || (arg.plainStart && text.startsWith("~"));
  if (process.env.CDPATH && !fromHereOnly) return undefined; // the shell searches CDPATH first
  const target = wordPath(arg, dir);
  if (!target) return undefined;
  try {
    if (!statSync(target).isDirectory()) return undefined;
    accessSync(target, constants.X_OK); // cd fails without permission to enter the folder
  } catch {
    return undefined;
  }
  return target;
}

/** Whether bash commands run in a shell this check understands, with no startup file that could change them. */
function shellIsSupported(cwd: string): boolean {
  if (process.env.BASH_ENV) return false; // bash runs this file first, and it can redefine any command
  try {
    const shellPath = SettingsManager.create(cwd).getShellPath();
    return !shellPath || /^(bash|zsh)(\.exe)?$/.test(basename(shellPath));
  } catch {
    return false;
  }
}

/**
 * Whether every command in the line is allowed, following the folder each one runs in. A cd moves the
 * folder when it runs for certain and its target is a folder it can enter; when that can't be known,
 * the folder becomes unknown and every later command asks.
 */
function bashIsAllowed(commands: ShellCommand[], allowList: AllowList, root: string): boolean {
  let dir: string | undefined = realOrResolved(root); // bash starts in the physical folder
  let oldDir: string | undefined; // where `cd -` goes
  let dirIfFailed: string | undefined = dir; // where the shell is if the last cd failed after all
  let listStart: { dir?: string; oldDir?: string; dirIfFailed?: string } = { dir, oldDir, dirIfFailed };
  let status: "ok" | "unknown" = "unknown"; // predicted result of the last pipeline that ran
  let runs: "yes" | "no" | "maybe" = "yes";
  let pipelineDir: string | undefined = dir;
  let pipelineOk = false;

  for (const command of commands) {
    if (command.before !== "|") {
      if (command.before === "&&" || command.before === "||") {
        runs = status === "unknown" ? "maybe" : command.before === "&&" ? "yes" : "no";
      } else {
        runs = "yes";
        listStart = { dir, oldDir, dirIfFailed };
      }
      // A skipped command only runs if the cd before it failed, so it would run where that cd started.
      pipelineDir = runs === "no" ? dirIfFailed : dir;
      pipelineOk = false;
    }

    // The folder itself counts as a path: commands without path arguments still work in it.
    if (pipelineDir === undefined || !isInside(root, pipelineDir)) return false;
    if (!commandIsAllowed(command, allowList, root, realOrResolved(pipelineDir))) return false;

    if (unhide(command.words[0].text) === "cd") {
      if (command.after === "|") {
        // runs in a subshell: no effect
      } else if (command.before === "|") {
        dir = undefined; // zsh (and bash with lastpipe) run the last part of a pipeline in the main shell
      } else if (runs === "no") {
        dirIfFailed = undefined;
      } else {
        const target = cdTarget(command.words, pipelineDir, oldDir);
        if (runs === "yes" && target !== undefined) {
          oldDir = dirIfFailed = pipelineDir;
          dir = target;
          pipelineOk = true;
        } else if (target !== pipelineDir) {
          dir = undefined;
        }
      }
    }

    if (command.after !== "|") {
      if (runs === "yes") status = pipelineOk ? "ok" : "unknown";
      else if (runs === "maybe") status = "unknown";
      if (command.after === "&") ({ dir, oldDir, dirIfFailed } = listStart); // the list ran in a subshell
    }
  }
  return true;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path); // follow symlinks so a link can't escape the working directory
  } catch {
    return resolve(path);
  }
}

function isInside(dir: string, target: string): boolean {
  const rel = relative(realOrResolved(dir), realOrResolved(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function preview(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export default function (pi: ExtensionAPI) {
  let lastConfigError: string | undefined;

  pi.on("tool_call", async (event, ctx) => {
    let allowList = NOTHING_ALLOWED;
    try {
      allowList = loadAllowList();
      lastConfigError = undefined;
    } catch (error) {
      const message = `pi-gui-confirm.json could not be loaded, so every tool call asks: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (message !== lastConfigError && ctx.hasUI) ctx.ui.notify(message, "warning");
      lastConfigError = message;
    }

    const input = event.input as Record<string, unknown>;

    if (!ALWAYS_ASK.has(event.toolName)) {
      if (matchesAny(allowList.alwaysAllow, event.toolName)) return undefined;
      if (matchesAny(allowList.allowInsideWorkingDirectory, event.toolName)) {
        // Pi's grep/find/ls default to the working directory when no path is given.
        const path = typeof input.path === "string" ? input.path : ".";
        const target = resolve(ctx.cwd, expandHome(path));
        if (isInside(ctx.cwd, target)) return undefined;
      }
      if (event.toolName === "bash") {
        const commands = parseBashCommands(String(input.command ?? ""));
        if (commands && shellIsSupported(ctx.cwd) && bashIsAllowed(commands, allowList, ctx.cwd)) {
          return undefined;
        }
      }
    }

    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: confirmation required but no UI is available` };
    }

    let title = `Allow ${event.toolName}?`;
    let details: string;
    if (event.toolName === "bash") {
      details = String(input.command);
      const summary = typeof input.summary === "string" ? input.summary.trim() : "";
      if (summary) title = `Run: ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary}`;
    } else if (event.toolName === "write") {
      details = `${input.path}\n\n${preview(String(input.content ?? ""))}`;
    } else if (event.toolName === "edit") {
      details = `${input.path}\n\n${preview(JSON.stringify(input.edits, null, 2))}`;
    } else {
      details = preview(JSON.stringify(input, null, 2));
    }

    const approved = await ctx.ui.confirm(title, details);
    return approved ? undefined : { block: true, reason: `User declined ${event.toolName}` };
  });
}
