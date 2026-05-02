#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const COMMAND_TIMEOUT_MS = 800;
const STATUS_LIST_LIMIT = 30;
const WORKTREE_LINK_LIMIT = 10;

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 256 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error.message ?? result.error), status: null };
  }

  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? "").trimEnd(),
    stderr: String(result.stderr ?? "").trimEnd(),
    status: result.status,
  };
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/, 1)[0] ?? "";
}

function shortSha(value) {
  return value ? String(value).slice(0, 7) : "unknown";
}

function compactSubject(value) {
  const line = firstLine(value).trim();
  if (!line) return "unknown";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function stripRemoteCredentials(value) {
  const remote = firstLine(value).trim();
  if (!remote) return "none";

  try {
    const parsed = new URL(remote);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return remote.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i, "$1");
  }
}

function aheadBehind(leftRightCountOutput) {
  const [ahead, behind] = firstLine(leftRightCountOutput).trim().split(/\s+/, 2);
  if (ahead === undefined || behind === undefined) return null;
  if (!/^\d+$/.test(ahead) || !/^\d+$/.test(behind)) return null;
  return { ahead: Number(ahead), behind: Number(behind) };
}

function formatAheadBehind(counts) {
  if (!counts) return "unknown";
  return `ahead ${counts.ahead}, behind ${counts.behind}`;
}

function statusLabels(xy, isConflict, isUntracked) {
  if (isConflict) return ["conflict"];
  if (isUntracked) return ["untracked"];

  const labels = [];
  if (xy[0] === "D" || xy[1] === "D") labels.push("deleted");
  if (xy[0] && xy[0] !== " " && xy[0] !== "D") labels.push("staged");
  if (xy[1] && xy[1] !== " " && xy[1] !== "D") labels.push("modified");
  return labels.length > 0 ? labels : ["changed"];
}

function parseStatus(statusOutput) {
  const lines = statusOutput ? statusOutput.split(/\r?\n/) : [];
  const entries = [];
  const counts = { staged: 0, modified: 0, untracked: 0, deleted: 0, conflicts: 0 };

  for (const line of lines) {
    if (!line || line.startsWith("## ")) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    const isUntracked = xy === "??";
    const isConflict = xy === "DD" || xy === "AA" || xy.includes("U");
    const labels = statusLabels(xy, isConflict, isUntracked);

    if (isUntracked) {
      counts.untracked += 1;
    } else if (isConflict) {
      counts.conflicts += 1;
    } else {
      if (xy[0] && xy[0] !== " ") counts.staged += 1;
      if (xy[1] && xy[1] !== " ") counts.modified += 1;
      if (xy[0] === "D" || xy[1] === "D") counts.deleted += 1;
    }

    entries.push({ xy, file, isConflict, labels, render: `${labels.join("+")} ${file}` });
  }

  return { entries, counts };
}

function parseWorktrees(output) {
  if (!output) return [];
  const blocks = output.split(/\r?\n\r?\n/).filter(Boolean);
  const worktrees = [];

  for (const block of blocks) {
    const wt = { path: "", head: "", branch: "", detached: false, bare: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wt.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) wt.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) wt.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") wt.detached = true;
      else if (line === "bare") wt.bare = true;
    }
    if (wt.path) worktrees.push(wt);
  }

  return worktrees;
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function compactPath(targetPath, repoRoot) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(repoRoot);
  if (samePath(resolvedTarget, resolvedRoot)) return ".";

  const relToRoot = path.relative(resolvedRoot, resolvedTarget);
  if (relToRoot && !relToRoot.startsWith("..") && !path.isAbsolute(relToRoot)) return relToRoot;

  const relToCwd = path.relative(process.cwd(), resolvedTarget);
  if (relToCwd && !relToCwd.startsWith("../..") && !path.isAbsolute(relToCwd)) return relToCwd;

  return path.join(path.basename(path.dirname(resolvedTarget)), path.basename(resolvedTarget));
}

function formatWorktreeRow(kind, wt, repoRoot, currentDirty) {
  const state = wt.bare
    ? "state=bare"
    : wt.branch
      ? `branch=${wt.branch}`
      : "detached=yes";
  const dirty = typeof currentDirty === "boolean" ? ` dirty=${currentDirty ? "yes" : "no"}` : "";
  return `- ${kind} path=${compactPath(wt.path, repoRoot)} ${state} head=${shortSha(wt.head)}${dirty}`;
}

function printOutsideGit(reason) {
  const lines = [
    "git-state",
    "repo:",
    "  insideWorktree: no",
    `  cwd: ${process.cwd()}`,
    `  status: ${reason}`,
    "  remoteFreshness: not fetched by effect",
  ];
  console.log(lines.join("\n"));
}

const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
if (!inside.ok || firstLine(inside.stdout).trim() !== "true") {
  printOutsideGit("not a git worktree");
  process.exit(0);
}

const rootResult = runGit(["rev-parse", "--show-toplevel"]);
const repoRoot = rootResult.ok && rootResult.stdout ? firstLine(rootResult.stdout).trim() : process.cwd();

const branchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
const branchName = branchResult.ok ? firstLine(branchResult.stdout).trim() : "HEAD";
const isDetached = branchName === "HEAD" || branchName === "";
const headResult = runGit(["rev-parse", "--short=7", "HEAD"]);
const head = headResult.ok ? firstLine(headResult.stdout).trim() : "unknown";
const upstreamResult = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
const upstream = upstreamResult.ok ? firstLine(upstreamResult.stdout).trim() : "none";
const upstreamCounts = upstream !== "none" ? aheadBehind(runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { timeoutMs: 1000 }).stdout) : null;
const originResult = runGit(["remote", "get-url", "origin"]);
const origin = originResult.ok ? stripRemoteCredentials(originResult.stdout) : "none";
const defaultResult = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
const defaultBranch = defaultResult.ok ? firstLine(defaultResult.stdout).trim() : "unknown";
const defaultCounts = defaultBranch !== "unknown" ? aheadBehind(runGit(["rev-list", "--left-right", "--count", `HEAD...${defaultBranch}`], { timeoutMs: 1000 }).stdout) : null;
const lastCommitResult = runGit(["log", "-1", "--pretty=%s"]);
const stashResult = runGit(["stash", "list", "--format=%gd: %gs"], { timeoutMs: 1000, maxBuffer: 128 * 1024 });
const stashLines = stashResult.ok && stashResult.stdout ? stashResult.stdout.split(/\r?\n/).filter(Boolean) : [];
const statusResult = runGit(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-b"], { timeoutMs: 1200, maxBuffer: 512 * 1024 });
const status = parseStatus(statusResult.ok ? statusResult.stdout : "");
const dirty = status.entries.length > 0;
const worktreeResult = runGit(["worktree", "list", "--porcelain"], { timeoutMs: 1000, maxBuffer: 256 * 1024 });
const worktrees = parseWorktrees(worktreeResult.ok ? worktreeResult.stdout : "");
const currentWorktree = worktrees.find((wt) => samePath(wt.path, repoRoot)) ?? { path: repoRoot, head, branch: isDetached ? "" : branchName, detached: isDetached, bare: false };
const linkedWorktrees = worktrees.filter((wt) => !samePath(wt.path, repoRoot)).slice(0, WORKTREE_LINK_LIMIT);
const totalLinkedWorktrees = worktrees.filter((wt) => !samePath(wt.path, repoRoot)).length;

const lines = [];
lines.push("git-state");
lines.push("repo:");
lines.push("  insideWorktree: yes");
lines.push(`  root: ${compactPath(repoRoot, repoRoot)}`);
lines.push(`  cwd: ${compactPath(process.cwd(), repoRoot)}`);
lines.push(`  branch: ${isDetached ? `detached ${head}` : branchName}`);
lines.push(`  head: ${head}`);
lines.push(`  upstream: ${upstream}${upstreamCounts ? ` (${formatAheadBehind(upstreamCounts)})` : upstream === "none" ? "" : " (unknown)"}`);
if (upstream === "none" && !isDetached) lines.push(`  publishStatus: no upstream for branch ${branchName}`);
lines.push(`  origin: ${origin}`);
lines.push(`  vsDefault: ${defaultBranch === "unknown" ? "unknown" : `HEAD ${formatAheadBehind(defaultCounts)} from ${defaultBranch}`}`);
lines.push("  remoteFreshness: not fetched by effect");
lines.push(`  lastCommit: ${compactSubject(lastCommitResult.ok ? lastCommitResult.stdout : "")}`);
lines.push(`  stash: ${stashLines.length === 0 ? "none" : `${stashLines.length} (top: ${compactSubject(stashLines[0])})`}`);
lines.push("workingTree:");
lines.push(`  state: ${dirty ? "dirty" : "clean"}`);
lines.push(`  counts: staged ${status.counts.staged}, modified ${status.counts.modified}, untracked ${status.counts.untracked}, deleted ${status.counts.deleted}, conflicts ${status.counts.conflicts}`);
if (status.entries.length === 0) {
  lines.push("  changedFiles: none");
} else {
  const shown = status.entries.slice(0, STATUS_LIST_LIMIT);
  lines.push(`  changedFiles (${shown.length}/${status.entries.length}):`);
  for (const entry of shown) lines.push(`    ${entry.render}`);
  if (status.entries.length > shown.length) lines.push(`    ... ${status.entries.length - shown.length} more not shown`);

  const shownConflicts = new Set(shown.filter((entry) => entry.isConflict).map((entry) => entry.file));
  const hiddenConflicts = status.entries.filter((entry) => entry.isConflict && !shownConflicts.has(entry.file));
  if (hiddenConflicts.length > 0) {
    lines.push(`  conflictFiles (${hiddenConflicts.length} hidden above):`);
    for (const entry of hiddenConflicts) lines.push(`    ${entry.render}`);
  }
}
lines.push("worktrees:");
lines.push(`  ${formatWorktreeRow("current", currentWorktree, repoRoot, dirty)}`);
if (totalLinkedWorktrees === 0) {
  lines.push("  linked: none");
} else {
  lines.push(`  linked (${linkedWorktrees.length}/${totalLinkedWorktrees}):`);
  for (const wt of linkedWorktrees) lines.push(`    ${formatWorktreeRow("linked", wt, repoRoot)}`);
  if (totalLinkedWorktrees > linkedWorktrees.length) lines.push(`    ... ${totalLinkedWorktrees - linkedWorktrees.length} more not shown`);
}

console.log(lines.join("\n"));
