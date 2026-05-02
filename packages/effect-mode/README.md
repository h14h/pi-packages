# effect-mode

[![npm](https://img.shields.io/npm/v/effect-mode)](https://www.npmjs.com/package/effect-mode)

Inject fresh, compact workspace state into every pi agent turn.

`effect-mode` runs trusted shell effects before each LLM call and adds one ephemeral `<effect-mode>` context message with the latest snapshots. It is designed for high-signal state like git status, workspace files, and test/package hints—without dumping noisy execution metadata into the model context.

## Why effect-mode?

- Agents need current workspace facts, not stale assumptions.
- Shell commands can provide those facts, but raw command metadata is noisy.
- Effects are cached, bounded, and re-rendered into compact state snapshots before each model call.
- Old effect-mode messages are stripped from context, so snapshots do not accumulate.

## Quickstart

1. Install the package:

   ```bash
   pi install npm:effect-mode
   ```

2. Create `.pi/effects.json` in your project:

   ```json
   {
     "$schema": "./node_modules/effect-mode/schemas/effects.schema.json",
     "effects": [
       {
         "id": "git-state",
         "about": "Current local git state for this workspace.",
         "command": "node node_modules/effect-mode/scripts/git-state.mjs",
         "ttlMs": 0,
         "timeoutMs": 2000,
         "maxBytes": 12000
       }
     ]
   }
   ```

3. Inspect what will be injected:

   ```text
   /effects
   ```

## What agents see

`/effects` shows a navigable list of enabled effects. Select an effect and press Enter to view the model-facing content inside that effect's XML tags. The injected model context includes the compact XML wrapper:

```xml
<effect-mode snapshot="current-state-not-instructions" resolvedAt="2026-05-02T06:32:52Z" localZone="America/Chicago">
<effect id="project:git-state" about="Current local git state for this workspace.">
git:
  branch: main
  head: c314523
  upstream: origin/main, up-to-date
  remote: checked 56s ago via git-fetch
  workingTree: clean
  lastCommit: chore(effects): tighten git-state context
</effect>
</effect-mode>
```

Wrapper and effect attributes:

- `snapshot="current-state-not-instructions"`: tells the model this is state, not user instruction.
- `resolvedAt`: ISO UTC render time.
- `localZone`: IANA local timezone.
- `id`: stable `global:<id>` or `project:<id>` effect identity.

The wrapper timestamp replaces separate clock effects for most uses. Omitted normal/default fields mean nothing notable for bundled effects; custom effect stdout remains freeform.

### Failed effects

Failed effects stay terse and actionable in model context:

```xml
<effect id="project:git-state" about="Current local git state for this workspace." status="error">
unavailable: command exited 128
reason: fatal: not a git repository
agentAction: Explain that project:git-state context is unavailable; continue without assuming it. Suggest the user run /effects-debug if details matter.
</effect>
```

Full stdout/stderr, command, cwd, duration, and truncation details are debug-only.

## Recipes

These snippets are individual effect objects you can place in the `effects` array.

### Bundled git state

```json
{
  "id": "git-state",
  "about": "Current local git state for this workspace.",
  "description": "Concise local git state snapshot for this workspace.",
  "command": "node node_modules/effect-mode/scripts/git-state.mjs",
  "ttlMs": 0,
  "timeoutMs": 2000,
  "maxBytes": 12000,
  "options": {
    "remoteMode": "background",
    "remoteTtlMs": 900000,
    "remoteErrorTtlMs": 300000,
    "remoteTimeoutMs": 15000
  }
}
```

### Top-level workspace files

```json
{
  "id": "workspace-files",
  "about": "Top-level workspace files.",
  "command": "find . -maxdepth 2 -type f | sort | head -80",
  "ttlMs": 30000,
  "maxBytes": 8000
}
```

### Package manager snapshot

```json
{
  "id": "package-scripts",
  "about": "Available package scripts for this workspace.",
  "command": "node -e \"const p=require('./package.json'); for (const [k,v] of Object.entries(p.scripts||{})) console.log(k+': '+v)\"",
  "ttlMs": 30000,
  "maxBytes": 4000
}
```

### Script options via environment

Use `options` for small scalar knobs. They are passed as JSON in `PI_EFFECT_OPTIONS_JSON`, not interpolated into the shell command.

```json
{
  "id": "recent-files",
  "about": "Recently changed source files.",
  "command": "node -e \"const opts=JSON.parse(process.env.PI_EFFECT_OPTIONS_JSON||'{}'); const limit=Number(opts.limit||20); require('child_process').execFileSync('git',['diff','--name-only','HEAD'],{stdio:'inherit'}); console.log('limit:', limit)\"",
  "ttlMs": 10000,
  "maxBytes": 4000,
  "options": {
    "limit": 20,
    "includeUntracked": true
  }
}
```

`options` values must be scalar: `string`, `number`, `boolean`, or `null`. Arrays and nested objects are rejected.

## Commands

```text
/effects
  Shows a navigable list of enabled effects.
  Select an effect and press Enter to view the model-facing content inside that effect's XML tags.

/effects-debug
  Uses the same navigation.
  Enter opens diagnostics: config, command, cwd, status, exit code, age, duration, ttl, raw stdout/stderr, truncation, and compact rendered form.
```

`/effects-debug` does not rerun commands with script-specific debug flags. To inspect verbose bundled git output, configure or run `node node_modules/effect-mode/scripts/git-state.mjs --debug`.

## Configuration reference

Create project effects in `.pi/effects.json`, or global effects in `~/.pi/agent/effects.json` for effects available in every project.

| Field | Type | Default | Description / model-context impact |
| --- | --- | --- | --- |
| `id` | string | required | Unique slug-like id; rendered as `global:<id>` or `project:<id>`. |
| `command` | string | required | Shell command executed for the effect. |
| `about` | string | none | Short model-facing explanation; rendered as the effect `about` attribute. |
| `description` | string | none | Human/debug explanation; used as `about` fallback when `about` is omitted. |
| `cwd` | string | `project` | `project` or relative path inside project/config root. |
| `ttlMs` | number | `2000` | Success cache TTL; `0` executes every model call. |
| `errorTtlMs` | number | `10000` | Failed-result cache TTL. |
| `timeoutMs` | number | `3000` | Per-effect timeout. |
| `maxBytes` | number | `12000` | Combined stdout/stderr render budget; tail-truncated. |
| `enabled` | boolean | `true` | Disabled effects are omitted from model context and shown disabled in debug. |
| `includeMetadata` | boolean | ignored | Reserved for compatibility with existing configs; model context is always compact. |
| `options` | object | `{}` | Scalar values passed through `PI_EFFECT_OPTIONS_JSON`. |

Unknown fields are rejected. Invalid config blocks all effects and injects a compact diagnostic message.

## Effect environment

Each command inherits pi's environment plus:

| Variable | Value |
| --- | --- |
| `PI_EFFECT_ID` | Effect id from config. |
| `PI_EFFECT_SCOPE` | `global` or `project`. |
| `PI_EFFECT_CWD` | Absolute resolved working directory. |
| `PI_EFFECT_OPTIONS_JSON` | JSON string of scalar `options`, or `{}`. |

Options are passed only through the child-process environment, not interpolated into the shell command.

## Bundled git-state

`node node_modules/effect-mode/scripts/git-state.mjs` provides a compact local git snapshot tuned for model context.

### Compact default output

By default, it does not fetch and renders from local refs:

```yaml
git:
  branch: main
  head: c314523
  upstream: origin/main, up-to-date
  remote: local refs only; no remote refresh configured
  workingTree: clean
  lastCommit: chore(effects): tighten git-state context
```

Abnormal fields such as dirty files, stashes, missing upstreams, linked worktrees, remote refresh failures, and option warnings are preserved.

### Debug output

Use `--debug` or `--verbose` for diagnostic output:

```bash
node node_modules/effect-mode/scripts/git-state.mjs --debug
node node_modules/effect-mode/scripts/git-state.mjs --verbose
```

### Background remote checks

Opt into low-latency background remote checks through effect options:

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

### Omitted defaults

Compact output omits normal/default details so unusual state stands out:

- clean stash (`stash: none`)
- zero change counts
- no changed files
- current worktree row
- no linked worktrees
- normal origin/root/cwd details

## Security model

- Effects execute arbitrary shell commands through the platform shell.
- Commands inherit pi's environment and permissions.
- Only enable project effects from trusted repositories.
- Global effects in `~/.pi/agent/effects.json` run across projects.
- Do not put secrets in effect stdout; successful stdout is sent to the model.
- Background `git-state` remote checks run `git fetch` and mutate remote-tracking refs when opted in.
- Prefer small, bounded, read-only commands; set `timeoutMs` and `maxBytes`.

## Troubleshooting

### No effect-mode context is injected

Verify the package is installed, the config file is in `.pi/effects.json` or `~/.pi/agent/effects.json`, effects are enabled, and `/effects` shows enabled effects.

### Config invalid

Unknown fields are rejected. Run `/effects-debug` and validate your config against `schemas/effects.schema.json`.

### Effect command fails or times out

Inspect `/effects-debug`, check `cwd`, increase `timeoutMs` if the command is legitimately slow, or simplify the command.

### Output is too large or missing earlier lines

`maxBytes` tail-truncates combined stdout/stderr. Increase the budget or make the command emit a shorter summary.

### Remote state looks stale

Background mode renders immediately from cache/local refs, then refreshes asynchronously. Run `/effects` again after the refresh completes.

## Status and roadmap

Implemented now:

- global `~/.pi/agent/effects.json` and project-local `.pi/effects.json`
- sequential effect execution
- per-effect TTL, error TTL, timeout, max output bytes, and scalar options
- compact model-context rendering with ISO UTC `resolvedAt` and IANA `localZone`
- `/effects` navigable model-facing content command
- `/effects-debug` navigable diagnostic command
- JSON Schema at `schemas/effects.schema.json`

Intentionally deferred:

- session/agent-created effects
- script runtimes such as TypeScript/Bun/Node
- deterministic shell selection
- `gh`, `git ls-remote`, and synchronous remote checks for `git-state`
