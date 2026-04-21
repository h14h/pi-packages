# pi-packages

A lightweight npm workspaces monorepo for personal [pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) packages.

## What this repo is for

- creating standalone pi packages with minimal ceremony
- keeping each package installable directly from its own folder
- leaving the door open to publish useful packages to npm later

Each package lives in `packages/<name>/` and should be usable on its own via:

```bash
pi install ./packages/<name>
```

Or, after publishing:

```bash
pi install npm:<package-name>
```

## Workspace layout

```text
.
├── AGENTS.md
├── package.json
├── packages/
├── scripts/
└── tsconfig.base.json
```

## Create a new package

Use the scaffold script:

```bash
npm run new:package -- --name my-pi-package --types extensions
```

You can scaffold one or more pi resource types at once:

```bash
npm run new:package -- --name my-pi-toolbox --types extensions,skills,prompts
```

Supported types:

- `extensions`
- `skills`
- `prompts`
- `themes`

### Examples

```bash
npm run new:package -- --name @your-scope/pi-git-tools --types extensions
npm run new:package -- --name my-pi-writing-kit --types prompts,skills
npm run new:package -- --name my-pi-theme-pack --types themes
```

## Working with packages

List workspaces:

```bash
npm run list:packages
```

Pack every package into npm tarballs:

```bash
npm run pack:all
```

Pack one package:

```bash
npm pack --workspace <package-name>
```

## Publishing later

When a package feels reusable, publish just that workspace:

```bash
npm publish --workspace <package-name> --access public
```

If you want to test the exact tarball first:

```bash
npm pack --workspace <package-name>
pi install ./<generated-tarball>.tgz
```

## Notes for pi packages

Per pi package docs:

- add the `pi-package` keyword for discoverability
- declare resources in `package.json` under `pi`
- keep third-party runtime libraries in `dependencies`
- if an extension imports pi packages like `@mariozechner/pi-coding-agent` or `@sinclair/typebox`, use `peerDependencies` with `"*"`

## Recommended flow with agents

1. Ask an agent to scaffold a package with `npm run new:package ...`
2. Have it implement the package inside that workspace
3. Test locally with `pi install ./packages/<name>`
4. If it proves useful, `npm pack` or `npm publish` that workspace
