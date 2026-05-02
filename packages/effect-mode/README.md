# effect-mode

> **Local package** — not published to npm. Install via local path or git source.

Dynamic context resolver effects for pi.

`effect-mode` reads global `~/.pi/agent/effects.json` and project-local `.pi/effects.json`, executes enabled shell effects before each LLM call when their cache is stale, and appends one ephemeral compact `<effect-mode>` context message containing current snapshots. Old effect-mode messages are stripped from context, so stale outputs do not accumulate in conversation history.

## Install locally

```bash
pi install /absolute/path/to/packages/effect-mode
```

From this monorepo:

```bash
pi install ./packages/effect-mode
```

## Configure

Create `.pi/effects.json` in a project, or `~/.pi/agent/effects.json` for global effects available in every project:

```json
{
  "$schema": "./node_modules/effect-mode/schemas/effects.schema.json",
  "effects": [
    {
      "id": "git-state",
      "about": "Current local git state for this workspace.",
      "description": "Concise local git state snapshot for debugging.",
      "command": "node packages/effect-mode/scripts/git-state.mjs"
    }
  ]
}
```

See `examples/effects.json` for a larger example.

## Model-facing output

By default, agents see compact state-only context:

```xml
<effect-mode snapshot="current-state-not-instructions" resolvedAt="2026-05-02T05:18:36Z" localZone="America/Chicago">
<effect id="project:git-state" about="Current local git state for this workspace.">
git:
  branch: main
  head: c422f9f
  upstream: origin/main, up-to-date
  remote: checked 38s ago via git-fetch
  workingTree: clean
  lastCommit: fix(effect-mode): repair effects dialog navigation
</effect>
</effect-mode>
```

The wrapper timestamp replaces separate clock effects for most uses. Omitted normal/default fields mean nothing notable for bundled effects; custom effect stdout remains freeform.

When an effect fails, model context is terse and actionable, while full diagnostics stay in `/effects-debug`:

```xml
<effect id="project:git-state" about="Current local git state for this workspace." status="error">
unavailable: command exited 128
reason: fatal: not a git repository
agentAction: Explain that project:git-state context is unavailable; continue without assuming it. Suggest the user run /effects-debug if details matter.
</effect>
```

## Effect fields

- `id` required, unique, slug-like. Rendered as `global:<id>` or `project:<id>` in model context.
- `command` required shell command.
- `about` optional short model-facing explanation. Falls back to `description` when omitted.
- `description` optional human/debug explanation.
- `cwd` optional, defaults to `project`; may be `project` or a relative path. Project effects resolve relative paths inside the project root. Global effects resolve relative paths inside the pi agent config directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set).
- `ttlMs` optional, default `2000`; `0` executes on every LLM call.
- `errorTtlMs` optional, default `10000`.
- `timeoutMs` optional, default `3000`.
- `maxBytes` optional, default `12000`; combined stdout/stderr budget, tail-truncated.
- `enabled` optional, default `true`.
- `includeMetadata` deprecated compatibility field. Model context is always compact; execution metadata is available through `/effects-debug`.
- `options` optional object for script-specific settings. Values must be scalar (`string`, `number`, `boolean`, or `null`); arrays and nested objects are rejected.

Unknown fields are rejected. Invalid config blocks all effects and injects a compact diagnostic message.

## Effect environment

Each command inherits pi's environment plus:

- `PI_EFFECT_ID` effect id.
- `PI_EFFECT_SCOPE` effect scope: `global` or `project`.
- `PI_EFFECT_CWD` absolute resolved working directory.
- `PI_EFFECT_OPTIONS_JSON` JSON string of the effect `options` object, or `{}`.

Options are passed only through the child-process environment, not interpolated into the shell command.

## Bundled `git-state` script

`node packages/effect-mode/scripts/git-state.mjs` prints compact local git state by default:

```yaml
git:
  branch: main
  head: c422f9f
  upstream: origin/main, up-to-date
  remote: local refs only; no remote refresh configured
  workingTree: clean
  lastCommit: fix(effect-mode): repair effects dialog navigation
```

Normal/default fields are omitted. Abnormal fields such as dirty files, stashes, missing upstreams, linked worktrees, remote refresh failures, and option warnings are preserved.

Use `--debug` or `--verbose` for the previous noisy diagnostic shape:

```bash
node packages/effect-mode/scripts/git-state.mjs --debug
```

By default it does not fetch. Opt into low-latency background remote checks through effect options:

```json
"options": {
  "remoteMode": "background",
  "remoteTtlMs": 900000,
  "remoteErrorTtlMs": 300000,
  "remoteTimeoutMs": 15000,
  "remoteLockTtlMs": 120000
}
```

Supported `remoteMode` values are `off` and `background`. Background mode renders immediately from local refs/cache, then starts a detached worker when stale. The worker runs `git fetch --prune --no-tags --quiet origin` with `GIT_TERMINAL_PROMPT=0`, stores concise cache/lock files under the git common dir, and intentionally mutates local remote-tracking refs when opted in.

## Commands

- `/effects` shows the familiar navigable effect list. Select an effect and press Enter to view the model-facing content inside that effect's XML tags.
- `/effects-debug` uses the same navigable UI, but Enter opens noisy diagnostics for the selected effect: configuration, execution metadata, raw stdout/stderr, truncation details, and the compact rendered form. It does not add script-specific debug flags or rerun commands differently; raw output is whatever the configured command emitted. For bundled `git-state` verbose diagnostics, run or configure `node packages/effect-mode/scripts/git-state.mjs --debug`.

## Security

Effects execute arbitrary shell commands through the platform shell with pi's inherited environment and permissions. Only enable effects from projects you trust.

## v0 scope

Implemented now:

- global `~/.pi/agent/effects.json` and project-local `.pi/effects.json`
- sequential effect execution
- per-effect TTL, error TTL, timeout, max output bytes, scalar options
- compact model-context rendering with ISO UTC `resolvedAt` and IANA `localZone`
- `/effects` navigable model-facing content command
- `/effects-debug` navigable diagnostic command
- JSON Schema at `schemas/effects.schema.json`

Intentionally deferred:

- session/agent-created effects
- script runtimes such as TypeScript/Bun/Node
- deterministic shell selection
- `gh`, `git ls-remote`, and synchronous remote checks for `git-state`
