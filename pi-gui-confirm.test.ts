/**
 * Tests for the shell command check in pi-gui-confirm.ts. Run with `npm test` (Node 24 or later runs
 * TypeScript directly). Uses fixture folders in a temporary folder:
 *   repo/                   the session folder
 *   repo/stubs/package.scala
 *   repo/link -> outside/   a symlink out of the session folder
 *   outside/
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type AllowList,
  bashIsAllowed,
  parseAllowList,
  parseBashCommands,
  shellIsSupported,
} from "./pi-gui-confirm.ts";

let fixture: string;
let repo: string;

before(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-gui-confirm-")));
  repo = join(fixture, "repo");
  mkdirSync(join(repo, "stubs"), { recursive: true });
  mkdirSync(join(fixture, "outside"));
  writeFileSync(join(repo, "stubs", "package.scala"), "class Spy\n");
  symlinkSync(join(fixture, "outside"), join(repo, "link"));
});

after(() => rmSync(fixture, { recursive: true, force: true }));

const defaultAllowList = await parseAllowList({
  allowedBashCommands: ["cd( .*)?", "ls( .*)?", "head( .*)?", "grep( .*)?", "echo( .*)?"],
});

function isAllowed(command: string, allowList: AllowList = defaultAllowList): boolean {
  const commands = parseBashCommands(command);
  return commands !== undefined && bashIsAllowed(commands, allowList, repo);
}

/** One test per command: true means allowed, false means it asks. */
function cases(list: [command: string, allowed: boolean][], allowList?: AllowList) {
  for (const [command, allowed] of list) {
    test(`${allowed ? "allows" : "asks  "} ${JSON.stringify(command)}`, () => {
      assert.equal(isAllowed(command, allowList), allowed);
    });
  }
}

/** Runs `fn` with an environment variable set, then restores it. */
function withEnv(name: string, value: string, fn: () => void) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

describe("parser", () => {
  const words = (command: string) => parseBashCommands(command)?.map((c) => c.words.map((w) => w.text));

  test("splits at separators and records them", () => {
    const commands = parseBashCommands("a && b || c | d & e; f\ng");
    assert.deepEqual(commands?.map((c) => [c.text, c.before, c.after]), [
      ["a", "start", "&&"],
      ["b", "&&", "||"],
      ["c", "||", "|"],
      ["d", "|", "&"],
      ["e", "&", ";"],
      ["f", ";", ";"],
      ["g", ";", "end"],
    ]);
  });

  test("treats |& as a pipe", () => {
    assert.deepEqual(parseBashCommands("a |& b")?.map((c) => c.before), ["start", "|"]);
  });

  test("allows blank lines, line breaks after operators and a trailing ; or &", () => {
    assert.deepEqual(words("\n\nls &&\n  echo x\n\nls;"), [["ls"], ["echo", "x"], ["ls"]]);
    assert.deepEqual(words("ls &"), [["ls"]]);
  });

  test("removes quotes and escapes", () => {
    assert.deepEqual(words(`grep "a\\|b" 'c\\d' "e\\$f" \\; g\\h`), [["grep", "a\\|b", "c\\d", "e$f", ";", "gh"]]);
  });

  test("joins lines continued with a backslash", () => {
    assert.deepEqual(words("ls \\\nstubs"), [["ls", "stubs"]]);
    assert.deepEqual(words('echo "a\\\nb"'), [["echo", "ab"]]);
  });

  test("keeps empty quoted words", () => {
    assert.deepEqual(words("echo '' \"\""), [["echo", "", ""]]);
  });

  test("hides whitespace inside quoted and escaped words", () => {
    assert.deepEqual(words("grep 'a b' \"c\td\" e\\ f"), [["grep", "a\uE000b", "c\uE001d", "e\uE000f"]]);
  });

  test("flags unquoted globs and plain starts", () => {
    const [ls] = parseBashCommands("ls *.ts '*.md' \\*.js ~ '~' a'~'") ?? [];
    assert.deepEqual(
      ls.words.slice(1).map((w) => [w.text, w.unquotedGlob, w.plainStart]),
      [
        ["*.ts", true, true],
        ["*.md", false, false],
        ["*.js", false, false],
        ["~", false, true],
        ["~", false, false],
        ["a~", false, true],
      ],
    );
  });

  for (const command of [
    "",
    "ls $HOME",
    'ls "$HOME"',
    "ls `pwd`",
    'ls "`pwd`"',
    "ls > out",
    "ls < in",
    "(ls)",
    "{ ls; }",
    "ls 'open",
    'ls "open',
    "ls \\",
    "; ls",
    "ls && && ls",
    "ls &&",
    "ls |",
    "ls a\u00a0b",
    "ls a\rb",
    "ls \uE000",
  ]) {
    test(`gives up on ${JSON.stringify(command)}`, () => assert.equal(parseBashCommands(command), undefined));
  }
});

describe("paths", () => {
  cases([
    ["ls", true],
    ["ls stubs", true],
    ["ls -la stubs", true],
    ["ls stubs -la", true],
    ["ls 'a b'", true],
    ["ls /etc", false],
    ["ls '/etc'", false], // quotes don't matter
    ["ls /etc .", false],
    ["ls /etc stubs", false],
    ["ls -la /etc stubs", false],
    ["ls ..", false],
    ["ls stubs/../..", false],
    ["ls link", false],
    ["ls link/missing", true], // judged by its text: it doesn't exist, so nothing can be read through it
    ["ls \\; rm x", true], // the escaped ; is an argument to ls, not a separator
    ["grep -n 'Spy|class ' stubs/package.scala", true],
    ["grep -rn \"/api/\" .", false], // a search pattern that looks like a path outside: asks
    ["grep -f /etc/passwd x", false],
    ["grep -f stubs/package.scala x", true],
    ["head -40 stubs/package.scala", true],
    ["echo /etc", false], // echo only prints it, but asks like any other path outside
  ]);
});

describe("flags", () => {
  cases([
    ["ls --color=auto stubs", true],
    ["grep --file=/etc/passwd x", false],
    ["grep --file=stubs/package.scala x", true],
    ["grep --file=~/x y", false],
    ["grep --exclude-dir=.. x .", false],
    ["grep -f/etc/passwd x", false], // a value attached to a short flag
    ["grep -f../x y", false],
    ["grep -flink x", false], // link is a symlink pointing outside
    ["grep -rnflink x", false],
    ["grep -fpatterns.txt x", true], // an attached value without / inside the folder
    // Every rest is checked, and /package.scala is one of them: an attached value with / always asks.
    ["grep -fstubs/package.scala x", false],
    ["grep '-f~' y", true], // the shell doesn't expand ~ mid-word: a folder named ~ inside
    ["grep -A3 x stubs", true],
    ["ls -- stubs", true],
  ]);
});

describe("name=value words", () => {
  cases([
    ["echo if=/etc/passwd", false], // dd if=/etc/passwd reads it
    ["echo a=~", false], // bash expands ~ after = in such words: a=/Users/…
    ["echo a=b=../x", false],
    ["echo a=stubs", true],
    ["echo key=value", true],
  ]);
});

describe("tilde and zsh's =", () => {
  cases([
    ["ls ~", false],
    ["ls ~/", false],
    ["ls ~root", false],
    ["ls ~+", false],
    ["ls ~-", false],
    ["ls '~'", true], // quoted: a folder named ~ inside the session folder
    ["ls =ls", false],
    ["ls '=ls'", true],
  ]);
});

describe("globs", () => {
  cases([
    ["ls stubs/*", true],
    ["ls *", true],
    ["ls .*", false], // can match .. in bash
    ["ls stubs/.?", false],
    ["ls */..", false],
    ["ls '.*'", true], // quoted: not expanded
    ["echo *", true],
    ["echo /etc/*", false], // globs are checked in every position
    ["grep x /et*", false],
  ]);
});

describe("cd tracking", () => {
  cases([
    ["cd", true],
    ["cd; ls", false], // home folder
    ["cd /", false],
    ["cd ..", false],
    ["cd stubs", true],
    ["cd link", false],
    ["cd stubs && ls ..", true],
    ["cd stubs\nls ..", true],
    ["cd stubs; cd ..; ls", true],
    ["cd stubs && cd ../..", false],
    ["cd stubs && ls ../..", false],
    ["cd missing; ls", false],
    ["cd stubs/package.scala; ls", false], // not a folder
    ["cd stubs; cd -; ls", true],
    ["cd stubs; cd -; ls ..", false],
    ["cd -; ls", false], // $OLDPWD isn't known without an earlier cd
    ["cd -P stubs; ls", false],
    ["cd +1; ls", false],
  ]);

  test("follows an absolute cd into the session folder", () => {
    assert.equal(isAllowed(`cd ${join(repo, "stubs")} && ls ..`), true);
    assert.equal(isAllowed(`cd ${join(repo, "stubs")} && ls ../..`), false);
  });

  test("allows the original example", () => {
    const command =
      `cd ${join(repo, "stubs")} && grep -n "Spy\\|class \\|object \\|def " package.scala | head -40; ` +
      `grep -rln "Spy\\[" . | head -5`;
    assert.equal(isAllowed(command), true);
  });
});

describe("cd with separators", () => {
  cases([
    ["cd stubs | ls ..", false], // the cd runs in a subshell
    ["cd stubs & ls ..", false], // same
    ["cd stubs && ls .. &", true], // the list runs in a subshell, but ls runs after the cd in it
    ["cd stubs && ls & ls ..", false], // back in the session folder after &
    ["echo x | cd stubs; ls", false], // zsh runs the last part of a pipeline in the main shell
    ["grep -q x stubs/package.scala && cd stubs; ls ..", false], // the cd may not run
    ["grep -q x stubs/package.scala || cd stubs; ls ..", false],
    ["cd stubs || echo failed; ls ..", true], // echo only runs if cd failed; ls runs in stubs
    ["cd stubs || ls ..", false], // ls only runs if cd failed, so in the session folder
    ["cd stubs && cd ..; ls", true],
    ["cd stubs || cd stubs; ls ..", true], // the second cd is skipped; ls runs in stubs
    ["cd stubs || cd ..; ls", false], // the skipped cd is checked from where it would run: outside
  ]);
});

describe("CDPATH", () => {
  test("makes a relative cd unknown", () => {
    withEnv("CDPATH", "/tmp", () => {
      assert.equal(isAllowed("cd stubs; ls"), false);
      assert.equal(isAllowed("cd ./stubs; ls"), true);
      assert.equal(isAllowed(`cd ${join(repo, "stubs")}; ls`), true);
    });
  });
});

describe("pattern rules", () => {
  test("excluded patterns win over allowed ones", async () => {
    const allowList = await parseAllowList({
      allowedBashCommands: ["ls( .*)?"],
      excludedBashCommands: ["ls .*-[a-zA-Z]*L.*"],
    });
    assert.equal(isAllowed("ls -R stubs", allowList), true);
    assert.equal(isAllowed("ls -RL stubs", allowList), false);
  });

  test("paths are checked whatever the pattern says", async () => {
    const allowList = await parseAllowList({ allowedBashCommands: ["cat /etc/hosts"] });
    assert.equal(isAllowed("cat /etc/hosts", allowList), false);
  });

  test("patterns must match the whole command", async () => {
    const allowList = await parseAllowList({ allowedBashCommands: ["ls"] });
    assert.equal(isAllowed("ls", allowList), true);
    assert.equal(isAllowed("ls stubs", allowList), false);
  });

  test("invalid patterns make the config invalid", async () => {
    await assert.rejects(parseAllowList({ allowedBashCommands: ["ls("] }), /invalid regular expression/);
  });
});

describe("validators", () => {
  test("a validator decides about its command instead of the allowed patterns", async () => {
    const allowList = await parseAllowList({ bashValidators: { grep: "grep" } });
    assert.equal(isAllowed('grep -rn "/api/" .', allowList), true); // asks with the generic check
    assert.equal(isAllowed("grep -rn x /etc", allowList), false);
    assert.equal(isAllowed("grep -R x .", allowList), false);
    assert.equal(isAllowed("grep -rnflink x .", allowList), false); // -f's attached value is a symlink outside
    assert.equal(isAllowed("ls", allowList), false); // other commands still need a pattern
  });

  test("the same validator can serve several command names", async () => {
    const allowList = await parseAllowList({ bashValidators: { grep: "grep", ggrep: "grep" } });
    assert.equal(isAllowed('ggrep -rn "/api/" .', allowList), true);
  });

  test("excluded patterns win over validators", async () => {
    const allowList = await parseAllowList({
      bashValidators: { grep: "grep" },
      excludedBashCommands: ["grep .*-[a-zA-Z]*i.*"],
    });
    assert.equal(isAllowed("grep -rn x .", allowList), true);
    assert.equal(isAllowed("grep -rni x .", allowList), false);
  });

  test("unquoted globs are checked before the validator runs", async () => {
    const allowList = await parseAllowList({ bashValidators: { grep: "grep" } });
    // The shell expands /etc/p* to file names, so the search pattern isn't text any more.
    assert.equal(isAllowed("grep /etc/p* .", allowList), false);
    assert.equal(isAllowed("grep '/etc/p*' .", allowList), true);
  });

  test("the folder the command runs in is still checked", async () => {
    const allowList = await parseAllowList({ bashValidators: { grep: "grep" }, allowedBashCommands: ["cd( .*)?"] });
    assert.equal(isAllowed("cd stubs; grep -rn x ..", allowList), true);
    assert.equal(isAllowed("cd; grep -rn x .", allowList), false); // in the home folder
  });

  test("a missing or invalid validator makes the config invalid", async () => {
    await assert.rejects(parseAllowList({ bashValidators: { grep: "nope" } }), /there is no validator/);
    await assert.rejects(parseAllowList({ bashValidators: { grep: "../grep" } }), /invalid validator name/);
    await assert.rejects(parseAllowList({ bashValidators: { grep: 1 } }), /invalid validator name/);
    await assert.rejects(parseAllowList({ bashValidators: ["grep"] }), /must map command names/);
    await assert.rejects(parseAllowList({ bashValidators: { grep: "types" } }), /doesn't export a validator/);
  });
});

describe("shell", () => {
  test("BASH_ENV makes every command ask", () => {
    withEnv("BASH_ENV", "/tmp/bash-env", () => assert.equal(shellIsSupported(repo), false));
  });
});
