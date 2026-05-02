import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute } from "node:path";
import { exec } from "node:child_process";

const CUSTOM_TYPE = "effect-mode";
const PROJECT_CONFIG_PATH = ".pi/effects.json";
const GLOBAL_CONFIG_PATH = "effects.json";
const DEFAULTS = {
  ttlMs: 2_000,
  errorTtlMs: 10_000,
  timeoutMs: 3_000,
  maxBytes: 12_000,
  enabled: true,
  cwd: "project",
};

type EffectOptions = Record<string, string | number | boolean | null>;

type EffectScope = "global" | "project";

type EffectConfig = {
  id: string;
  scope: EffectScope;
  description?: string;
  about?: string;
  command: string;
  cwd: string;
  ttlMs: number;
  errorTtlMs: number;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
  includeMetadata: boolean;
  options?: EffectOptions;
};

type EffectResult = {
  status: "ok" | "error" | "timeout";
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  truncated: boolean;
  originalBytes: number;
  renderedBytes: number;
  error?: string;
};

type CachedResult = { config: EffectConfig; result: EffectResult };

type LoadedConfig =
  | { ok: true; path: string; source: string; effects: EffectConfig[]; disabled: EffectConfig[] }
  | { ok: false; path: string; source: string; errors: string[] }
  | { ok: true; path: null; source: string; effects: EffectConfig[]; disabled: EffectConfig[] };

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi", "agent");
}

const cache = new Map<string, CachedResult>();
let lastCommandReport = "";
let lastCommandItems: Array<{ title: string; body: string; disabled?: boolean }> = [];
let lastCommandItemLines: number[] = [];

function bytes(s: string) {
  return Buffer.byteLength(s, "utf8");
}

function tailBytes(s: string, maxBytes: number) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= maxBytes) return { text: s, truncated: false, originalBytes: b.length };
  return {
    text: `[truncated: showing last ${maxBytes} bytes of ${b.length} bytes]\n` + b.subarray(b.length - maxBytes).toString("utf8"),
    truncated: true,
    originalBytes: b.length,
  };
}

function renderStreams(stdout: string, stderr: string, maxBytes: number) {
  let remaining = maxBytes;
  const outOriginal = bytes(stdout);
  const errOriginal = bytes(stderr);
  let truncated = false;
  let out = stdout;
  let err = stderr;

  if (stdout) {
    const clipped = tailBytes(stdout, remaining);
    out = clipped.text;
    remaining = Math.max(0, remaining - bytes(out));
    truncated ||= clipped.truncated;
  }
  if (stderr) {
    if (remaining <= 0) {
      err = `[stderr omitted: maxBytes budget exhausted, ${errOriginal} bytes omitted]`;
      truncated = true;
    } else {
      const clipped = tailBytes(stderr, remaining);
      err = clipped.text;
      truncated ||= clipped.truncated;
    }
  }

  return {
    stdout: out,
    stderr: err,
    truncated,
    originalBytes: outOriginal + errOriginal,
    renderedBytes: bytes(out) + bytes(err),
  };
}

function formatMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function age(result: EffectResult) {
  const delta = Date.now() - result.finishedAt;
  return delta < 50 ? "fresh" : `cached ${formatMs(delta)}`;
}

function isFresh(entry: CachedResult) {
  const ttl = entry.result.status === "ok" ? entry.config.ttlMs : entry.config.errorTtlMs;
  return Date.now() - entry.result.finishedAt <= ttl;
}

function isScalarOptionValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function stableOptionsJson(options: EffectOptions | undefined) {
  return JSON.stringify(options ?? {});
}

function sameConfigForCache(a: EffectConfig, b: EffectConfig) {
  return a.command === b.command
    && a.cwd === b.cwd
    && a.description === b.description
    && a.about === b.about
    && a.includeMetadata === b.includeMetadata
    && a.ttlMs === b.ttlMs
    && a.errorTtlMs === b.errorTtlMs
    && a.timeoutMs === b.timeoutMs
    && a.maxBytes === b.maxBytes
    && stableOptionsJson(a.options) === stableOptionsJson(b.options);
}

function formatOptions(options: EffectOptions | undefined) {
  const json = stableOptionsJson(options);
  return json.length <= 240 ? json : `${json.slice(0, 237)}...`;
}

function loadConfig(projectCwd: string, scope: EffectScope): LoadedConfig {
  const path = scope === "project" ? resolve(projectCwd, PROJECT_CONFIG_PATH) : resolve(agentDir(), GLOBAL_CONFIG_PATH);
  const source = scope === "project" ? PROJECT_CONFIG_PATH : `~/.pi/agent/${GLOBAL_CONFIG_PATH}`;
  if (!existsSync(path)) return { ok: true, path: null, source, effects: [], disabled: [] };

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, path, source, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const errors: string[] = [];
  const allowedTop = new Set(["$schema", "effects"]);
  const allowedEffect = new Set(["id", "description", "about", "command", "cwd", "ttlMs", "errorTtlMs", "timeoutMs", "maxBytes", "enabled", "includeMetadata", "options"]);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, path, source, errors: ["Top-level value must be an object."] };
  }
  for (const key of Object.keys(data as Record<string, unknown>)) {
    if (!allowedTop.has(key)) errors.push(`Unknown top-level field: ${key}`);
  }
  const rawEffects = (data as { effects?: unknown }).effects;
  if (!Array.isArray(rawEffects)) errors.push("effects must be an array.");

  const ids = new Set<string>();
  const effects: EffectConfig[] = [];
  const disabled: EffectConfig[] = [];

  if (Array.isArray(rawEffects)) {
    rawEffects.forEach((raw, i) => {
      const prefix = `effects[${i}]`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }
      const obj = raw as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!allowedEffect.has(key)) errors.push(`${prefix}.${key} is not allowed.`);
      }
      if (typeof obj.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(obj.id)) {
        errors.push(`${prefix}.id must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$.`);
      } else if (ids.has(obj.id)) {
        errors.push(`${prefix}.id duplicates '${obj.id}'.`);
      } else ids.add(obj.id);
      if (typeof obj.command !== "string" || obj.command.trim() === "") errors.push(`${prefix}.command must be a non-empty string.`);
      if (obj.description !== undefined && typeof obj.description !== "string") errors.push(`${prefix}.description must be a string.`);
      if (obj.about !== undefined && typeof obj.about !== "string") errors.push(`${prefix}.about must be a string.`);
      const cwdValue = obj.cwd === undefined ? DEFAULTS.cwd : obj.cwd;
      if (typeof cwdValue !== "string" || cwdValue === "") errors.push(`${prefix}.cwd must be a string.`);
      else if (cwdValue !== "project") {
        if (isAbsolute(cwdValue)) errors.push(`${prefix}.cwd must not be absolute.`);
        const baseCwd = scope === "project" ? projectCwd : agentDir();
        const resolved = resolve(baseCwd, cwdValue);
        const rel = relative(baseCwd, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) errors.push(`${prefix}.cwd must not escape the project root.`);
      }
      const numbers = ["ttlMs", "errorTtlMs", "timeoutMs", "maxBytes"] as const;
      for (const key of numbers) {
        if (obj[key] !== undefined && (typeof obj[key] !== "number" || !Number.isFinite(obj[key]) || obj[key] < 0)) {
          errors.push(`${prefix}.${key} must be a non-negative number.`);
        }
      }
      if (typeof obj.timeoutMs === "number" && obj.timeoutMs <= 0) errors.push(`${prefix}.timeoutMs must be greater than 0.`);
      if (typeof obj.maxBytes === "number" && obj.maxBytes <= 0) errors.push(`${prefix}.maxBytes must be greater than 0.`);
      if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") errors.push(`${prefix}.enabled must be a boolean.`);
      if (obj.includeMetadata !== undefined && typeof obj.includeMetadata !== "boolean") errors.push(`${prefix}.includeMetadata must be a boolean.`);
      let options: EffectOptions | undefined;
      if (obj.options !== undefined) {
        if (!obj.options || typeof obj.options !== "object" || Array.isArray(obj.options)) {
          errors.push(`${prefix}.options must be an object with scalar values.`);
        } else {
          options = {};
          for (const [key, value] of Object.entries(obj.options as Record<string, unknown>)) {
            if (!isScalarOptionValue(value)) errors.push(`${prefix}.options.${key} must be a scalar value.`);
            else options[key] = value;
          }
        }
      }

      if (errors.length === 0 || typeof obj.id === "string") {
        const cfg: EffectConfig = {
          id: String(obj.id ?? `invalid-${i}`),
          scope,
          description: typeof obj.description === "string" ? obj.description : undefined,
          about: typeof obj.about === "string" ? obj.about : undefined,
          command: typeof obj.command === "string" ? obj.command : "",
          cwd: typeof cwdValue === "string" ? cwdValue : DEFAULTS.cwd,
          ttlMs: typeof obj.ttlMs === "number" ? obj.ttlMs : DEFAULTS.ttlMs,
          errorTtlMs: typeof obj.errorTtlMs === "number" ? obj.errorTtlMs : DEFAULTS.errorTtlMs,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : DEFAULTS.timeoutMs,
          maxBytes: typeof obj.maxBytes === "number" ? obj.maxBytes : DEFAULTS.maxBytes,
          enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULTS.enabled,
          includeMetadata: typeof obj.includeMetadata === "boolean" ? obj.includeMetadata : true,
          options,
        };
        (cfg.enabled ? effects : disabled).push(cfg);
      }
    });
  }

  if (errors.length) return { ok: false, path, source, errors };
  return { ok: true, path, source, effects, disabled };
}

function effectBaseCwd(projectCwd: string, cfg: EffectConfig) {
  return cfg.scope === "project" ? projectCwd : agentDir();
}

function effectCwd(projectCwd: string, cfg: EffectConfig) {
  const base = effectBaseCwd(projectCwd, cfg);
  return cfg.cwd === "project" ? projectCwd : resolve(base, cfg.cwd);
}

function executeEffect(projectCwd: string, cfg: EffectConfig): Promise<EffectResult> {
  const startedAt = Date.now();
  return new Promise((resolveResult) => {
    const cwd = resolve(effectCwd(projectCwd, cfg));
    exec(cfg.command, {
      cwd,
      env: {
        ...process.env,
        PI_EFFECT_ID: cfg.id,
        PI_EFFECT_SCOPE: cfg.scope,
        PI_EFFECT_CWD: cwd,
        PI_EFFECT_OPTIONS_JSON: stableOptionsJson(cfg.options),
      },
      timeout: cfg.timeoutMs,
      maxBuffer: Math.max(cfg.maxBytes * 4, 1024 * 1024),
    }, (error, stdoutRaw, stderrRaw) => {
      const finishedAt = Date.now();
      const stdout = String(stdoutRaw ?? "");
      const stderr = String(stderrRaw ?? "");
      const rendered = renderStreams(stdout, stderr, cfg.maxBytes);
      const anyError = error as (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
      const timeout = anyError?.killed || anyError?.signal === "SIGTERM";
      resolveResult({
        status: timeout ? "timeout" : anyError ? "error" : "ok",
        exitCode: typeof anyError?.code === "number" ? anyError.code : anyError ? null : 0,
        stdout: rendered.stdout,
        stderr: rendered.stderr,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        truncated: rendered.truncated,
        originalBytes: rendered.originalBytes,
        renderedBytes: rendered.renderedBytes,
        error: anyError?.message,
      });
    });
  });
}

async function resolveEffects(projectCwd: string, effects: EffectConfig[]) {
  const results: CachedResult[] = [];
  for (const cfg of effects) {
    const key = `${cfg.scope}:${projectCwd}:${cfg.id}`;
    const cached = cache.get(key);
    if (cached && sameConfigForCache(cached.config, cfg) && isFresh(cached)) {
      results.push(cached);
      continue;
    }
    const result = await executeEffect(projectCwd, cfg);
    const entry = { config: cfg, result };
    cache.set(key, entry);
    results.push(entry);
  }
  return results;
}

function xmlAttr(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
}

function compactIsoUtc(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function effectLabel(cfg: EffectConfig) {
  return `${cfg.scope}:${cfg.id}`;
}

function effectAbout(cfg: EffectConfig) {
  const about = cfg.about ?? cfg.description;
  return about && about.trim() ? about.trim() : undefined;
}

function firstUsefulLine(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function compactReason(result: EffectResult) {
  if (result.status === "timeout") return `command timed out after ${formatMs(result.durationMs)}`;
  if (typeof result.exitCode === "number") return `command exited ${result.exitCode}`;
  return "command failed";
}

function renderModelEffectContent(entry: CachedResult) {
  const { config: cfg, result: r } = entry;
  const lines: string[] = [];
  if (r.status === "ok") {
    if (r.stdout.trimEnd()) lines.push(xmlText(r.stdout.trimEnd()));
    else lines.push("[no output]");
  } else {
    lines.push(`unavailable: ${xmlText(compactReason(r))}`);
    const reason = firstUsefulLine(r.stderr || r.stdout);
    if (reason) {
      const compact = reason.length > 180 ? `${reason.slice(0, 177)}...` : reason;
      lines.push(`reason: ${xmlText(compact)}`);
    }
    lines.push(`agentAction: Explain that ${xmlText(effectLabel(cfg))} context is unavailable; continue without assuming it. Suggest the user run /effects-debug if details matter.`);
  }
  return lines.join("\n");
}

function renderModelEffect(entry: CachedResult) {
  const { config: cfg, result: r } = entry;
  const attrs = [`id="${xmlAttr(effectLabel(cfg))}"`];
  const about = effectAbout(cfg);
  if (about) attrs.push(`about="${xmlAttr(about)}"`);
  if (r.status !== "ok") attrs.push(`status="${xmlAttr(r.status)}"`);

  const content = renderModelEffectContent(entry);
  return [`<effect ${attrs.join(" ")}>`, content, "</effect>"].join("\n");
}

function renderDebugEffect(entry: CachedResult, projectCwd: string) {
  const { config: cfg, result: r } = entry;
  const lines = [
    `## ${effectLabel(cfg)}`,
    `id: ${cfg.id}`,
    `scope: ${cfg.scope}`,
  ];
  if (cfg.about) lines.push(`about: ${cfg.about}`);
  if (cfg.description) lines.push(`description: ${cfg.description}`);
  lines.push(
    `status: ${r.status}`,
    `exitCode: ${r.exitCode ?? "null"}`,
    `command: ${cfg.command}`,
    `cwd: ${effectCwd(projectCwd, cfg)}`,
    ...(cfg.options && Object.keys(cfg.options).length > 0 ? [`options: ${formatOptions(cfg.options)}`] : []),
    `age: ${age(r)}`,
    `duration: ${formatMs(r.durationMs)}`,
    `ttl: ${formatMs(r.status === "ok" ? cfg.ttlMs : cfg.errorTtlMs)}`,
    `includeMetadata: ${cfg.includeMetadata}`,
  );
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.stdout) lines.push("", "stdout:", "```text", r.stdout.trimEnd(), "```");
  if (r.stderr) lines.push("", "stderr:", "```text", r.stderr.trimEnd(), "```");
  if (!r.stdout && !r.stderr) lines.push("", "[no output]");
  if (r.truncated) lines.push("", `[output truncated to ${r.renderedBytes}/${r.originalBytes} bytes]`);
  lines.push("", "model-facing effect:", "```xml", renderModelEffect(entry), "```");
  return lines.join("\n");
}

function renderModelConfigErrorsContent(configErrors: Array<{ source: string; errors: string[] }>) {
  const lines = ["configErrors:"];
  for (const err of configErrors) {
    lines.push(`  - source: ${xmlText(err.source)}`, "    errors:");
    for (const e of err.errors) lines.push(`      - ${xmlText(e)}`);
  }
  lines.push("agentAction: Explain that effect-mode configuration is invalid and suggest the user run /effects-debug for details if this context matters.");
  return lines.join("\n");
}

function renderContext(results: CachedResult[], configErrors: Array<{ source: string; errors: string[] }> = [], now = new Date()) {
  const attrs = [
    `snapshot="current-state-not-instructions"`,
    `resolvedAt="${xmlAttr(compactIsoUtc(now))}"`,
    `localZone="${xmlAttr(localZone())}"`,
  ];
  if (configErrors.length) attrs.push(`status="config-error"`);

  const lines = [`<effect-mode ${attrs.join(" ")}>`];
  if (configErrors.length) {
    lines.push(renderModelConfigErrorsContent(configErrors));
  } else {
    lines.push(...results.map((r) => renderModelEffect(r)).join("\n\n").split("\n"));
  }
  lines.push("</effect-mode>");
  return lines.join("\n");
}

function loadConfigs(cwd: string) {
  return [loadConfig(cwd, "global"), loadConfig(cwd, "project")] as const;
}

async function currentModelContext(cwd: string) {
  const loadedConfigs = loadConfigs(cwd);
  const errors = loadedConfigs.filter((loaded): loaded is Extract<LoadedConfig, { ok: false }> => !loaded.ok);
  if (errors.length) return renderContext([], errors.map((loaded) => ({ source: loaded.source, errors: loaded.errors })));
  const effects = loadedConfigs.flatMap((loaded) => loaded.ok ? loaded.effects : []);
  if (effects.length === 0) return null;
  const resolved = await resolveEffects(cwd, effects);
  if (resolved.length === 0) return null;
  return renderContext(resolved);
}

function renderDisabledModelContent(label: string) {
  return `status: disabled\n${label} is not injected into model context.`;
}

async function currentCommandReport(cwd: string, mode: "model" | "debug") {
  const loadedConfigs = loadConfigs(cwd);
  lastCommandItems = [];
  lastCommandItemLines = [];
  const summary = mode === "debug"
    ? [
      `effect-mode debug`,
      `note: raw stdout/stderr are from commands as configured; /effects-debug does not add script-specific debug flags.`,
    ]
    : [`effect-mode`];

  for (const loaded of loadedConfigs) {
    summary.push("", `source: ${loaded.source}`);
    if (!loaded.ok) {
      lastCommandItemLines.push(summary.length);
      summary.push("status: config-error", "", ...loaded.errors.map((e) => `- ${e}`));
      const body = mode === "debug"
        ? `effect-mode debug\nsource: ${loaded.source}\npath: ${loaded.path}\nstatus: config-error\n\n${loaded.errors.map((e) => `- ${e}`).join("\n")}`
        : renderModelConfigErrorsContent([{ source: loaded.source, errors: loaded.errors }]);
      lastCommandItems.push({ title: `${loaded.source} errors`, body });
      continue;
    }
    if (!loaded.path) {
      summary.push("not configured");
      continue;
    }

    const resolved = await resolveEffects(cwd, loaded.effects);
    for (const entry of resolved) {
      const icon = entry.result.status === "ok" ? "✓" : "✗";
      const label = effectLabel(entry.config);
      lastCommandItemLines.push(summary.length);
      summary.push(`${icon} ${label}  ${entry.result.status}  ${age(entry.result)}  ${formatMs(entry.result.durationMs)}`);
      lastCommandItems.push({
        title: label,
        body: mode === "debug" ? renderDebugEffect(entry, cwd) : renderModelEffectContent(entry),
      });
    }
    for (const cfg of loaded.disabled) {
      const label = effectLabel(cfg);
      lastCommandItemLines.push(summary.length);
      summary.push(`- ${label}  disabled`);
      lastCommandItems.push({
        title: label,
        body: mode === "debug" ? `## ${label}\nstatus: disabled\ncommand: ${cfg.command}` : renderDisabledModelContent(label),
        disabled: true,
      });
    }
    if (resolved.length === 0 && loaded.disabled.length === 0) summary.push("No effects configured.");
  }

  if (lastCommandItems.length > 0) {
    summary.push("", `Use ↑/↓ or j/k to select; Enter opens selected ${mode === "debug" ? "debug output" : "model-facing content"}; q/Esc closes.`);
  }
  return summary.join("\n");
}

async function showEffectsOverlay(ctx: any, report: string) {
  let selected = 0;
  let detail: string | null = null;
  await ctx.ui.custom((_tui: any, theme: any, _keybindings: any, done: (v: null) => void) => {
    const component = {
      render(width: number): string[] {
        const text = detail ?? report;
        const raw = text.split("\n");
        const lines = raw.map((line, idx) => {
          if (!detail && lastCommandItemLines[selected] === idx) {
            return theme.bg("selectedBg", truncateToWidth(line, width - 2, "…"));
          }
          return truncateToWidth(line, width - 2, "…");
        });
        const box = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
        box.addChild(new Text(lines.join("\n"), 1, 1));
        return box.render(width);
      },
      handleInput(data: string) {
        if (data === "\x1b" || data === "q" || data === "Q") {
          if (detail) detail = null;
          else done(null);
          return true;
        }
        if (detail) return false;
        if (data === "\u001b[A" || data === "k") { selected = Math.max(0, selected - 1); return true; }
        if (data === "\u001b[B" || data === "j") { selected = Math.min(Math.max(0, lastCommandItems.length - 1), selected + 1); return true; }
        if (data === "\r") { detail = lastCommandItems[selected]?.body ?? null; return true; }
        return false;
      },
    };
    return component;
  });
}

export default function effectMode(pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const filtered = event.messages.filter((m) => m.role !== "custom" || (m as { customType?: string }).customType !== CUSTOM_TYPE);
    const content = await currentModelContext(ctx.cwd);
    if (!content) return { messages: filtered };
    filtered.push({ role: "custom", customType: CUSTOM_TYPE, content, display: false, timestamp: Date.now() });
    return { messages: filtered };
  });

  pi.registerCommand("effects", {
    description: "Inspect effect-mode effects and open model-facing content",
    handler: async (_args, ctx) => {
      lastCommandReport = await currentCommandReport(ctx.cwd, "model");
      if (ctx.hasUI) await showEffectsOverlay(ctx, lastCommandReport);
      else ctx.ui.notify(lastCommandReport, "info");
    },
  });

  pi.registerCommand("effects-debug", {
    description: "Inspect effect-mode effects and open debug output",
    handler: async (_args, ctx) => {
      lastCommandReport = await currentCommandReport(ctx.cwd, "debug");
      if (ctx.hasUI) await showEffectsOverlay(ctx, lastCommandReport);
      else ctx.ui.notify(lastCommandReport, "info");
    },
  });

  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const full = typeof message.content === "string" ? message.content : "";
    const text = expanded ? full : "effect-mode dynamic context";
    return new Text(theme.fg("dim", text), 0, 0);
  });
}
