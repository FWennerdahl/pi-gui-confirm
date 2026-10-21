/**
 * pi-gui-confirm: asks the user before any tool call that pi-gui-confirm.json doesn't allow.
 * Enforces confirmation in Pi itself, so it doesn't rely on the model following instructions.
 *
 * pi-gui-confirm.json (next to this file):
 *   alwaysAllow                 tool names that never ask
 *   allowInsideWorkingDirectory tool names that don't ask when their `path` is inside the session folder
 *     (tool names may use `*` as a wildcard, e.g. "mcp__grafana__get_*")
 *   allowedBashCommands         regular expressions for shell commands that don't ask
 *   excludedBashCommands        regular expressions for shell commands that ask even if allowed above
 * Each shell command in a pipe or list is checked separately, with quotes removed and words joined by
 * single spaces. A pattern must match the whole command.
 * The file is read on every tool call. If it is missing or invalid, every tool call asks.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    try {
      return new RegExp(`^(?:${pattern})$`);
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

/**
 * Splits a shell command line into its commands (on |, &, ; and newlines) and returns each one with
 * quotes removed and words joined by single spaces, or undefined if the line uses anything this check
 * doesn't understand: substitutions, variables, escapes, redirections, subshells or groups.
 * Callers must treat undefined as "ask".
 */
function splitBashCommands(commandLine: string): string[] | undefined {
  const commands: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (inWord) commands[commands.length - 1].push(word);
    word = "";
    inWord = false;
  };

  for (const char of commandLine) {
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if ("`$\\".includes(char)) return undefined; // still expanded inside double quotes
      if (char === '"') quote = undefined;
      else word += char;
      continue;
    }
    if ("`$\\<>(){}".includes(char)) return undefined;
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if ("|&;\n".includes(char)) {
      endWord();
      commands.push([]);
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote) return undefined;
  endWord();

  const normalized = commands.filter((command) => command.length > 0).map((command) => command.join(" "));
  return normalized.length > 0 ? normalized : undefined;
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
        const commands = splitBashCommands(String(input.command ?? ""));
        const isAllowed = (command: string) =>
          allowList.allowedBashCommands.some((pattern) => pattern.test(command)) &&
          !allowList.excludedBashCommands.some((pattern) => pattern.test(command));
        if (commands?.every(isAllowed)) return undefined;
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
