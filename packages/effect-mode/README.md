# effect-mode

> **Local package** — not published to npm. Install via local path or git source.

Dynamic context resolver effects for pi.

`effect-mode` reads project-local `.pi/effects.json`, executes enabled shell effects before each LLM call when their cache is stale, and appends one ephemeral `<effect-mode>` context message containing current snapshots. Old effect-mode messages are stripped from context, so stale outputs do not accumulate in conversation history.

## Install locally

```bash
pi install /absolute/path/to/packages/effect-mode
```

From this monorepo:

```bash
pi install ./packages/effect-mode
```

## Configure

Create `.pi/effects.json` in a project:

```json
{
  "$schema": "./node_modules/effect-mode/schemas/effects.schema.json",
  "effects": [
    {
      "id": "git-status",
      "description": "Current git branch and working tree status",
      "command": "git status --short --branch"
    }
  ]
}
```

See `examples/effects.json` for a larger example.

## Effect fields

- `id` required, unique, slug-like.
- `command` required shell command.
- `description` optional.
- `cwd` optional, defaults to `project`; may be `project` or a relative path inside the project root.
- `ttlMs` optional, default `2000`; `0` executes on every LLM call.
- `errorTtlMs` optional, default `10000`.
- `timeoutMs` optional, default `3000`.
- `maxBytes` optional, default `12000`; combined stdout/stderr budget, tail-truncated.
- `enabled` optional, default `true`.
- `options` optional object for script-specific settings. Values must be scalar (`string`, `number`, `boolean`, or `null`); arrays and nested objects are rejected.

Unknown fields are rejected. Invalid config blocks all effects and injects a diagnostic message.

## Effect environment

Each command inherits pi's environment plus:

- `PI_EFFECT_ID` effect id.
- `PI_EFFECT_SCOPE=project`.
- `PI_EFFECT_CWD` absolute resolved working directory.
- `PI_EFFECT_OPTIONS_JSON` JSON string of the effect `options` object, or `{}`.

Options are passed only through the child-process environment, not interpolated into the shell command.

## Bundled `git-state` script

`node packages/effect-mode/scripts/git-state.mjs` prints concise local git state. By default it does not fetch:

```text
remoteTracking: local refs; not freshly fetched by git-state
remoteCheck: off
```

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

## Command

Use `/effects` to inspect effects. It refreshes stale effects using the same TTL rules, shows a compact status list, and supports opening selected output with `Ctrl+O` or Enter.

## Security

Effects execute arbitrary shell commands through the platform shell with pi's inherited environment and permissions. Only enable effects from projects you trust.

## v0 scope

Implemented now:

- project-local `.pi/effects.json`
- sequential effect execution
- per-effect TTL, error TTL, timeout, max output bytes, scalar options
- one appended ephemeral model-context message
- `/effects` inspection command
- JSON Schema at `schemas/effects.schema.json`

Intentionally deferred:

- global user effects
- session/agent-created effects
- script runtimes such as TypeScript/Bun/Node
- deterministic shell selection
- `gh`, `git ls-remote`, and synchronous remote checks for `git-state`
