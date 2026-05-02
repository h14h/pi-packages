import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(packageDir, "scripts", "git-state.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "effect-mode-git-state-"));
  run("git", ["init", "-b", "main"], { cwd: dir });
  run("git", ["config", "user.email", "effect-mode@example.invalid"], { cwd: dir });
  run("git", ["config", "user.name", "Effect Mode Test"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "# test\n", "utf8");
  run("git", ["add", "README.md"], { cwd: dir });
  run("git", ["commit", "-m", "initial commit"], { cwd: dir });
  return dir;
}

test("git-state compact mode omits normal/default diagnostic fields", () => {
  const repo = makeRepo();
  try {
    const result = run(process.execPath, [script], { cwd: repo });
    const out = result.stdout;
    assert.match(out, /^git:\n/);
    assert.match(out, /  branch: main\n/);
    assert.match(out, /  workingTree: clean\n/);
    assert.match(out, /  lastCommit: initial commit\n/);
    assert.doesNotMatch(out, /git-state/);
    assert.doesNotMatch(out, /insideWorktree/);
    assert.doesNotMatch(out, /changedFiles: none/);
    assert.doesNotMatch(out, /stash: none/);
    assert.doesNotMatch(out, /worktrees:/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git-state compact mode preserves dirty working tree details", () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "dirty.txt"), "dirty\n", "utf8");
    const result = run(process.execPath, [script], { cwd: repo });
    const out = result.stdout;
    assert.match(out, /  workingTree: dirty\n/);
    assert.match(out, /  changes: untracked 1\n/);
    assert.match(out, /changedFiles \(1\/1\):\n/);
    assert.match(out, /- untracked dirty\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git-state debug mode keeps verbose diagnostics", () => {
  const repo = makeRepo();
  try {
    const result = run(process.execPath, [script, "--debug"], { cwd: repo });
    const out = result.stdout;
    assert.match(out, /^git-state\nrepo:\n/);
    assert.match(out, /insideWorktree: yes/);
    assert.match(out, /changedFiles: none/);
    assert.match(out, /stash: none/);
    assert.match(out, /worktrees:/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("git-state outside a git worktree reports compact unavailable state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "effect-mode-no-git-"));
  try {
    const result = run(process.execPath, [script], { cwd: dir });
    const out = result.stdout;
    assert.match(out, /^git:\n/);
    assert.match(out, /status: not a git worktree/);
    assert.doesNotMatch(out, /insideWorktree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
