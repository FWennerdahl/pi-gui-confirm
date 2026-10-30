/**
 * Tests for the shell command check in pi-gui-confirm.ts. Run with `npm test` (Node 22.18 or later runs
 * TypeScript directly). Uses fixture folders in a temporary folder:
 *   repo/                   the session folder
 *   repo/stubs/package.scala
 *   repo/.git/hooks/
 *   repo/link -> outside/   a symlink out of the session folder
 *   repo/docs-link -> stubs/       a symlink to another place inside
 *   repo/hooks -> .git/hooks/      a symlink to a protected place inside
 *   repo/settings.json -> stubs/package.scala   a symlink to the file the tests use as config file
 *   outside/
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type AllowList,
  bashIsAllowed,
  parseAllowList,
  parseBashCommands,
  resolveToolPath,
  shellIsSupported,
  toolPathIsAllowed,
} from "./pi-gui-confirm.ts";

let fixture: string;
let repo: string;

before(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-gui-confirm-")));
  repo = join(fixture, "repo");
  mkdirSync(join(repo, "stubs"), { recursive: true });
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  mkdirSync(join(fixture, "outside"));
  writeFileSync(join(repo, "stubs", "package.scala"), "class Spy\n");
  symlinkSync(join(fixture, "outside"), join(repo, "link"));
  symlinkSync(join(repo, "stubs"), join(repo, "docs-link"));
  symlinkSync(join(repo, ".git", "hooks"), join(repo, "hooks"));
  symlinkSync(join(repo, "stubs", "package.scala"), join(repo, "settings.json"));
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
    "ls &&",
    "ls a\u00a0b",
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
    ["ls 'a b'", true],
    ["ls /etc", false],
    ["ls '/etc'", false], // quotes don't matter
    ["ls /etc stubs", false],
    ["ls ..", false],
    ["ls stubs/../..", false],
    ["ls link", false],
    ["ls docs-link", true], // a symlink to another place inside
    ["ls link/missing", false], // doesn't exist: checked through its nearest existing folder, link
    ["ls \\; rm x", true], // the escaped ; is an argument to ls, not a separator
    ["grep -rn \"/api/\" .", false], // a search pattern that looks like a path outside: asks
  ]);
});

describe("flags", () => {
  cases([
    ["ls --color=auto stubs", true],
    ["grep --file=/etc/passwd x", false],
    ["grep --file=~/x y", false],
    ["grep -f/etc/passwd x", false], // a value attached to a short flag
    ["grep -flink x", false], // link is a symlink pointing outside
    ["grep -fpatterns.txt x", true], // an attached value without / inside the folder
    // Every rest is checked, and /package.scala is one of them: an attached value with / always asks.
    ["grep -fstubs/package.scala x", false],
    ["grep '-f~' y", true], // the shell doesn't expand ~ mid-word: a folder named ~ inside
  ]);
});

describe("name=value words", () => {
  cases([
    ["echo if=/etc/passwd", false], // dd if=/etc/passwd reads it
    ["echo a=~", false], // bash expands ~ after = in such words: a=/Users/…
    ["echo a=b=../x", false],
    ["echo a=stubs", true],
  ]);
});

describe("tilde and zsh's =", () => {
  cases([
    ["ls ~", false],
    ["ls ~root", false],
    ["ls '~'", true], // quoted: a folder named ~ inside the session folder
    ["ls =ls", false],
    ["ls '=ls'", true],
  ]);
});

describe("globs", () => {
  cases([
    ["ls stubs/*", true],
    ["ls .*", false], // can match .. in bash
    ["ls */..", false],
    ["ls '.*'", true], // quoted: not expanded
  ]);
});

describe("cd tracking", () => {
  cases([
    ["cd", true],
    ["cd; ls", false], // home folder
    ["cd /", false],
    ["cd link", false],
    ["cd stubs && ls ..", true],
    ["cd stubs\nls ..", true],
    ["cd stubs; cd ..; ls", true],
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
    ["cd stubs || echo failed; ls ..", true], // echo only runs if cd failed; ls runs in stubs
    ["cd stubs || ls ..", false], // ls only runs if cd failed, so in the session folder
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
      excludedBashCommands: [{ pattern: "ls .*-[a-zA-Z]*L.*" }],
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

  test("exclusions carry a reason, or a generic one naming the pattern", async () => {
    const allowList = await parseAllowList({
      excludedBashCommands: [
        { pattern: "ls( .*)? -\\w*L.*", reason: "follows symlinks" },
        { pattern: "ls x" },
        { pattern: "ls y", reason: "" },
      ],
    });
    assert.deepEqual(
      allowList.excludedBashCommands.map((exclusion) => exclusion.reason),
      ["follows symlinks", "matches the excluded pattern ls x", "matches the excluded pattern ls y"],
    );
  });

  test("invalid exclusions make the config invalid", async () => {
    const invalid = (entry: unknown) => parseAllowList({ excludedBashCommands: [entry] });
    await assert.rejects(invalid("ls"), /must be \{ "pattern"/); // a plain string isn't enough
    await assert.rejects(invalid({ reason: "no pattern" }), /must be \{ "pattern"/);
    await assert.rejects(invalid({ pattern: "ls", reasn: "typo" }), /must be \{ "pattern"/);
    await assert.rejects(invalid({ pattern: "ls", reason: 1 }), /must be \{ "pattern"/);
    await assert.rejects(invalid({ pattern: "ls(" }), /invalid regular expression/);
    await assert.rejects(parseAllowList({ excludedBashCommands: "ls" }), /must be an array/);
  });
});

describe("validators", () => {
  test("a validator decides about its command instead of the allowed patterns", async () => {
    const allowList = await parseAllowList({ bashValidators: { grep: "grep" } });
    assert.equal(isAllowed('grep -rn "/api/" .', allowList), true); // asks with the generic check
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
      excludedBashCommands: [{ pattern: "grep .*-[a-zA-Z]*i.*" }],
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

  test("any-arguments skips the path check, but not what the core checks", async () => {
    const allowList = await parseAllowList({
      bashValidators: { echo: "any-arguments" },
      allowedBashCommands: ["cd( .*)?"],
    });
    assert.equal(isAllowed("echo /etc ../x if=/etc/passwd", allowList), true); // only printed
    assert.equal(isAllowed("echo /etc/*", allowList), false); // the shell expands it to a listing of /etc
    assert.equal(isAllowed("cd stubs; echo x", allowList), true);
    assert.equal(isAllowed("cd; echo x", allowList), false); // runs in the home folder
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

describe("tool paths are resolved like pi does", () => {
  test("relative, ~, a leading @ and file:// URLs", () => {
    assert.equal(resolveToolPath("stubs/x", repo), join(repo, "stubs/x"));
    assert.equal(resolveToolPath("~/x", repo), join(homedir(), "x"));
    assert.equal(resolveToolPath("@/etc/passwd", repo), "/etc/passwd"); // not <repo>/@/etc/passwd
    assert.equal(resolveToolPath("@stubs/x", repo), join(repo, "stubs/x"));
    assert.equal(resolveToolPath("file:///etc/passwd", repo), "/etc/passwd");
    assert.equal(resolveToolPath("a\u00A0b", repo), join(repo, "a b")); // Unicode spaces become spaces
    assert.equal(resolveToolPath("file://host/x", repo), undefined); // not a local file
  });
});

describe("tool paths", () => {
  const protectedPaths = [".git", ".pi", ".envrc", "package.json"];
  const configFile = () => join(repo, "stubs", "package.scala"); // stands in for pi-gui-confirm.json
  const allowed = (tool: string, path: string) =>
    toolPathIsAllowed(tool, resolveToolPath(path, repo)!, repo, protectedPaths, [configFile()]);

  test("reads must be inside the session folder", () => {
    assert.equal(allowed("read", "stubs/package.scala"), true);
    assert.equal(allowed("read", "/etc/passwd"), false);
    assert.equal(allowed("read", "@/etc/passwd"), false); // pi strips the @
    assert.equal(allowed("read", "file:///etc/passwd"), false);
    assert.equal(allowed("read", "link/x"), false); // through a symlink pointing outside
    assert.equal(allowed("read", ".git/config"), true); // protected paths only apply to edits and writes
  });

  test("edits and writes must be inside and not protected", () => {
    assert.equal(allowed("write", "stubs/new.ts"), true);
    assert.equal(allowed("edit", "stubs/package.scala"), false); // the config file is always protected
    assert.equal(allowed("write", "link/new.txt"), false); // a new file in a symlinked folder is outside
    assert.equal(allowed("write", "new-folder/x.ts"), true); // a new folder inside is fine
    assert.equal(allowed("edit", ".git/config"), false);
    assert.equal(allowed("write", "sub/.git/hooks/pre-commit"), false); // names match at any depth
    assert.equal(allowed("edit", "packages/api/package.json"), false);
    assert.equal(allowed("write", ".envrc"), false);
    assert.equal(allowed("write", "my.git.txt"), true); // only whole names match
  });

  test("symlinks are judged by where they really point", () => {
    // docs-link -> stubs: another place inside.
    assert.equal(allowed("read", "docs-link/package.scala"), true);
    assert.equal(allowed("write", "docs-link/new.ts"), true);
    // hooks -> .git/hooks: the name looks harmless, the real path contains .git.
    assert.equal(allowed("read", "hooks/pre-commit"), true);
    assert.equal(allowed("write", "hooks/pre-commit"), false);
    // settings.json -> the config file.
    assert.equal(allowed("edit", "settings.json"), false);
  });

  test("protectedPaths must be names", async () => {
    await assert.rejects(parseAllowList({ protectedPaths: [".git/"] }), /names without \//);
    await assert.rejects(parseAllowList({ protectedPaths: [""] }), /names without \//);
  });
});
