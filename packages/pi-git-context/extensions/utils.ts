// Pure utilities and types for pi-git-context.
// No pi API dependencies — fully unit-testable.

export const CUSTOM_TYPE = "pi-git-context:snapshot";
export const STATUS_KEY = "git-context";
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const CACHE_TTL_MS = 30000;

// ── Types ───────────────────────────────────────────────────────────────────

export type DirtyCounts = {
  modified: number;
  staged: number;
  untracked: number;
  deleted: number;
};

export type BranchInfo = {
  name: string;
  sha: string;
  rootDistance?: string;
  remoteStatus?: string;
};

export type WorktreeInfo = {
  path: string;
  isLinked: boolean;
  primaryPath?: string;
  linkedCount: number;
  linkedGroups: { parent: string; count: number }[];
};

export type GitSnapshot =
  | { isRepo: false }
  | {
      isRepo: true;
      remote?: { provider: string; path: string };
      defaultBranch?: BranchInfo;
      current: BranchInfo | { sha: string; detached: true };
      pr?: { number: number; state: "Draft" | "Ready" };
      worktree: WorktreeInfo;
      workingTree: DirtyCounts;
      primaryWorktree?: DirtyCounts & {
        branchName: string;
        sha: string;
        remoteStatus?: string;
      };
      warning?: string;
    };

export type Cache = {
  snapshot: GitSnapshot;
  fingerprint: string;
  dirty: boolean;
  timestamp: number;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function dirtyChar(d: DirtyCounts): string {
  const total = d.modified + d.staged + d.untracked + d.deleted;
  if (total === 0) return "●";
  if (d.modified > 0 || d.staged > 0 || d.untracked > 0 || d.deleted > 0) return "◐";
  return "●";
}

export function dirtyText(d: DirtyCounts): string {
  return `${d.modified}M, ${d.staged}S, ${d.untracked}U, ${d.deleted}D`;
}

export function parseRemoteUrl(
  url: string,
): { provider: string; path: string } | undefined {
  // ssh: git@github.com:h14h/pi-packages.git
  const sshMatch = url.match(/git@([^:]+):(.+)/);
  if (sshMatch)
    return {
      provider: sshMatch[1],
      path: sshMatch[2].replace(/\.git$/, ""),
    };

  // https: https://github.com/h14h/pi-packages.git
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return { provider: u.hostname, path };
  } catch {
    return undefined;
  }
}

export function computeFingerprint(snap: GitSnapshot): string {
  if (!snap.isRepo) return "no-repo";
  const branch = "name" in snap.current ? snap.current.name : "detached";
  const dirty =
    snap.workingTree.modified +
    snap.workingTree.staged +
    snap.workingTree.untracked +
    snap.workingTree.deleted;
  return `${branch}:${snap.current.sha}:${snap.worktree.path}:${dirty}`;
}

// ── Snapshot renderer ───────────────────────────────────────────────────────

export function renderSnapshot(snap: GitSnapshot): string {
  if (!snap.isRepo) return "[Git State]\nNot in a git repository.";

  const lines: string[] = ["[Git State]"];
  if (snap.warning) lines.push(snap.warning);
  if (snap.remote) lines.push(`Remote: ${snap.remote.provider}/${snap.remote.path}`);

  if (snap.defaultBranch) {
    const db = snap.defaultBranch;
    const isCurrent = "name" in snap.current && snap.current.name === db.name;
    if (!isCurrent) {
      lines.push(
        `Default branch (${db.name}, ${db.sha}): ${db.remoteStatus ?? "local only"}`,
      );
    }
  }

  if ("detached" in snap.current) {
    lines.push(`Detached HEAD (${snap.current.sha})`);
  } else {
    const cur = snap.current;
    let line = `Branch: ${cur.name} (${cur.sha})`;
    if (cur.rootDistance) line += `, ${cur.rootDistance}`;
    if (cur.remoteStatus) line += `, ${cur.remoteStatus}`;
    lines.push(line);
  }

  if (snap.pr) lines.push(`PR: #${snap.pr.number} (${snap.pr.state})`);

  if (snap.worktree.linkedCount > 0) {
    const wt = snap.worktree;
    lines.push(`Current worktree: ${wt.path}${wt.isLinked ? " (linked)" : ""}`);
    if (wt.isLinked && wt.primaryPath) {
      lines.push(`Primary worktree: ${wt.primaryPath}`);
    }
    lines.push(`Linked worktrees: ${wt.linkedCount} total`);
    for (const g of wt.linkedGroups) {
      lines.push(`  (${g.count}) ${g.parent}`);
    }
  }

  const wt = snap.workingTree;
  const total = wt.modified + wt.staged + wt.untracked + wt.deleted;
  if (total === 0) {
    lines.push("Working tree: clean");
  } else {
    lines.push(`Working tree: dirty (${dirtyText(wt)})`);
  }

  if (snap.primaryWorktree) {
    const pw = snap.primaryWorktree;
    const pTotal = pw.modified + pw.staged + pw.untracked + pw.deleted;
    if (pTotal === 0) {
      lines.push(
        `Primary worktree (${pw.branchName}, ${pw.sha}): ${pw.remoteStatus ?? "local only"}, clean`,
      );
    } else {
      lines.push(
        `Primary worktree (${pw.branchName}, ${pw.sha}): ${pw.remoteStatus ?? "local only"}, dirty (${dirtyText(pw)})`,
      );
    }
  }

  return lines.join("\n");
}

export function summaryLine(snap: GitSnapshot): string {
  if (!snap.isRepo) return "[Git State] Not in a git repository";
  const sha = "sha" in snap.current ? snap.current.sha : "";
  const branch = "name" in snap.current ? snap.current.name : "detached";
  return `[Git State] ${branch} (${sha}) ${dirtyChar(snap.workingTree)}`;
}

// ── Footer ─────────────────────────────────────────────────────────────────

export function renderFooter(snap: GitSnapshot, refreshing: boolean, spinnerFrame: number): string {
  if (!snap.isRepo) return "";
  const wtPrefix = snap.worktree.isLinked ? "◈ " : "· ";
  const d = dirtyChar(snap.workingTree);
  const sha = "sha" in snap.current ? snap.current.sha : "";
  const async = refreshing ? SPINNER[spinnerFrame] : snap.warning ? "?" : "✓";
  return `${wtPrefix}${d} (${sha}) ${async}`;
}
