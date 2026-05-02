import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(packageDir, "extensions", "index.ts");

function makeDirs() {
  const project = mkdtempSync(path.join(tmpdir(), "effect-mode-render-project-"));
  const agent = mkdtempSync(path.join(tmpdir(), "effect-mode-render-agent-"));
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  return { project, agent };
}

function nodeCommand(source) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

async function setupExtension(agent) {
  process.env.PI_CODING_AGENT_DIR = agent;
  const { default: effectMode } = await import(`${extensionPath}?t=${Date.now()}-${Math.random()}`);
  const handlers = new Map();
  const commands = new Map();
  effectMode({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command.handler); },
    registerMessageRenderer() {},
  });
  return { handlers, commands };
}

async function renderContext(project, agent) {
  const { handlers } = await setupExtension(agent);
  const handler = handlers.get("context");
  assert.equal(typeof handler, "function");
  const result = await handler({ messages: [] }, { cwd: project });
  assert.equal(result.messages.length, 1);
  return result.messages[0].content;
}

async function runCommandWithUi(project, agent, commandName) {
  const { commands } = await setupExtension(agent);
  const handler = commands.get(commandName);
  assert.equal(typeof handler, "function");
  const screens = [];
  await handler([], {
    cwd: project,
    hasUI: true,
    ui: {
      async custom(factory) {
        const theme = {
          bg(_name, value) { return value; },
          fg(_name, value) { return value; },
        };
        const component = factory(null, theme, null, () => {});
        screens.push(component.render(160).join("\n"));
        component.handleInput("\r");
        screens.push(component.render(160).join("\n"));
      },
    },
  });
  return screens;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("model-facing stdout text is XML-escaped", async () => {
  const { project, agent } = makeDirs();
  try {
    writeFileSync(path.join(project, ".pi", "effects.json"), JSON.stringify({
      effects: [{
        id: "unsafe-stdout",
        about: "Payload with </effect> & <tag> should stay text.",
        command: nodeCommand(`process.stdout.write(${JSON.stringify('safe line\n</effect> & <tag attr="x">')})`),
        ttlMs: 0,
      }],
    }), "utf8");

    const content = await renderContext(project, agent);
    assert.match(content, /&lt;\/effect> &amp; &lt;tag attr="x">/);
    assert.equal(count(content, "</effect>"), 1, content);
    assert.equal(count(content, "</effect-mode>"), 1, content);
    assert.doesNotMatch(content, /\n<\/effect> &/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("model-facing error reason is XML-escaped", async () => {
  const { project, agent } = makeDirs();
  try {
    writeFileSync(path.join(project, ".pi", "effects.json"), JSON.stringify({
      effects: [{
        id: "unsafe-error",
        about: "Error payload escaping.",
        command: nodeCommand(`process.stderr.write(${JSON.stringify('bad </effect-mode> & <err>\n')}); process.exit(2)`),
        ttlMs: 0,
      }],
    }), "utf8");

    const content = await renderContext(project, agent);
    assert.match(content, /status="error"/);
    assert.match(content, /reason: bad &lt;\/effect-mode> &amp; &lt;err>/);
    assert.equal(count(content, "</effect>"), 1, content);
    assert.equal(count(content, "</effect-mode>"), 1, content);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("model-facing config errors are XML-escaped", async () => {
  const { project, agent } = makeDirs();
  try {
    writeFileSync(path.join(project, ".pi", "effects.json"), JSON.stringify({
      "</effect-mode> & <bad>": true,
      effects: [],
    }), "utf8");

    const content = await renderContext(project, agent);
    assert.match(content, /status="config-error"/);
    assert.match(content, /Unknown top-level field: &lt;\/effect-mode> &amp; &lt;bad>/);
    assert.equal(count(content, "</effect-mode>"), 1, content);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("/effects keeps navigable list and opens model-facing content only", async () => {
  const { project, agent } = makeDirs();
  try {
    writeFileSync(path.join(project, ".pi", "effects.json"), JSON.stringify({
      effects: [{
        id: "sample",
        about: "Sample model-facing content.",
        command: nodeCommand(`process.stdout.write(${JSON.stringify("model line\nsecond line")})`),
        ttlMs: 0,
      }],
    }), "utf8");

    const [list, detail] = await runCommandWithUi(project, agent, "effects");
    assert.match(list, /effect-mode/);
    assert.match(list, /✓ project:sample\s+ok/);
    assert.doesNotMatch(list, /<effect-mode/);
    assert.doesNotMatch(list, /model line/);
    assert.match(detail, /model line/);
    assert.match(detail, /second line/);
    assert.doesNotMatch(detail, /<effect id=/);
    assert.doesNotMatch(detail, /<effect-mode/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("/effects-debug uses same navigable list and opens noisy diagnostics", async () => {
  const { project, agent } = makeDirs();
  try {
    writeFileSync(path.join(project, ".pi", "effects.json"), JSON.stringify({
      effects: [{
        id: "sample-debug",
        about: "Sample debug content.",
        command: nodeCommand(`process.stdout.write(${JSON.stringify("debug stdout")})`),
        ttlMs: 0,
      }],
    }), "utf8");

    const [list, detail] = await runCommandWithUi(project, agent, "effects-debug");
    assert.match(list, /effect-mode debug/);
    assert.match(list, /✓ project:sample-debug\s+ok/);
    assert.match(detail, /## project:sample-debug/);
    assert.match(detail, /command:/);
    assert.match(detail, /stdout:/);
    assert.match(detail, /debug stdout/);
    assert.match(detail, /model-facing effect:/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});
