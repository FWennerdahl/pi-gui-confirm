/**
 * grep: the search pattern is text, not a path, so it isn't checked (grep -rn "/api/" . doesn't ask).
 * Every other argument goes through the generic check, including files to search and -f's file.
 *
 * Finding the search pattern: with -e or -f it is given explicitly; otherwise it is the first operand
 * (word that isn't an option or an option's value). To skip option values, the options that take their
 * value as the next word must be known. One missing from the list would make its value look like the
 * search pattern; where that could happen, the first operand is checked like any other argument.
 */
import type { Word } from "../pi-gui-confirm.ts";
import type { BashValidator, Verdict } from "./types.ts";

// Options that take their value as the next word unless it is attached (-A3, --max-count=3), in GNU
// and BSD grep. Long options may be abbreviated (--max for --max-count).
const SHORT_WITH_VALUE = new Set(["A", "B", "C", "d", "D", "e", "f", "m"]);
const LONG_WITH_VALUE = new Set([
  "after-context",
  "before-context",
  "binary-files",
  "context",
  "devices",
  "directories",
  "exclude",
  "exclude-dir",
  "exclude-from",
  "file",
  "group-separator",
  "include",
  "include-dir",
  "label",
  "max-count",
  "regexp",
]);

// Follow symlinks while recursing, also to outside the session folder: GNU -R, BSD -S.
const SYMLINK_SHORT = new Set(["R", "S"]);
const SYMLINK_LONG = "dereference-recursive";

const ask = (reason: string): Verdict => ({ allowed: false, reason: `grep: ${reason}` });

const grep: BashValidator = (args, { argumentIsInside }) => {
  const notPaths = new Set<Word>(); // words that are search patterns
  const operands: Word[] = [];
  let patternGiven = false; // -e or -f: no search pattern among the operands
  let firstOperandUncertain = false; // an option that may or may not have taken the next word

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const text = word.text;

    if (text === "--") {
      operands.push(...args.slice(i + 1)); // everything after -- is an operand
      break;
    }

    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const name = text.slice(2, equals === -1 ? undefined : equals);
      if (name !== "" && SYMLINK_LONG.startsWith(name)) return ask(`${text} follows symlinks while recursing`);
      if (name === "regexp" || name === "file") patternGiven = true;
      if (equals !== -1) {
        if (name === "regexp") notPaths.add(word);
      } else if (LONG_WITH_VALUE.has(name)) {
        const value = args[++i];
        if (value && name === "regexp") notPaths.add(value);
        // BSD grep's --context only takes a value with =, so the next word may be the search pattern.
        if (name === "context") firstOperandUncertain = true;
      } else if ([...LONG_WITH_VALUE].some((option) => option.startsWith(name))) {
        firstOperandUncertain = true; // an abbreviation (--fil for --file) that may take the next word
      }
      continue;
    }

    if (text.startsWith("-") && text !== "-") {
      // One or more short options: -rn, -A3, -e PATTERN, -epattern.
      for (let j = 1; j < text.length; j++) {
        const letter = text[j];
        if (SYMLINK_SHORT.has(letter)) return ask(`-${letter} follows symlinks while recursing`);
        if (!SHORT_WITH_VALUE.has(letter)) continue;
        if (letter === "e" || letter === "f") patternGiven = true;
        if (j + 1 < text.length) {
          if (letter === "e") notPaths.add(word); // the rest of the word is the pattern
        } else {
          const value = args[++i];
          if (value && letter === "e") notPaths.add(value);
          // BSD grep's -C only takes an attached value (-C3), so the next word may be the search pattern.
          if (letter === "C") firstOperandUncertain = true;
        }
        break; // the rest of the word, or the next word, is the value
      }
      continue;
    }

    operands.push(word);
  }

  if (!patternGiven && !firstOperandUncertain && operands.length > 0) notPaths.add(operands[0]);

  const outside = args.find((word) => !notPaths.has(word) && !argumentIsInside(word));
  return outside ? ask(`${outside.text} points outside the session folder`) : { allowed: true };
};

export default grep;
