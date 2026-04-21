import { describe, expect, test } from "bun:test";
import {
  dirtyChar,
  dirtyText,
  parseRemoteUrl,
  computeFingerprint,
  renderSnapshot,
  renderFooter,
  summaryLine,
  isStaleGitCommand,
  type GitSnapshot,
} from "../utils.js";

// ── parseRemoteUrl ─────────────────────────────────────────────────────────

describe("parseRemoteUrl", () => {
  test("ssh shorthand", () => {
    expect(parseRemoteUrl("git@github.com:h14h/pi-packages.git")).toEqual({
      provider: "github.com",
      path: "h14h/pi-packages",
    });
  });

  test("ssh shorthand without .git", () => {
    expect(parseRemoteUrl("git@github.com:h14h/pi-packages")).toEqual({
      provider: "github.com",
      path: "h14h/pi-packages",
    });
  });

  test("https with .git", () => {
    expect(parseRemoteUrl("https://github.com/h14h/pi-packages.git")).toEqual({
      provider: "github.com",
      path: "h14h/pi-packages",
    });
  });

  test("https without .git", () => {
    expect(parseRemoteUrl("https://gitlab.com/org/repo")).toEqual({
      provider: "gitlab.com",
      path: "org/repo",
    });
  });

  test("invalid url returns undefined", () => {
    expect(parseRemoteUrl("not-a-url")).toBeUndefined();
  });
});

// ── dirtyChar / dirtyText ──────────────────────────────────────────────────

describe("dirtyChar", () => {
  test("clean", () => {
    expect(dirtyChar({ modified: 0, staged: 0, untracked: 0, deleted: 0 })).toBe("●");
  });

  test("modified only", () => {
    expect(dirtyChar({ modified: 3, staged: 0, untracked: 0, deleted: 0 })).toBe("◐");
  });

  test("staged only", () => {
    expect(dirtyChar({ modified: 0, staged: 1, untracked: 0, deleted: 0 })).toBe("◐");
  });

  test("untracked only", () => {
    expect(dirtyChar({ modified: 0, staged: 0, untracked: 5, deleted: 0 })).toBe("◐");
  });

  test("deleted only", () => {
    expect(dirtyChar({ modified: 0, staged: 0, untracked: 0, deleted: 2 })).toBe("◐");
  });
});

describe("dirtyText", () => {
  test("formats all counts", () => {
    expect(dirtyText({ modified: 2, staged: 1, untracked: 3, deleted: 0 })).toBe("2M, 1S, 3U, 0D");
  });
});

// ── computeFingerprint ───────────────────────────────────────────────────────

describe("computeFingerprint", () => {
  const base: GitSnapshot = {
    isRepo: true,
    remote: { provider: "github.com", path: "h14h/pi-packages" },
    defaultBranch: { name: "main", sha: "a1b2c3d" },
    current: { name: "feat/x", sha: "b2c3d4e", remoteStatus: "no upstream" },
    worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
    workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
  };

  test("no-repo", () => {
    expect(computeFingerprint({ isRepo: false })).toBe("no-repo");
  });

  test("branch + sha + path + dirty", () => {
    expect(computeFingerprint(base)).toBe("feat/x:b2c3d4e:/repo:0");
  });

  test("changes on dirty count", () => {
    const dirty = { ...base, workingTree: { modified: 1, staged: 0, untracked: 0, deleted: 0 } };
    expect(computeFingerprint(dirty)).toBe("feat/x:b2c3d4e:/repo:1");
  });

  test("detached HEAD", () => {
    const detached = { ...base, current: { sha: "abc1234", detached: true } };
    expect(computeFingerprint(detached)).toBe("detached:abc1234:/repo:0");
  });
});

// ── renderSnapshot ─────────────────────────────────────────────────────────

describe("renderSnapshot", () => {
  test("not in a git repository", () => {
    expect(renderSnapshot({ isRepo: false })).toBe("[Git State]\nNot in a git repository.");
  });

  test("no remote, default branch, clean", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      defaultBranch: { name: "main", sha: "a1b2c3d" },
      current: { name: "main", sha: "a1b2c3d", remoteStatus: "local only" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nBranch: main (a1b2c3d), local only\nWorking tree: clean",
    );
  });

  test("remote, default branch known, on default branch, dirty, ahead", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      defaultBranch: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      current: { name: "main", sha: "a1b2c3d", remoteStatus: "ahead 2 / behind 0" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 3, staged: 1, untracked: 2, deleted: 0 },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nRemote: github.com/h14h/pi-packages\nBranch: main (a1b2c3d), ahead 2 / behind 0\nWorking tree: dirty (3M, 1S, 2U, 0D)",
    );
  });

  test("non-default branch, clean, no upstream, no PR", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      defaultBranch: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      current: { name: "feat/auth-refactor", sha: "b2c3d4e", rootDistance: "+3 commits from main", remoteStatus: "no upstream" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nRemote: github.com/h14h/pi-packages\nDefault branch (main, a1b2c3d): synced with origin\nBranch: feat/auth-refactor (b2c3d4e), +3 commits from main, no upstream\nWorking tree: clean",
    );
  });

  test("non-default branch, dirty, with PR", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      defaultBranch: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      current: { name: "feat/auth-refactor", sha: "b2c3d4e", rootDistance: "+3 commits from main", remoteStatus: "ahead 1 / behind 0" },
      pr: { number: 42, state: "Ready" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 2, staged: 1, untracked: 1, deleted: 0 },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nRemote: github.com/h14h/pi-packages\nDefault branch (main, a1b2c3d): synced with origin\nBranch: feat/auth-refactor (b2c3d4e), +3 commits from main, ahead 1 / behind 0\nPR: #42 (Ready)\nWorking tree: dirty (2M, 1S, 1U, 0D)",
    );
  });

  test("linked worktree on non-default branch, primary worktree dirty", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      defaultBranch: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      current: { name: "feat/auth-refactor", sha: "b2c3d4e", rootDistance: "+3 commits from main", remoteStatus: "ahead 1 / behind 0" },
      pr: { number: 42, state: "Draft" },
      worktree: {
        path: "/Users/h14h/wt/refactor",
        isLinked: true,
        primaryPath: "/Users/h14h/code/pro/pi-packages",
        linkedCount: 1,
        linkedGroups: [{ parent: "/Users/h14h/wt", count: 1 }],
      },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
      primaryWorktree: {
        branchName: "main",
        sha: "a1b2c3d",
        remoteStatus: "synced with origin",
        modified: 3,
        staged: 0,
        untracked: 1,
        deleted: 0,
      },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nRemote: github.com/h14h/pi-packages\nDefault branch (main, a1b2c3d): synced with origin\nBranch: feat/auth-refactor (b2c3d4e), +3 commits from main, ahead 1 / behind 0\nPR: #42 (Draft)\nCurrent worktree: /Users/h14h/wt/refactor (linked)\nPrimary worktree: /Users/h14h/code/pro/pi-packages\nLinked worktrees: 1 total\n  (1) /Users/h14h/wt\nWorking tree: clean\nPrimary worktree (main, a1b2c3d): synced with origin, dirty (3M, 0S, 1U, 0D)",
    );
  });

  test("default branch undetermined", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      current: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
      warning: "[Warning: default branch could not be determined]",
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\n[Warning: default branch could not be determined]\nRemote: github.com/h14h/pi-packages\nBranch: main (a1b2c3d), synced with origin\nWorking tree: clean",
    );
  });

  test("detached HEAD", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      remote: { provider: "github.com", path: "h14h/pi-packages" },
      defaultBranch: { name: "main", sha: "a1b2c3d", remoteStatus: "synced with origin" },
      current: { sha: "a1b2c3d", detached: true },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
    };
    expect(renderSnapshot(snap)).toBe(
      "[Git State]\nRemote: github.com/h14h/pi-packages\nDefault branch (main, a1b2c3d): synced with origin\nDetached HEAD (a1b2c3d)\nWorking tree: clean",
    );
  });
});

// ── renderFooter ───────────────────────────────────────────────────────────

describe("renderFooter", () => {
  const base: GitSnapshot = {
    isRepo: true,
    current: { name: "main", sha: "a1b2c3d", remoteStatus: "synced" },
    worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
    workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
  };

  test("clean primary, idle", () => {
    expect(renderFooter(base, false, 0)).toBe("· ● (a1b2c3d) ✓");
  });

  test("dirty primary, idle", () => {
    const dirty = { ...base, workingTree: { modified: 2, staged: 0, untracked: 0, deleted: 0 } };
    expect(renderFooter(dirty, false, 0)).toBe("· ◐ (a1b2c3d) ✓");
  });

  test("linked worktree, refreshing", () => {
    const linked = {
      ...base,
      worktree: { path: "/wt", isLinked: true, linkedCount: 1, linkedGroups: [] },
    };
    expect(renderFooter(linked, true, 3)).toBe("◈ ● (a1b2c3d) ⠸");
  });

  test("warning state", () => {
    const warned = { ...base, warning: "[Warning: ...]" };
    expect(renderFooter(warned, false, 0)).toBe("· ● (a1b2c3d) ?");
  });

  test("detached HEAD", () => {
    const detached = { ...base, current: { sha: "abc1234", detached: true } };
    expect(renderFooter(detached, false, 0)).toBe("· ● (abc1234) ✓");
  });
});

// ── summaryLine ────────────────────────────────────────────────────────────

describe("summaryLine", () => {
  test("branch clean", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      current: { name: "main", sha: "a1b2c3d" },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 0, staged: 0, untracked: 0, deleted: 0 },
    };
    expect(summaryLine(snap)).toBe("[Git State] main (a1b2c3d) ●");
  });

  test("detached dirty", () => {
    const snap: GitSnapshot = {
      isRepo: true,
      current: { sha: "abc1234", detached: true },
      worktree: { path: "/repo", isLinked: false, linkedCount: 0, linkedGroups: [] },
      workingTree: { modified: 1, staged: 0, untracked: 0, deleted: 0 },
    };
    expect(summaryLine(snap)).toBe("[Git State] detached (abc1234) ◐");
  });

  test("not in repo", () => {
    expect(summaryLine({ isRepo: false })).toBe("[Git State] Not in a git repository");
  });
});

// ── isStaleGitCommand ──────────────────────────────────────────────────────

describe("isStaleGitCommand", () => {
  test("matches stale git commands", () => {
    expect(isStaleGitCommand("git status")).toBe(true);
    expect(isStaleGitCommand("git status --short")).toBe(true);
    expect(isStaleGitCommand("git branch")).toBe(true);
    expect(isStaleGitCommand("git branch -a")).toBe(true);
    expect(isStaleGitCommand("git diff")).toBe(true);
    expect(isStaleGitCommand("git diff --cached")).toBe(true);
    expect(isStaleGitCommand("git stash list")).toBe(true);
    expect(isStaleGitCommand("git worktree list")).toBe(true);
    expect(isStaleGitCommand("git remote")).toBe(true);
    expect(isStaleGitCommand("git remote -v")).toBe(true);
  });

  test("does not match historical/constant git commands", () => {
    expect(isStaleGitCommand("git show abc123")).toBe(false);
    expect(isStaleGitCommand("git blame file.ts")).toBe(false);
    expect(isStaleGitCommand("git config --get user.name")).toBe(false);
    expect(isStaleGitCommand("git log --oneline -5")).toBe(false);
    expect(isStaleGitCommand("git diff-tree abc123")).toBe(false);
    expect(isStaleGitCommand("git diff-index HEAD")).toBe(false);
  });

  test("does not match non-git commands", () => {
    expect(isStaleGitCommand("ls -la")).toBe(false);
    expect(isStaleGitCommand("cat package.json")).toBe(false);
  });

  test("handles compound shell commands", () => {
    expect(isStaleGitCommand("cd /repo && git status")).toBe(true);
    expect(isStaleGitCommand("git status | grep modified")).toBe(true);
    expect(isStaleGitCommand("echo done && git log")).toBe(false);
  });
});
