/**
 * pi-gui-confirm: asks the user before any tool call that pi-gui-confirm.json doesn't allow.
 * Enforces confirmation in Pi itself, so it doesn't rely on the model following instructions.
 *
 * pi-gui-confirm.json (next to this file):
 *   alwaysAllow                 tool names that never ask
 *   allowInsideWorkingDirectory tool names that don't ask when their `path` is inside the session folder
 *     (tool names may use `*` as a wildcard, e.g. "mcp__grafana__get_*")
 *   allowedBashCommands         regular expressions for shell commands that don't ask, as long as
 *                               every argument that could be a path stays inside the session folder
 *   excludedBashCommands        regular expressions for shell commands that ask even if allowed above
 *   bashValidators              command name → validator in validators/<name>.ts, which decides about that
 *                               command instead of allowedBashCommands (excludedBashCommands still apply)
 * Each shell command in a pipe or list is checked separately, with quotes and escapes removed and words
 * joined by single spaces. A pattern must match the whole command. See README.md for the path rules.
 * The file is read on every tool call. If it is missing or invalid, every tool call asks.
 */
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BashValidator, ValidatorHelpers } from "./validators/types.ts";

export interface AllowList {
  alwaysAllow: string[];
  allowInsideWorkingDirectory: string[];
  allowedBashCommands: RegExp[];
  excludedBashCommands: RegExp[];
  /** Command name → its validator. */
  bashValidators: Map<string, BashValidator>;
}

const NOTHING_ALLOWED: AllowList = {
  alwaysAllow: [],
  allowInsideWorkingDirectory: [],
  allowedBashCommands: [],
  excludedBashCommands: [],
  bashValidators: new Map(),
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
    try {
      return new RegExp(`^(?:${pattern})$`);
    } catch {
      throw new Error(`"${field}" has an invalid regular expression: ${pattern}`);
    }
  });
}

/**
 * Loads the validators named in `bashValidators` ({ "grep": "grep" }: the command grep uses
 * validators/grep.ts). Throws if a name is invalid or its file doesn't exist.
 */
async function loadValidators(value: unknown): Promise<Map<string, BashValidator>> {
  if (value === undefined) return new Map();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"bashValidators" must map command names to validator names`);
  }
  const validators = new Map<string, BashValidator>();
  for (const [command, name] of Object.entries(value)) {
    // Only plain names, so a name can't point outside the validators folder ("../x").
    if (typeof name !== "string" || !/^[\w-]+$/.test(name)) {
      throw new Error(`"bashValidators" has an invalid validator name for ${command}: ${JSON.stringify(name)}`);
    }
    const file = join(dirname(fileURLToPath(import.meta.url)), "validators", `${name}.ts`);
    if (!existsSync(file)) throw new Error(`"bashValidators": there is no validator ${file}`);
    const module = await import(pathToFileURL(file).href);
    if (typeof module.default !== "function") {
      throw new Error(`"bashValidators": ${file} doesn't export a validator function as default`);
    }
    validators.set(command, module.default);
  }
  return validators;
}

/** Checks a parsed config, compiles its patterns and loads its validators. Throws if it is invalid. */
export async function parseAllowList(config: any): Promise<AllowList> {
  return {
    alwaysAllow: stringList(config.alwaysAllow, "alwaysAllow"),
    allowInsideWorkingDirectory: stringList(config.allowInsideWorkingDirectory, "allowInsideWorkingDirectory"),
    allowedBashCommands: regexList(config.allowedBashCommands, "allowedBashCommands"),
    excludedBashCommands: regexList(config.excludedBashCommands, "excludedBashCommands"),
    bashValidators: await loadValidators(config.bashValidators),
  };
}

function loadAllowList(): Promise<AllowList> {
  return parseAllowList(JSON.parse(readFileSync(configPath(), "utf8")));
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

export interface Word {
  /** The word with quotes and escapes removed; whitespace inside it is replaced by placeholders. */
  text: string;
  /** Starts with an unquoted, unescaped character, so a leading ~ or = is expanded by the shell. */
  plainStart: boolean;
  /** Has an unquoted, unescaped *, ? or [, so the shell expands it to file names. */
  unquotedGlob: boolean;
}

export interface ShellCommand {
  words: Word[];
  /** The words joined by single spaces: what the patterns are matched against. */
  text: string;
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
export function parseBashCommands(commandLine: string): ShellCommand[] | undefined {
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
    commands.push({ words, text: words.map((w) => w.text).join(" "), before, after });
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

/**
 * Whether a command is allowed, with its arguments resolved from `base` (the physical folder it runs in).
 * Excluded patterns always win. A command with a validator is decided by it; any other command needs
 * an allowed pattern, and every argument must pass the generic check.
 */
function commandIsAllowed(command: ShellCommand, allowList: AllowList, root: string, base: string): boolean {
  if (allowList.excludedBashCommands.some((pattern) => pattern.test(command.text))) return false;
  const helpers: ValidatorHelpers = {
    argumentIsInside: (word) => argumentIsInside(word, root, base),
    isInside: (word) => wordIsInside(word, root, base),
  };
  const [name, ...args] = command.words;
  // The shell expands unquoted globs to file names before the program runs, whatever it does with
  // its arguments: grep /etc/p* . turns the "search pattern" into /etc/passwd and more.
  if (!args.filter((word) => word.unquotedGlob).every(helpers.isInside)) return false;

  const validator = allowList.bashValidators.get(unhide(name.text));
  if (validator) {
    // Validators see the words as the program gets them, with real spaces instead of placeholders.
    const visible = args.map((word) => ({ ...word, text: unhide(word.text) }));
    try {
      return validator(visible, helpers).allowed;
    } catch {
      return false; // a broken validator must not allow anything
    }
  }
  if (!allowList.allowedBashCommands.some((pattern) => pattern.test(command.text))) return false;
  return args.every(helpers.argumentIsInside);
}

/**
 * Whether an argument stays inside the session folder if it is a path. Which arguments a program reads
 * as paths isn't known, so every argument is checked as if it were one. Words that aren't paths
 * (flags, search patterns) almost always pass, since they resolve inside the folder too.
 */
function argumentIsInside(word: Word, root: string, base: string): boolean {
  const text = unhide(word.text);
  if (text.startsWith("-")) {
    const equals = text.indexOf("=");
    if (text.startsWith("--") && equals !== -1) {
      // --name=value: the value may be a path. Treated as a word of its own, so a leading ~ counts.
      return argumentIsInside({ ...word, text: word.text.slice(equals + 1), plainStart: true }, root, base);
    }
    // A flag, possibly with a value attached (-f/etc/passwd, or -flink with a symlink named link).
    // Which part is the value can't be known, so every possible value (every rest of the word) is
    // checked as a path. The shell doesn't expand ~ or = in the middle of a word, hence plainStart.
    for (let i = 1; i < text.length; i++) {
      if (!wordIsInside({ ...word, text: word.text.slice(i), plainStart: false }, root, base)) return false;
    }
    return true;
  }
  // name=value (dd if=/etc/passwd): the value may be a path too, and bash expands ~ right after the =
  // in such words (a=~ becomes a=/Users/…), so it is checked like a word of its own.
  const equals = text.indexOf("=");
  if (equals > 0 && !argumentIsInside({ ...word, text: word.text.slice(equals + 1), plainStart: true }, root, base)) {
    return false;
  }
  return wordIsInside(word, root, base);
}

/** Whether the word, read as a path from `base`, is inside the session folder `root`. */
function wordIsInside(word: Word, root: string, base: string): boolean {
  const path = wordPath(word, base);
  return path !== undefined && isInside(root, path);
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
export function shellIsSupported(cwd: string): boolean {
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
export function bashIsAllowed(commands: ShellCommand[], allowList: AllowList, root: string): boolean {
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
      allowList = await loadAllowList();
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
