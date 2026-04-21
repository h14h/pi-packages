# Project Instructions

This repository is a workspace for standalone pi packages under `packages/`.

## Goals
- Keep each package independently installable and publishable.
- Prefer explicit `pi` manifests in each package's `package.json`.
- Use conventional resource directories inside each package: `extensions/`, `skills/`, `prompts/`, `themes/`.
- When creating a new package, use the generator script unless the user explicitly asks for a fully custom layout.

## Preferred Scaffold Tool Call

Treat the package generator as the default scaffold API for this repo.

### Command

```bash
npm run new:package -- --name <package-name> --types <csv> [--description <text>]
```

### Required args
- `--name <package-name>`
  - npm package name
  - can be unscoped like `my-pi-tools`
  - can be scoped like `@your-scope/pi-tools`

### Optional args
- `--types <csv>`
  - comma-separated list
  - allowed values: `extensions`, `skills`, `prompts`, `themes`
  - default: `extensions`
- `--description <text>`
  - defaults to `Personal pi package: <package-name>`

### Reliable invocation patterns

Extension package:

```bash
npm run new:package -- --name my-pi-tools --types extensions
```

Skill-only package:

```bash
npm run new:package -- --name my-pi-skills --types skills
```

Multi-resource package:

```bash
npm run new:package -- --name @your-scope/pi-toolbox --types extensions,skills,prompts --description "Personal pi toolbox"
```

### Contract / Expected effects
- Creates one workspace at `packages/<workspace-dir>`.
- Workspace dir is derived from package name by removing leading `@` and replacing `/` with `-`.
  - `my-pi-tools` -> `packages/my-pi-tools`
  - `@your-scope/pi-tools` -> `packages/your-scope-pi-tools`
- Fails if the target workspace directory already exists.
- Always writes a standalone `package.json` with:
  - `keywords` including `pi-package`
  - explicit `pi` manifest entries for requested resource types
  - `peerDependencies` on `@mariozechner/pi-coding-agent` and `@sinclair/typebox` when `extensions` is requested
  - `publishConfig.access = public` for scoped package names
- Writes a package `README.md`.
- Creates only the requested resource directories.
- For `extensions`, also creates:
  - `extensions/index.ts`
  - `tsconfig.json` extending the root `tsconfig.base.json`
- For `skills`, creates:
  - `skills/<slug>/SKILL.md`
- For `prompts`, creates:
  - `prompts/<slug>.md`
- For `themes`, creates:
  - `themes/<slug>.json`

## Agent Workflow
- Prefer scaffolding with the generator before manually creating package folders.
- After scaffolding, implement the requested package contents in that workspace.
- Keep packages self-contained and directly installable by pi from their package directory.
- Prefer small, focused packages over one giant catch-all package.
- Avoid adding unnecessary build steps unless the package actually needs compilation.
- For extension packages, keep pi libraries in `peerDependencies` with `"*"` ranges when imported.

## Useful Commands
- Create a package: `npm run new:package -- --name my-pi-package --types extensions`
- Pack all packages: `npm run pack:all`
- Pack one package: `npm pack --workspace <package-name>`
- List workspaces: `npm run list:packages`
