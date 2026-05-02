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

Unknown fields are rejected. Invalid config blocks all effects and injects a diagnostic message.

## Command

Use `/effects` to inspect effects. It refreshes stale effects using the same TTL rules, shows a compact status list, and supports opening selected output with `Ctrl+O` or Enter.

## Security

Effects execute arbitrary shell commands through the platform shell with pi's inherited environment and permissions. Only enable effects from projects you trust.

## v0 scope

Implemented now:

- project-local `.pi/effects.json`
- sequential effect execution
- per-effect TTL, error TTL, timeout, max output bytes
- one appended ephemeral model-context message
- `/effects` inspection command
- JSON Schema at `schemas/effects.schema.json`

Intentionally deferred:

- global user effects
- session/agent-created effects
- script runtimes such as TypeScript/Bun/Node
- deterministic shell selection
