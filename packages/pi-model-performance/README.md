# pi-model-performance

> **Local package** — not published to npm. Install via local path or git source.

A pi extension package for measuring model responsiveness in real use.

It tracks, per assistant turn:

- **latency**: milliseconds to first assistant stream activity of any kind
- **reasoning**: milliseconds from first assistant activity to first output text token
- **response**: output tokens per second after first output text token
- **end-to-end TPS**: output tokens per second across the full turn
- **output tokens**

## Install from this monorepo

```bash
pi install ./packages/pi-model-performance
```

## What it does

After installation, the extension replaces the footer with a compact, dim readout. Example:

```text
↑12.4k ↓3.1k $0.084                            180ms • 94.3 t/s • (openai) gpt-5.4 • medium
```

It also keeps a small session-local history of samples for summary commands.

## Commands

### `/perf-last`
Show the most recent latency/reasoning/response sample.

### `/perf-summary [count]`
Show averages over the most recent assistant turns.

Examples:

```text
/perf-summary
/perf-summary 25
```

### `/perf-reset`
Clear in-memory samples for the current runtime.

### `/perf-debug`
Toggle debug notifications showing timing milestones like provider request start, stream start, first text delta, and message end.

## Notes

- Latency is measured from `before_provider_request` to the first assistant stream event.
- Reasoning is measured from the first assistant stream event to the first streamed `text_delta` event.
- If no streamed text output is observed, reasoning and response are shown as `—` instead of falling back to end-to-end latency.
- Response uses `assistant.usage.output` tokens divided by stream duration after first output token.
- Tool-heavy sessions may produce multiple assistant turns for a single user request; each assistant turn is measured separately.
