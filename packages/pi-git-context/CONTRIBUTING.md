# Contributing to pi-git-context

## Version bumps

Follow semver as defined in the root `AGENTS.md`:

| Bump | Examples |
|------|----------|
| `patch` | Bug fixes, docs fixes, footer tweaks, stale-git whitelist additions, test additions |
| `minor` | New snapshot fields, new commands, new footer indicators |
| `major` | Breaking snapshot format changes, removed features |

## Publishing

```bash
cd packages/pi-git-context
npm version patch   # or minor / major
npm publish --access public --otp=<code>
```

The package is published to npm under `pi-git-context`.

## Testing

```bash
cd packages/pi-git-context
bun test extensions/__tests__/utils.test.ts
```

All 35 tests must pass before publish.

## Snapshot format changes

If you change what the snapshot contains or how it's formatted:
1. Update `renderSnapshot()` in `utils.ts`
2. Update the README table and examples
3. Update `renderFooter()` if footer glyphs change
4. Add/update tests for new permutations
5. Bump **minor** (new field) or **major** (breaking format change)

## Adding stale-git commands

To add a new command to the stale-git whitelist:
1. Add regex to `STALE_GIT_PATTERNS` in `utils.ts`
2. Add test case in `__tests__/utils.test.ts`
3. Update the stale command list in this README
4. Bump **patch**
