#!/usr/bin/env node
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const allowedTypes = ["extensions", "skills", "prompts", "themes"];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function workspaceDirFromPackageName(packageName) {
  return packageName.replace(/^@/, "").replace(/\//g, "-");
}

function parseTypes(value) {
  const raw = String(value || "extensions")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const unique = [...new Set(raw)];
  const invalid = unique.filter((type) => !allowedTypes.includes(type));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid --types value: ${invalid.join(", ")}. Allowed: ${allowedTypes.join(", ")}`,
    );
  }
  return unique;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildPiManifest(types) {
  const pi = {};
  if (types.includes("extensions")) pi.extensions = ["./extensions"];
  if (types.includes("skills")) pi.skills = ["./skills"];
  if (types.includes("prompts")) pi.prompts = ["./prompts"];
  if (types.includes("themes")) pi.themes = ["./themes"];
  return pi;
}

function buildPackageJson({ packageName, description, types }) {
  const packageJson = {
    name: packageName,
    version: "0.1.0",
    private: false,
    description,
    keywords: ["pi-package", ...types.map((type) => `pi-${type.slice(0, -1)}`)],
    license: "MIT",
    files: [],
    pi: buildPiManifest(types),
  };

  if (types.includes("extensions")) {
    packageJson.peerDependencies = {
      "@mariozechner/pi-coding-agent": "*",
      "@sinclair/typebox": "*",
    };
  }

  if (packageName.startsWith("@")) {
    packageJson.publishConfig = { access: "public" };
  }

  if (types.includes("extensions")) packageJson.files.push("extensions", "tsconfig.json");
  if (types.includes("skills")) packageJson.files.push("skills");
  if (types.includes("prompts")) packageJson.files.push("prompts");
  if (types.includes("themes")) packageJson.files.push("themes");
  packageJson.files.push("README.md", "package.json");

  return packageJson;
}

function extensionTemplate(packageName) {
  return `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function ${camelName(packageName)}(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hello_${safeToolName(packageName)}",
    label: "Hello",
    description: "Example tool shipped by ${packageName}",
    promptSnippet: "Return a friendly greeting from this package.",
    parameters: Type.Object({
      name: Type.String({ description: "Who to greet" }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Hello, " + params.name + "!" }],
        details: {},
      };
    },
  });
}
`;
}

function camelName(packageName) {
  const flat = workspaceDirFromPackageName(packageName);
  return flat
    .split("-")
    .filter(Boolean)
    .map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1))
    .join("") || "piPackage";
}

function safeToolName(packageName) {
  return workspaceDirFromPackageName(packageName).replace(/[^a-zA-Z0-9_]+/g, "_");
}

function skillTemplate(packageName) {
  return `# ${packageName} Skill

Use this skill when the user asks for behavior provided by ${packageName}.

## Steps
1. Understand the user's goal.
2. Apply the package-specific workflow.
3. Return a concise result and note any follow-up actions.
`;
}

function promptTemplate(packageName) {
  return `Help with ${packageName}.

Goal: {{goal}}
Constraints: {{constraints}}

Return a practical result with clear next steps.
`;
}

function themeTemplate() {
  return JSON.stringify(
    {
      name: "Example Theme",
      colors: {
        background: "#0b1020",
        foreground: "#dbe4ff",
        primary: "#8b5cf6",
        secondary: "#22c55e",
        muted: "#94a3b8",
        error: "#ef4444",
        warning: "#f59e0b",
        success: "#10b981",
      },
    },
    null,
    2,
  ) + "\n";
}

function packageReadme({ packageName, types }) {
  return `# ${packageName}

Standalone pi package generated from the workspace monorepo.

## Included resources

${types.map((type) => `- ${type}`).join("\n")}

## Install locally

\`\`\`bash
pi install /absolute/path/to/this/package
\`\`\`

## Install from this monorepo

\`\`\`bash
pi install ./packages/${workspaceDirFromPackageName(packageName)}
\`\`\`

## Publish later

\`\`\`bash
npm publish --access public
\`\`\`
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageName = args.name;

  if (!packageName) {
    console.error("Usage: npm run new:package -- --name <package-name> --types extensions,skills,prompts,themes");
    process.exit(1);
  }

  const types = parseTypes(args.types);
  const description = args.description || `Personal pi package: ${packageName}`;
  const workspaceDir = workspaceDirFromPackageName(packageName);
  const rootDir = process.cwd();
  const packageDir = path.join(rootDir, "packages", workspaceDir);

  if (await exists(packageDir)) {
    throw new Error(`Package directory already exists: ${path.relative(rootDir, packageDir)}`);
  }

  await mkdir(packageDir, { recursive: true });

  const packageJson = buildPackageJson({ packageName, description, types });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
  await writeFile(path.join(packageDir, "README.md"), packageReadme({ packageName, types }));

  if (types.includes("extensions")) {
    await mkdir(path.join(packageDir, "extensions"), { recursive: true });
    await writeFile(path.join(packageDir, "extensions", "index.ts"), extensionTemplate(packageName));
    await writeFile(
      path.join(packageDir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../../tsconfig.base.json",
          include: ["extensions/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    );
  }

  if (types.includes("skills")) {
    const skillDir = path.join(packageDir, "skills", slugify(packageName));
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), skillTemplate(packageName));
  }

  if (types.includes("prompts")) {
    await mkdir(path.join(packageDir, "prompts"), { recursive: true });
    await writeFile(path.join(packageDir, "prompts", `${slugify(packageName)}.md`), promptTemplate(packageName));
  }

  if (types.includes("themes")) {
    await mkdir(path.join(packageDir, "themes"), { recursive: true });
    await writeFile(path.join(packageDir, "themes", `${slugify(packageName)}.json`), themeTemplate());
  }

  console.log(`Created ${path.relative(rootDir, packageDir)}`);
  console.log(`- package: ${packageName}`);
  console.log(`- types: ${types.join(", ")}`);
  console.log("Next steps:");
  console.log(`  1. Open packages/${workspaceDir}`);
  console.log(`  2. Implement your ${types.join(", ")} resources`);
  console.log(`  3. Test with: pi install ./packages/${workspaceDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
