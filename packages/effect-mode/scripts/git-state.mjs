#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 800;
const STATUS_LIST_LIMIT = 30;
const WORKTREE_LINK_LIMIT = 10;
const REMOTE_CACHE_VERSION = 1;
const DEFAULT_REMOTE_OPTIONS = {
  remoteMode: "off",
  remoteTtlMs: 900_000,
  remoteErrorTtlMs: 300_000,
  remoteTimeoutMs: 15_000,
  remoteLockTtlMs: 120_000,
};

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

function compactMessage(value) {
  const line = firstLine(value).trim();
  if (!line) return "unknown";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
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

function isScalarOptionValue(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseEffectOptions() {
  const warnings = [];
  const opts = { ...DEFAULT_REMOTE_OPTIONS };
  const raw = process.env.PI_EFFECT_OPTIONS_JSON;
  let parsed = {};

  if (raw && raw.trim()) {
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        warnings.push("PI_EFFECT_OPTIONS_JSON must be an object; using defaults");
      } else {
        for (const [key, optionValue] of Object.entries(value)) {
          if (!isScalarOptionValue(optionValue)) {
            warnings.push(`ignored non-scalar option ${key}`);
            continue;
          }
          parsed[key] = optionValue;
        }
      }
    } catch (error) {
      warnings.push(`invalid PI_EFFECT_OPTIONS_JSON: ${compactMessage(error instanceof Error ? error.message : String(error))}`);
    }
  }

  if (parsed.remoteMode !== undefined) {
    if (parsed.remoteMode === "off" || parsed.remoteMode === "background") opts.remoteMode = parsed.remoteMode;
    else warnings.push("remoteMode must be 'off' or 'background'; using off");
  }

  for (const key of ["remoteTtlMs", "remoteErrorTtlMs"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key] >= 0) opts[key] = parsed[key];
    else warnings.push(`${key} must be a non-negative number; using default`);
  }

  for (const key of ["remoteTimeoutMs", "remoteLockTtlMs"]) {
    if (parsed[key] === undefined) continue;
    if (typeof parsed[key] === "number" && Number.isFinite(parsed[key]) && parsed[key] > 0) opts[key] = parsed[key];
    else warnings.push(`${key} must be a positive number; using default`);
  }

  return { options: opts, warnings };
}

function formatAge(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function getRemoteDir() {
  const result = runGit(["rev-parse", "--git-common-dir"]);
  if (!result.ok || !result.stdout) return null;
  const commonDir = firstLine(result.stdout).trim();
  const absoluteCommonDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(process.cwd(), commonDir);
  return path.join(absoluteCommonDir, "pi", "git-state");
}

function remoteCachePath(remoteDir) {
  return path.join(remoteDir, "remote-cache.json");
}

function remoteLockPath(remoteDir) {
  return path.join(remoteDir, "remote-refresh.lock");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readRemoteCache(remoteDir) {
  if (!remoteDir) return null;
  const value = readJsonFile(remoteCachePath(remoteDir));
  if (!value || typeof value !== "object") return null;
  if (value.version !== REMOTE_CACHE_VERSION) return null;
  if (value.strategy !== "git-fetch") return null;
  if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return null;
  return value;
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, "utf8");
  renameSync(tmp, file);
}

function liveLockInfo(remoteDir, lockTtlMs) {
  if (!remoteDir) return { live: false };
  const lockPath = remoteLockPath(remoteDir);
  if (!existsSync(lockPath)) return { live: false };

  const value = readJsonFile(lockPath);
  const startedAt = value && typeof value.startedAt === "number" ? value.startedAt : 0;
  if (startedAt > 0 && Date.now() - startedAt <= lockTtlMs) return { live: true, startedAt };

  try {
    unlinkSync(lockPath);
  } catch {
    // Ignore races with another worker.
  }
  return { live: false };
}

function acquireRemoteLock(remoteDir, lockTtlMs) {
  mkdirSync(remoteDir, { recursive: true });
  if (liveLockInfo(remoteDir, lockTtlMs).live) return false;

  const lockPath = remoteLockPath(remoteDir);
  let fd;
  try {
    fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function releaseRemoteLock(remoteDir) {
  try {
    unlinkSync(remoteLockPath(remoteDir));
  } catch {
    // Ignore missing/raced lock cleanup.
  }
}

function cacheIsStale(cache, options) {
  if (!cache) return true;
  const ttl = cache.ok ? options.remoteTtlMs : options.remoteErrorTtlMs;
  return Date.now() - cache.checkedAt > ttl;
}

function spawnRemoteRefresh() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--remote-refresh"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function remoteStatusLine(mode, cache, stale, lockLive, refreshStarted) {
  if (mode === "off") return "off";
  if (lockLive) return "refreshing";
  if (stale) {
    const age = cache?.checkedAt ? ` ${formatAge(Date.now() - cache.checkedAt)}` : "";
    return refreshStarted ? `stale${age}; refresh started` : `stale${age}`;
  }

  const age = formatAge(Date.now() - cache.checkedAt);
  if (cache.ok) return `ok ${age} ago via ${cache.strategy} (${Math.max(0, Math.round(cache.durationMs ?? 0))}ms)`;
  return `error ${age} ago via ${cache.strategy}: ${compactMessage(cache.error ?? `exit ${cache.exitCode ?? "unknown"}`)}`;
}

function remoteTrackingLine(mode, cache) {
  if (mode === "background" && cache?.ok && typeof cache.checkedAt === "number") {
    return `local refs; last git-state fetch ${formatAge(Date.now() - cache.checkedAt)} ago`;
  }
  return "local refs; not freshly fetched by git-state";
}

function runRemoteRefresh(options) {
  const remoteDir = getRemoteDir();
  if (!remoteDir) return 0;
  if (!acquireRemoteLock(remoteDir, options.remoteLockTtlMs)) return 0;

  const startedAt = Date.now();
  try {
    const result = spawnSync("git", ["fetch", "--prune", "--no-tags", "--quiet", "origin"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: options.remoteTimeoutMs,
      maxBuffer: 128 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const checkedAt = Date.now();
    const error = result.error
      ? compactMessage(result.error.message ?? result.error)
      : result.status === 0
        ? undefined
        : compactMessage(result.stderr || result.stdout || `exit ${result.status ?? "unknown"}`);

    atomicWriteJson(remoteCachePath(remoteDir), {
      version: REMOTE_CACHE_VERSION,
      strategy: "git-fetch",
      startedAt,
      checkedAt,
      durationMs: checkedAt - startedAt,
      ok: !result.error && result.status === 0,
      exitCode: typeof result.status === "number" ? result.status : null,
      ...(error ? { error } : {}),
    });
  } finally {
    releaseRemoteLock(remoteDir);
  }

  return 0;
}

function remoteCompactLine(mode, cache, stale, lockLive, refreshStarted) {
  if (mode === "off") return "local refs only; no remote refresh configured";
  if (!cache || typeof cache.checkedAt !== "number") {
    if (lockLive) return "refreshing; no remote refresh cache";
    if (stale) return refreshStarted ? "refs stale; refresh started" : "refs stale";
    return "local refs only; no remote refresh cache";
  }

  const age = formatAge(Date.now() - cache.checkedAt);
  const failure = !cache.ok ? `last check failed ${age} ago via ${cache.strategy}: ${compactMessage(cache.error ?? `exit ${cache.exitCode ?? "unknown"}`)}` : "";
  if (lockLive) return failure ? `refreshing; ${failure}` : "refreshing";
  if (stale) {
    if (failure) return refreshStarted ? `${failure}; refresh started` : failure;
    return refreshStarted ? `refs stale ${age} ago; refresh started` : `refs stale ${age} ago`;
  }

  if (cache.ok) return `checked ${age} ago via ${cache.strategy}`;
  return failure;
}

function compactUpstream(upstream, counts) {
  if (upstream === "none") return "none";
  if (!counts) return `${upstream}, sync unknown`;
  if (counts.ahead === 0 && counts.behind === 0) return `${upstream}, up-to-date`;
  const parts = [];
  if (counts.ahead > 0) parts.push(`ahead ${counts.ahead}`);
  if (counts.behind > 0) parts.push(`behind ${counts.behind}`);
  return `${upstream}, ${parts.join(", ")}`;
}

function printOutsideGit(reason, optionWarnings, remoteMode, verbose) {
  if (verbose) {
    const lines = [
      "git-state",
      "repo:",
      "  insideWorktree: no",
      `  cwd: ${process.cwd()}`,
      `  status: ${reason}`,
      "  remoteTracking: local refs; not freshly fetched by git-state",
      `  remoteCheck: ${remoteMode === "off" ? "off" : "unavailable outside worktree"}`,
    ];
    for (const warning of optionWarnings) lines.push(`  optionsWarning: ${warning}`);
    console.log(lines.join("\n"));
    return;
  }

  const lines = [
    "git:",
    "  status: not a git worktree",
    `  cwd: ${process.cwd()}`,
  ];
  if (reason && reason !== "not a git worktree") lines.push(`  reason: ${reason}`);
  if (remoteMode === "background") lines.push("  remote: unavailable outside worktree");
  for (const warning of optionWarnings) lines.push(`  optionsWarning: ${warning}`);
  console.log(lines.join("\n"));
}

function renderDebugGitState({
  repoRoot,
  branchName,
  isDetached,
  head,
  upstream,
  upstreamCounts,
  origin,
  defaultBranch,
  defaultCounts,
  remoteOptions,
  remoteCache,
  remoteStale,
  remoteLock,
  remoteRefreshStarted,
  optionWarnings,
  lastCommitResult,
  stashLines,
  status,
  dirty,
  currentWorktree,
  linkedWorktrees,
  totalLinkedWorktrees,
}) {
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
  lines.push(`  remoteTracking: ${remoteTrackingLine(remoteOptions.remoteMode, remoteCache)}`);
  lines.push(`  remoteCheck: ${remoteStatusLine(remoteOptions.remoteMode, remoteCache, remoteStale, remoteLock.live, remoteRefreshStarted)}`);
  for (const warning of optionWarnings) lines.push(`  optionsWarning: ${warning}`);
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
  return lines.join("\n");
}

function renderCompactGitState({
  repoRoot,
  branchName,
  isDetached,
  head,
  upstream,
  upstreamCounts,
  origin,
  defaultBranch,
  defaultCounts,
  remoteOptions,
  remoteCache,
  remoteStale,
  remoteLock,
  remoteRefreshStarted,
  optionWarnings,
  lastCommitResult,
  stashLines,
  status,
  dirty,
  linkedWorktrees,
  totalLinkedWorktrees,
}) {
  const lines = [];
  lines.push("git:");
  const cwd = compactPath(process.cwd(), repoRoot);
  if (cwd !== ".") lines.push(`  cwd: ${cwd}`);
  lines.push(`  branch: ${isDetached ? `detached ${head}` : branchName}`);
  lines.push(`  head: ${head}`);
  lines.push(`  upstream: ${compactUpstream(upstream, upstreamCounts)}`);
  if (upstream === "none" && !isDetached) lines.push(`  publishStatus: no upstream for branch ${branchName}`);
  if (origin === "none") lines.push("  origin: none");
  if (defaultBranch === "unknown") {
    lines.push("  defaultBranch: unknown");
  } else if (defaultCounts && (defaultCounts.ahead !== 0 || defaultCounts.behind !== 0) && defaultBranch !== upstream) {
    lines.push(`  vsDefault: ${formatAheadBehind(defaultCounts)} from ${defaultBranch}`);
  }
  lines.push(`  remote: ${remoteCompactLine(remoteOptions.remoteMode, remoteCache, remoteStale, remoteLock.live, remoteRefreshStarted)}`);
  for (const warning of optionWarnings) lines.push(`  optionsWarning: ${warning}`);
  lines.push(`  workingTree: ${dirty ? "dirty" : "clean"}`);
  if (dirty) {
    const countParts = [];
    if (status.counts.staged) countParts.push(`staged ${status.counts.staged}`);
    if (status.counts.modified) countParts.push(`modified ${status.counts.modified}`);
    if (status.counts.untracked) countParts.push(`untracked ${status.counts.untracked}`);
    if (status.counts.deleted) countParts.push(`deleted ${status.counts.deleted}`);
    if (status.counts.conflicts) countParts.push(`conflicts ${status.counts.conflicts}`);
    if (countParts.length > 0) lines.push(`  changes: ${countParts.join(", ")}`);

    const shown = status.entries.slice(0, STATUS_LIST_LIMIT);
    lines.push(`  changedFiles (${shown.length}/${status.entries.length}):`);
    for (const entry of shown) lines.push(`    - ${entry.render}`);
    if (status.entries.length > shown.length) lines.push(`    - ... ${status.entries.length - shown.length} more not shown`);

    const shownConflicts = new Set(shown.filter((entry) => entry.isConflict).map((entry) => entry.file));
    const hiddenConflicts = status.entries.filter((entry) => entry.isConflict && !shownConflicts.has(entry.file));
    if (hiddenConflicts.length > 0) {
      lines.push(`  conflictFiles (${hiddenConflicts.length} hidden above):`);
      for (const entry of hiddenConflicts) lines.push(`    - ${entry.render}`);
    }
  }
  lines.push(`  lastCommit: ${compactSubject(lastCommitResult.ok ? lastCommitResult.stdout : "")}`);
  if (stashLines.length > 0) lines.push(`  stash: ${stashLines.length} (top: ${compactSubject(stashLines[0])})`);
  if (totalLinkedWorktrees > 0) {
    lines.push(`  linkedWorktrees (${linkedWorktrees.length}/${totalLinkedWorktrees}):`);
    for (const wt of linkedWorktrees) lines.push(`    - path=${compactPath(wt.path, repoRoot)} ${wt.branch ? `branch=${wt.branch}` : "detached=yes"} head=${shortSha(wt.head)}`);
    if (totalLinkedWorktrees > linkedWorktrees.length) lines.push(`    - ... ${totalLinkedWorktrees - linkedWorktrees.length} more not shown`);
  }
  return lines.join("\n");
}

const isRemoteRefresh = process.argv.includes("--remote-refresh");
const verbose = process.argv.includes("--debug") || process.argv.includes("--verbose");
const { options: remoteOptions, warnings: optionWarnings } = parseEffectOptions();

const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
if (!inside.ok || firstLine(inside.stdout).trim() !== "true") {
  if (!isRemoteRefresh) printOutsideGit("not a git worktree", optionWarnings, remoteOptions.remoteMode, verbose);
  process.exit(0);
}

if (isRemoteRefresh) process.exit(runRemoteRefresh(remoteOptions));

const remoteDir = getRemoteDir();
const remoteCache = readRemoteCache(remoteDir);
const remoteStale = remoteOptions.remoteMode === "background" ? cacheIsStale(remoteCache, remoteOptions) : false;
const remoteLock = remoteOptions.remoteMode === "background" ? liveLockInfo(remoteDir, remoteOptions.remoteLockTtlMs) : { live: false };
const remoteRefreshStarted = remoteOptions.remoteMode === "background" && remoteStale && !remoteLock.live ? spawnRemoteRefresh() : false;

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

const renderInput = {
  repoRoot,
  branchName,
  isDetached,
  head,
  upstream,
  upstreamCounts,
  origin,
  defaultBranch,
  defaultCounts,
  remoteOptions,
  remoteCache,
  remoteStale,
  remoteLock,
  remoteRefreshStarted,
  optionWarnings,
  lastCommitResult,
  stashLines,
  status,
  dirty,
  currentWorktree,
  linkedWorktrees,
  totalLinkedWorktrees,
};

console.log(verbose ? renderDebugGitState(renderInput) : renderCompactGitState(renderInput));
