/**
 * Tests for the grep validator, on its own. The core's path check is replaced by a simple stand-in:
 * words starting with / or ~ or containing a .. segment are outside; flags pass unless something
 * path-like is attached. The real check is tested in pi-gui-confirm.test.ts.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Word } from "../pi-gui-confirm.ts";
import grep from "./grep.ts";
import type { ValidatorHelpers } from "./types.ts";

const looksOutside = (text: string) => /^[/~]/.test(text) || text.split("/").includes("..");

const helpers: ValidatorHelpers = {
  argumentIsInside: ({ text }) => {
    if (text.startsWith("--") && text.includes("=")) return !looksOutside(text.slice(text.indexOf("=") + 1));
    if (text.startsWith("-")) return !/[/~]|\.\./.test(text);
    return !looksOutside(text);
  },
  isInside: ({ text }) => !looksOutside(text),
};

const words = (args: string[]): Word[] => args.map((text) => ({ text, plainStart: true, unquotedGlob: false }));

/** One test per argument list: true means allowed, false means it asks. */
function cases(list: [args: string[], allowed: boolean][]) {
  for (const [args, allowed] of list) {
    test(`${allowed ? "allows" : "asks  "} grep ${args.join(" ")}`, () => {
      assert.equal(grep(words(args), helpers).allowed, allowed);
    });
  }
}

describe("the search pattern isn't a path", () => {
  cases([
    [["-rn", "/api/", "."], true],
    [["/etc/passwd", "src"], true], // searches for the text "/etc/passwd" in src
    [["-rn", "x", "/etc"], false], // /etc is a file to search
    [["x", "src", "/etc"], false],
    [["x", "src", "-n"], true], // GNU grep accepts options after operands
    [["--", "-weird", "src"], true], // after --, the first operand is the pattern even if it starts with -
    [["--", "x", "/etc"], false],
  ]);
});

describe("-e and --regexp give the pattern explicitly", () => {
  cases([
    [["-e", "/api/", "src"], true],
    [["-e/api/", "src"], true],
    [["-rne/api/", "src"], true],
    [["--regexp=/api/", "src"], true],
    [["--regexp", "/api/", "src"], true],
    [["-e", "/api/", "/etc"], false], // /api/ is -e's pattern, so /etc is a file to search
    [["-e", "x", "/api/"], false],
    [["-eRS", "src"], true], // RS is the pattern given to -e, not the flags -R and -S
  ]);
});

describe("-f and --file read patterns from a file, which is checked", () => {
  cases([
    [["-f", "patterns.txt", "src"], true],
    [["-f", "/etc/passwd", "src"], false],
    [["-f/etc/passwd", "src"], false],
    [["--file=/etc/passwd", "src"], false],
    [["--file", "/etc/passwd", "src"], false],
    [["-f", "patterns.txt", "/api/"], false], // with -f, every operand is a file
  ]);
});

describe("option values are skipped when finding the pattern", () => {
  cases([
    [["-m", "5", "/api/", "src"], true],
    [["-m5", "/api/", "src"], true],
    [["--max-count=5", "/api/", "src"], true],
    [["--max-count", "5", "/api/", "src"], true],
    [["-A", "3", "/api/", "src"], true],
    [["--color", "/api/", "src"], true], // not in the value list: --color's value is optional and only given with =
    [["--color=always", "/api/", "src"], true],
    [["--include", "*.ts", "-r", "/api/", "."], true],
    [["--label", "/x", "y", "src"], false], // option values are checked like other arguments
  ]);
});

describe("options that may or may not take the next word", () => {
  cases([
    // BSD grep's -C and --context only take attached values, so /etc/passwd may be a file there.
    [["-C", "3", "/etc/passwd", "src"], false],
    [["--context", "3", "/etc/passwd", "src"], false],
    [["-C3", "/api/", "src"], true],
    [["--context=3", "/api/", "src"], true],
    // An abbreviated long option may take the next word: --fil is --file.
    [["--fil", "/etc/passwd", "src"], false],
    [["--max", "5", "x", "src"], true], // nothing outside, so allowed even without knowing the pattern
  ]);
});

describe("following symlinks while recursing asks", () => {
  cases([
    [["-R", "x", "."], false],
    [["-rS", "x", "."], false],
    [["--dereference-recursive", "x", "."], false],
    [["--deref", "x", "."], false],
    [["-r", "x", "."], true],
  ]);

  test("says why", () => {
    assert.deepEqual(grep(words(["-R", "x", "."]), helpers), {
      allowed: false,
      reason: "grep: -R follows symlinks while recursing",
    });
    assert.deepEqual(grep(words(["x", "/etc"]), helpers), {
      allowed: false,
      reason: "grep: /etc points outside the session folder",
    });
  });
});
