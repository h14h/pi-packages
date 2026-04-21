import type {
  AgentMessage,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Box, Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import {
  CACHE_TTL_MS,
  CUSTOM_TYPE,
  SPINNER,
  type Cache,
  type GitSnapshot,
  renderFooter,
  renderSnapshot,
  summaryLine,
  parseRemoteUrl,
  dirtyText,
} from "./utils.js";

// ── Mutable runtime state ──────────────────────────────────────────────────

let cache: Cache | null = null;
let lastPersistedSnapshot: string | null = null;
let pendingToolMutation = false;
let refreshing = false;
let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

// ── Spinner helpers ────────────────────────────────────────────────────────

function startSpinner(cb: () => void) {
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    cb();
  }, 80);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  spinnerFrame = 0;
}

// ── Git shell-out helpers ──────────────────────────────────────────────────

async function execGit(
  cwd: string,
  pi: ExtensionAPI,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const r = await pi.exec("git", args, { cwd });
  return {
    stdout: (r.stdout ?? "").trimEnd(),
    stderr: (r.stderr ?? "").trimEnd(),
    code: r.code ?? 0,
  };
}

// ── Snapshot builder ─────────────────────────────────────────────────────────

async function buildSnapshot(cwd: string, pi: ExtensionAPI): Promise<GitSnapshot> {
  // Guard: inside work-tree?
  const inside = await execGit(cwd, pi, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { isRepo: false };
  }

  const toplevel = (await execGit(cwd, pi, ["rev-parse", "--show-toplevel"])).stdout.trim();

  // ── Fast identity ──
  const branchRes = await execGit(cwd, pi, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const shaRes = await execGit(cwd, pi, ["rev-parse", "--short", "HEAD"]);
  const branch = branchRes.stdout.trim();
  const sha = shaRes.stdout.trim();
  const isDetached = branch === "HEAD";

  // ── Remote ──
  let remote: { provider: string; path: string } | undefined;
  const remoteUrl = await execGit(cwd, pi, ["remote", "get-url", "origin"]);
  if (remoteUrl.code === 0) {
    remote = parseRemoteUrl(remoteUrl.stdout.trim());
  }

  // ── Default branch ──
  let defaultBranch: { name: string; sha: string; remoteStatus?: string } | undefined;
  let warning: string | undefined;

  if (remote) {
    const symref = await execGit(cwd, pi, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (symref.code === 0) {
      const ref = symref.stdout.trim(); // refs/remotes/origin/main
      const name = ref.replace("refs/remotes/origin/", "");
      const dbSha = (await execGit(cwd, pi, ["rev-parse", "--short", ref])).stdout.trim();
      const ab = await execGit(cwd, pi, [
        "rev-list",
        "--left-right",
        "--count",
        `${name}...origin/${name}`,
      ]);
      let remoteStatus = "local only";
      if (ab.code === 0) {
        const [ahead, behind] = ab.stdout.trim().split(/\s+/).map((s) => parseInt(s, 10));
        if (ahead === 0 && behind === 0) remoteStatus = "synced with origin";
        else remoteStatus = `ahead ${ahead} / behind ${behind}`;
      }
      defaultBranch = { name, sha: dbSha, remoteStatus };
    } else {
      const cfg = await execGit(cwd, pi, ["config", "--get", "init.defaultBranch"]);
      if (cfg.code === 0) {
        const name = cfg.stdout.trim();
        const dbSha = (await execGit(cwd, pi, ["rev-parse", "--short", name])).stdout.trim();
        defaultBranch = { name, sha: dbSha, remoteStatus: "local only" };
      } else {
        warning = "[Warning: default branch could not be determined]";
      }
    }
  } else {
    const cfg = await execGit(cwd, pi, ["config", "--get", "init.defaultBranch"]);
    if (cfg.code === 0) {
      const name = cfg.stdout.trim();
      const dbSha = (await execGit(cwd, pi, ["rev-parse", "--short", name])).stdout.trim();
      defaultBranch = { name, sha: dbSha, remoteStatus: "local only" };
    }
  }

  // ── Current branch details ──
  let current: GitSnapshot["current"];
  let rootDistance: string | undefined;
  let upstreamStatus: string | undefined;

  if (isDetached) {
    current = { sha, detached: true };
  } else {
    // upstream
    const up = await execGit(cwd, pi, [
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${branch}`,
    ]);
    const upstream = up.stdout.trim();
    if (upstream) {
      const ab = await execGit(cwd, pi, [
        "rev-list",
        "--left-right",
        "--count",
        `${branch}...${upstream}`,
      ]);
      if (ab.code === 0) {
        const [ahead, behind] = ab.stdout.trim().split(/\s+/).map((s) => parseInt(s, 10));
        if (ahead === 0 && behind === 0) upstreamStatus = "synced with upstream";
        else upstreamStatus = `ahead ${ahead} / behind ${behind}`;
      }
    } else {
      upstreamStatus = "no upstream";
    }

    // distance from default branch
    if (defaultBranch && branch !== defaultBranch.name) {
      const dist = await execGit(cwd, pi, [
        "rev-list",
        "--count",
        `${defaultBranch.name}..${branch}`,
      ]);
      if (dist.code === 0) {
        const n = parseInt(dist.stdout.trim(), 10);
        rootDistance = n === 0 ? `0 commits from ${defaultBranch.name}` : `+${n} commits from ${defaultBranch.name}`;
      }
    }

    current = { name: branch, sha, remoteStatus: upstreamStatus, rootDistance };
  }

  // ── PR (gh cli) ──
  let pr: { number: number; state: "Draft" | "Ready" } | undefined;
  if (!isDetached && branch !== defaultBranch?.name) {
    const gh = await pi.exec("gh", ["pr", "view", branch, "--json", "number,state", "--jq", "[.number,.state]"], { cwd });
    if (gh.code === 0) {
      const raw = gh.stdout.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length === 2) {
            const state = parsed[1] as string;
            pr = {
              number: parsed[0] as number,
              state: state === "DRAFT" || state === "Draft" ? "Draft" : "Ready",
            };
          }
        } catch {
          // ignore gh json errors
        }
      }
    }
  }

  // ── Worktrees ──
  const wtList = await execGit(cwd, pi, ["worktree", "list", "--porcelain"]);
  let worktree: {
    path: string;
    isLinked: boolean;
    primaryPath?: string;
    linkedCount: number;
    linkedGroups: { parent: string; count: number }[];
  } = { path: toplevel, isLinked: false, linkedCount: 0, linkedGroups: [] };
  let primaryPath: string | undefined;

  if (wtList.code === 0) {
    const entries: { path: string; head?: string; branch?: string; bare?: boolean; detached?: boolean }[] = [];
    let currentEntry: typeof entries[0] = { path: "" };
    for (const line of wtList.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentEntry = { path: line.slice(9).trim() };
        entries.push(currentEntry);
      } else if (line.startsWith("HEAD ")) currentEntry.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) currentEntry.branch = line.slice(7).trim();
      else if (line === "bare") currentEntry.bare = true;
      else if (line === "detached") currentEntry.detached = true;
    }

    const currentWt = entries.find((e) => e.path === toplevel);
    const primary = entries.find((e) => !e.bare);

    if (primary) primaryPath = primary.path;

    const linked = entries.filter((e) => e.path !== primary?.path && !e.bare);
    const groups = new Map<string, number>();
    for (const l of linked) {
      const parent = l.path.split("/").slice(0, -1).join("/") || "/";
      groups.set(parent, (groups.get(parent) ?? 0) + 1);
    }

    worktree = {
      path: toplevel,
      isLinked: !!currentWt && currentWt.path !== primary?.path,
      primaryPath,
      linkedCount: linked.length,
      linkedGroups: Array.from(groups.entries())
        .map(([parent, count]) => ({ parent, count }))
        .sort((a, b) => a.parent.localeCompare(b.parent)),
    };
  }

  // ── Dirty counts ──
  const por = await execGit(cwd, pi, ["status", "--porcelain"]);
  const workingTree: { modified: number; staged: number; untracked: number; deleted: number } = { modified: 0, staged: 0, untracked: 0, deleted: 0 };
  if (por.code === 0) {
    for (const line of por.stdout.split("\n")) {
      if (line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") {
        workingTree.untracked++;
      } else {
        if (x !== " " && x !== "?") workingTree.staged++;
        if (y !== " " && y !== "?") {
          if (y === "D") workingTree.deleted++;
          else workingTree.modified++;
        }
      }
    }
  }

  // ── Primary worktree state (only when current is linked) ──
  let primaryWorktree: GitSnapshot["primaryWorktree"] | undefined;
  if (worktree.isLinked && primaryPath) {
    const pBranch = await execGit(primaryPath, pi, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const pSha = await execGit(primaryPath, pi, ["rev-parse", "--short", "HEAD"]);
    const pName = pBranch.stdout.trim();

    let pRemoteStatus: string | undefined;
    if (pName !== "HEAD") {
      const up = await execGit(primaryPath, pi, [
        "for-each-ref",
        "--format=%(upstream:short)",
        `refs/heads/${pName}`,
      ]);
      const upstream = up.stdout.trim();
      if (upstream) {
        const ab = await execGit(primaryPath, pi, [
          "rev-list",
          "--left-right",
          "--count",
          `${pName}...${upstream}`,
        ]);
        if (ab.code === 0) {
          const [ahead, behind] = ab.stdout.trim().split(/\s+/).map((s) => parseInt(s, 10));
          if (ahead === 0 && behind === 0) pRemoteStatus = "synced with origin";
          else pRemoteStatus = `ahead ${ahead} / behind ${behind}`;
        }
      } else {
        pRemoteStatus = "no upstream";
      }
    }

    const pPor = await execGit(primaryPath, pi, ["status", "--porcelain"]);
    const pDirty: { modified: number; staged: number; untracked: number; deleted: number } = { modified: 0, staged: 0, untracked: 0, deleted: 0 };
    if (pPor.code === 0) {
      for (const line of pPor.stdout.split("\n")) {
        if (line.length < 2) continue;
        const x = line[0];
        const y = line[1];
        if (x === "?" && y === "?") {
          pDirty.untracked++;
        } else {
          if (x !== " " && x !== "?") pDirty.staged++;
          if (y !== " " && y !== "?") {
            if (y === "D") pDirty.deleted++;
            else pDirty.modified++;
          }
        }
      }
    }

    primaryWorktree = {
      branchName: pName === "HEAD" ? "detached" : pName,
      sha: pSha.stdout.trim(),
      remoteStatus: pRemoteStatus,
      ...pDirty,
    };
  }

  return {
    isRepo: true,
    remote,
    defaultBranch,
    current,
    pr,
    worktree,
    workingTree,
    primaryWorktree,
    warning,
  };
}

// ── Cache refresh ──────────────────────────────────────────────────────────

async function refreshCache(
  cwd: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
) {
  if (refreshing) return;
  refreshing = true;
  startSpinner(() => updateFooter(pi, ctx));

  try {
    const snap = await buildSnapshot(cwd, pi);
    cache = {
      snapshot: snap,
      fingerprint: `${"name" in snap.current ? snap.current.name : "detached"}:${snap.current.sha}:${snap.worktree.path}:${snap.workingTree.modified + snap.workingTree.staged + snap.workingTree.untracked + snap.workingTree.deleted}`,
      dirty: false,
      timestamp: Date.now(),
    };
  } catch {
    // leave cache as-is on error
  } finally {
    refreshing = false;
    stopSpinner();
    updateFooter(pi, ctx);
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function updateFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
  ctx.ui.setFooter((_tui, theme, footerData) => ({
    invalidate() {},
    render(width: number): string[] {
      const lines: string[] = [];

      // ── Row 1: pwd + branch + session name + git status ──
      let pwd = ctx.sessionManager.getCwd();
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

      const branch = footerData.getGitBranch();
      if (branch) pwd = `${pwd} (${branch})`;

      const sessionName = ctx.sessionManager.getSessionName();
      if (sessionName) pwd = `${pwd} • ${sessionName}`;

      const left = theme.fg("dim", pwd);
      let right = "";
      if (cache?.snapshot.isRepo) {
        right = theme.fg("dim", renderFooter(cache.snapshot, refreshing, spinnerFrame));
      }

      if (right) {
        const rightWidth = visibleWidth(right);
        const maxLeftWidth = Math.max(1, width - rightWidth - 1);
        const leftTruncated = truncateToWidth(left, maxLeftWidth, theme.fg("dim", "..."));
        const leftWidth = visibleWidth(leftTruncated);
        const pad = " ".repeat(width - leftWidth - rightWidth);
        lines.push(leftTruncated + pad + right);
      } else {
        lines.push(truncateToWidth(left, width, theme.fg("dim", "...")));
      }

      // ── Row 2: usage stats + model info ──
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          const m = entry.message as import("@mariozechner/pi-ai").AssistantMessage;
          totalInput += m.usage?.input ?? 0;
          totalOutput += m.usage?.output ?? 0;
          totalCacheRead += m.usage?.cacheRead ?? 0;
          totalCacheWrite += m.usage?.cacheWrite ?? 0;
          totalCost += m.usage?.cost?.total ?? 0;
        }
      }

      const contextUsage = ctx.getContextUsage();
      const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
      const contextPercentValue = contextUsage?.percent ?? 0;
      const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

      const statsParts: string[] = [];
      if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
      if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
      if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
      if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

      const usingSubscription =
        ctx.model && ctx.modelRegistry && "isUsingOAuth" in ctx.modelRegistry
          ? (ctx.modelRegistry as any).isUsingOAuth(ctx.model)
          : false;
      if (totalCost || usingSubscription) {
        statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
      }

      const autoIndicator = " (auto)";
      const contextPercentDisplay =
        contextPercent === "?"
          ? `?/${formatTokens(contextWindow)}${autoIndicator}`
          : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

      let contextPercentStr: string;
      if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
      else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
      else contextPercentStr = contextPercentDisplay;

      statsParts.push(contextPercentStr);

      let statsLeft = statsParts.join(" ");
      let statsLeftWidth = visibleWidth(statsLeft);
      if (statsLeftWidth > width) {
        statsLeft = truncateToWidth(statsLeft, width, "...");
        statsLeftWidth = visibleWidth(statsLeft);
      }

      const model = ctx.model;
      const thinkingLevel = pi.getThinkingLevel();
      let rightSideWithoutProvider = model?.id || "no-model";
      if (model?.reasoning) {
        rightSideWithoutProvider =
          thinkingLevel === "off"
            ? `${model.id} • thinking off`
            : `${model.id} • ${thinkingLevel}`;
      }

      let rightSide = rightSideWithoutProvider;
      if (footerData.getAvailableProviderCount() > 1 && model) {
        rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
        if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
          rightSide = rightSideWithoutProvider;
        }
      }

      const rightSideWidth = visibleWidth(rightSide);
      const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
      let statsLine: string;
      if (totalNeeded <= width) {
        const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
        statsLine = statsLeft + padding + rightSide;
      } else {
        const availableForRight = width - statsLeftWidth - 2;
        if (availableForRight > 0) {
          const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
          const truncatedRightWidth = visibleWidth(truncatedRight);
          const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
          statsLine = statsLeft + padding + truncatedRight;
        } else {
          statsLine = statsLeft;
        }
      }

      const dimStatsLeft = theme.fg("dim", statsLeft);
      const remainder = statsLine.slice(statsLeft.length);
      const dimRemainder = theme.fg("dim", remainder);
      lines.push(dimStatsLeft + dimRemainder);

      // ── Extension status lines ──
      const extensionStatuses = footerData.getExtensionStatuses();
      if (extensionStatuses.size > 0) {
        const sortedStatuses = Array.from(extensionStatuses.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
        const statusLine = sortedStatuses.join(" ");
        lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
      }

      return lines;
    },
  }));
}

// ── Extension factory ──────────────────────────────────────────────────────

export default function piGitContext(pi: ExtensionAPI) {
  // Track tool mutations during an agent loop
  pi.on("tool_result", async (event) => {
    if (
      event.toolName === "write" ||
      event.toolName === "edit" ||
      event.toolName === "bash"
    ) {
      pendingToolMutation = true;
    }
  });

  // On agent end, kick off background refresh if files changed
  pi.on("agent_end", async (_event, ctx) => {
    if (pendingToolMutation) {
      pendingToolMutation = false;
      // Don't await — background refresh
      refreshCache(ctx.cwd, pi, ctx);
    }
  });

  // Session start: clear in-memory state, rebuild cache
  pi.on("session_start", async (_event, ctx) => {
    cache = null;
    lastPersistedSnapshot = null;
    pendingToolMutation = false;
    refreshing = false;
    stopSpinner();
    await refreshCache(ctx.cwd, pi, ctx);
  });

  // Rebuild footer on model changes so row 2 stays current
  pi.on("model_select", async (_event, ctx) => {
    updateFooter(pi, ctx);
  });

  // Before agent loop: inject persistent snapshot message if changed
  pi.on("before_agent_start", async (_event, ctx) => {
    const stale = !cache || Date.now() - cache.timestamp > CACHE_TTL_MS;
    if (stale) {
      await refreshCache(ctx.cwd, pi, ctx);
    }
    if (!cache) return {};

    const snap = renderSnapshot(cache.snapshot);
    if (snap !== lastPersistedSnapshot) {
      lastPersistedSnapshot = snap;
      return {
        message: {
          customType: CUSTOM_TYPE,
          content: snap,
          display: true,
          details: { summaryLine: summaryLine(cache.snapshot) },
        },
      };
    }
    return {};
  });

  // Context: ephemeral injection — strip all prior git snapshots, append fresh one
  pi.on("context", async (event, ctx) => {
    if (!cache) {
      await refreshCache(ctx.cwd, pi, ctx);
    }
    if (!cache) return {};

    const filtered = event.messages.filter((m) => {
      if (m.role !== "custom") return true;
      const cm = m as Extract<AgentMessage, { role: "custom" }>;
      return cm.customType !== CUSTOM_TYPE;
    });

    filtered.push({
      role: "custom",
      customType: CUSTOM_TYPE,
      content: renderSnapshot(cache.snapshot),
      display: false,
      details: { summaryLine: summaryLine(cache.snapshot) },
      timestamp: Date.now(),
    });

    return { messages: filtered };
  });

  // Custom message renderer (collapsible)
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const details = message.details as { summaryLine?: string } | undefined;
    const text = expanded ? full : (details?.summaryLine ?? full.split("\n")[0]);
    return new Text(theme.fg("dim", text), 0, 0);
  });

  // /git command — overlay preview of current snapshot
  pi.registerCommand("git", {
    description: "Show current git snapshot (read-only preview)",
    handler: async (_args, ctx) => {
      if (!cache || !cache.snapshot.isRepo) {
        ctx.ui.notify("Not in a git repository.", "info");
        return;
      }
      const snap = renderSnapshot(cache.snapshot);

      await ctx.ui.custom<string | null>(
        (_tui, _theme, _keybindings, done) => {
          const text = new Text(snap, 1, 1);
          const box = new Box(1, 1, (s) => _theme.bg("customMessageBg", s));
          box.addChild(text);

          const container: import("@mariozechner/pi-tui").Component = {
            render(width: number): string[] {
              return box.render(width);
            },
            handleInput(data: string) {
              // Escape or q closes
              if (data === "\x1b" || data === "q" || data === "Q") {
                done(null);
                return true;
              }
              return false;
            },
          };

          return container;
        },
      );
    },
  });
}
