# pi-git-context

[![npm](https://img.shields.io/npm/v/pi-git-context)](https://www.npmjs.com/package/pi-git-context)

Opinionated git state context injection for [pi](https://github.com/badlogic/pi-mono).

## What it does

Injects a concise, current git snapshot into the LLM context on **every prompt**, while keeping the session history clean by only persisting snapshots when state actually changes.

### Snapshot contents

| Section | Condition | Example |
|---------|-----------|---------|
| Remote | If remote exists | `Remote: github.com/h14h/pi-packages` |
| Default branch | If determinable, and not current branch | `Default branch (main, a1b2c3d): synced with origin` |
| Current branch / HEAD | Always in repo | `Branch: feat/auth-refactor (b2c3d4e), +3 commits from main, ahead 1 / behind 0` |
| PR status | If `gh` CLI available and branch has PR | `PR: #42 (Ready)` |
| Worktrees | If linked worktrees exist | `Linked worktrees: 6 total` |
| Working tree | Always | `Working tree: dirty (2M, 1S, 1U, 0D)` |
| Primary worktree | If CWD is a linked worktree | `Primary worktree (main, a1b2c3d): synced with origin, clean` |

Abbreviations: **M** = modified, **S** = staged, **U** = untracked, **D** = deleted.

## Footer status

A persistent footer segment shows:

```
◈ ● (a1b2c3d) ✓
```

- `◈` = linked worktree (`·` = primary worktree, fixed-width)
- `●` = clean / `◐` = dirty / `✖` = conflicted
- `(a1b2c3d)` = short SHA
- `✓` = snapshot up to date / `?` = warning / Braille spinner = refreshing

## Commands

| Command | Description |
|---------|-------------|
| `/git` | Open a read-only overlay showing the exact snapshot the agent will see on the next turn |

## How it works

- **Before each agent loop**: computes snapshot. If it changed from the last persisted snapshot, a new `custom_message` entry is appended to the session (visible in TUI, collapsible).
- **Before every LLM call**: the `context` handler strips all prior git snapshots and injects exactly one fresh, ephemeral snapshot. The LLM never sees stale state.
- **After each agent turn**: if `write`, `edit`, or `bash` tools ran, an optimistic background refresh is kicked off so the next prompt sees current state.
- **Cache**: a quick fingerprint (branch + SHA + worktree path + dirty count) avoids recomputing the full snapshot when nothing changed.

## Install

```bash
pi install ./packages/pi-git-context
```

Or from npm (once published):

```bash
pi install pi-git-context
```
