/**
 * Tests for the any-arguments validator, on its own. What the core still checks around it (globs, the
 * folder, exclusions) is tested in pi-gui-confirm.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../pi-gui-confirm.ts";
import anyArguments from "./any-arguments.ts";
import type { ValidatorHelpers } from "./types.ts";

// Helpers that reject everything: the validator must not depend on them.
const helpers: ValidatorHelpers = { argumentIsInside: () => false, isInside: () => false };

const words = (args: string[]): Word[] => args.map((text) => ({ text, plainStart: true, unquotedGlob: false }));

test("allows any arguments, without checking them as paths", () => {
  assert.deepEqual(anyArguments(words(["/etc", "../x", "if=/etc/passwd"]), helpers), { allowed: true });
  assert.deepEqual(anyArguments([], helpers), { allowed: true });
});
