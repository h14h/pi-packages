# pi-packages

A small collection of packages for [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), a coding agent that can be extended with tools, skills, prompts, and themes.

This repository is a home for experiments and utilities that make pi more useful in day-to-day coding work. Some packages are published to npm; others are local-only until they feel generally useful.

## Packages

Each package has its own README with installation instructions, status, and usage details:

- [`effect-mode`](./packages/effect-mode/README.md) — injects fresh, compact workspace state into every pi agent turn.
- [`pi-git-context`](./packages/pi-git-context/README.md) — adds concise git repository context to pi sessions.
- [`pi-model-performance`](./packages/pi-model-performance/README.md) — local extension for measuring model responsiveness in real use.

## How this repo is organized

Packages live under [`packages/`](./packages/). Each one is intended to be understandable and installable on its own, whether from a local checkout or from npm when published.

If you are just browsing, start with the package READMEs above. The root-level files are mostly workspace plumbing and maintainer notes.
