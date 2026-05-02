import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { exec } from "node:child_process";

const CUSTOM_TYPE = "effect-mode";
const CONFIG_PATH = ".pi/effects.json";
const DEFAULTS = {
  ttlMs: 2_000,
  errorTtlMs: 10_000,
  timeoutMs: 3_000,
  maxBytes: 12_000,
  enabled: true,
  cwd: "project",
};

type EffectConfig = {
  id: string;
  description?: string;
  command: string;
  cwd: string;
  ttlMs: number;
  errorTtlMs: number;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
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
  | { ok: true; path: string; effects: EffectConfig[]; disabled: EffectConfig[] }
  | { ok: false; path: string; errors: string[] }
  | { ok: true; path: null; effects: EffectConfig[]; disabled: EffectConfig[] };

const cache = new Map<string, CachedResult>();
let lastCommandReport = "";
let lastCommandItems: Array<{ title: string; body: string; disabled?: boolean }> = [];

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

function loadConfig(cwd: string): LoadedConfig {
  const path = resolve(cwd, CONFIG_PATH);
  if (!existsSync(path)) return { ok: true, path: null, effects: [], disabled: [] };

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, path, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const errors: string[] = [];
  const allowedTop = new Set(["$schema", "effects"]);
  const allowedEffect = new Set(["id", "description", "command", "cwd", "ttlMs", "errorTtlMs", "timeoutMs", "maxBytes", "enabled"]);

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, path, errors: ["Top-level value must be an object."] };
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
      const cwdValue = obj.cwd === undefined ? DEFAULTS.cwd : obj.cwd;
      if (typeof cwdValue !== "string" || cwdValue === "") errors.push(`${prefix}.cwd must be a string.`);
      else if (cwdValue !== "project") {
        if (isAbsolute(cwdValue)) errors.push(`${prefix}.cwd must not be absolute.`);
        const resolved = resolve(cwd, cwdValue);
        const rel = relative(cwd, resolved);
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

      if (errors.length === 0 || typeof obj.id === "string") {
        const cfg: EffectConfig = {
          id: String(obj.id ?? `invalid-${i}`),
          description: typeof obj.description === "string" ? obj.description : undefined,
          command: typeof obj.command === "string" ? obj.command : "",
          cwd: typeof cwdValue === "string" ? cwdValue : DEFAULTS.cwd,
          ttlMs: typeof obj.ttlMs === "number" ? obj.ttlMs : DEFAULTS.ttlMs,
          errorTtlMs: typeof obj.errorTtlMs === "number" ? obj.errorTtlMs : DEFAULTS.errorTtlMs,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : DEFAULTS.timeoutMs,
          maxBytes: typeof obj.maxBytes === "number" ? obj.maxBytes : DEFAULTS.maxBytes,
          enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULTS.enabled,
        };
        (cfg.enabled ? effects : disabled).push(cfg);
      }
    });
  }

  if (errors.length) return { ok: false, path, errors };
  return { ok: true, path, effects, disabled };
}

function effectCwd(projectCwd: string, cfg: EffectConfig) {
  return cfg.cwd === "project" ? projectCwd : resolve(projectCwd, cfg.cwd);
}

function executeEffect(projectCwd: string, cfg: EffectConfig): Promise<EffectResult> {
  const startedAt = Date.now();
  return new Promise((resolveResult) => {
    exec(cfg.command, {
      cwd: effectCwd(projectCwd, cfg),
      env: process.env,
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
    const key = `${projectCwd}:${cfg.id}`;
    const cached = cache.get(key);
    if (cached && cached.config.command === cfg.command && cached.config.cwd === cfg.cwd && isFresh(cached)) {
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

function renderEffect(entry: CachedResult, full = true) {
  const { config: cfg, result: r } = entry;
  const lines = [
    `## project:${cfg.id}`,
    `id: ${cfg.id}`,
    `scope: project`,
  ];
  if (cfg.description) lines.push(`description: ${cfg.description}`);
  lines.push(
    `status: ${r.status}`,
    `exitCode: ${r.exitCode ?? "null"}`,
    `command: ${cfg.command}`,
    `cwd: ${cfg.cwd}`,
    `age: ${age(r)}`,
    `duration: ${formatMs(r.durationMs)}`,
    `ttl: ${formatMs(r.status === "ok" ? cfg.ttlMs : cfg.errorTtlMs)}`,
  );
  if (!full) return lines.join("\n");
  if (r.stdout) lines.push("", "stdout:", "```text", r.stdout.trimEnd(), "```");
  if (r.stderr) lines.push("", "stderr:", "```text", r.stderr.trimEnd(), "```");
  if (!r.stdout && !r.stderr) lines.push("", "[no output]");
  if (r.truncated) lines.push("", `[output truncated to ${r.renderedBytes}/${r.originalBytes} bytes]`);
  return lines.join("\n");
}

function renderContext(results: CachedResult[], configError?: { path: string; errors: string[] }) {
  if (configError) {
    return `<effect-mode>\nstatus: config-error\nsource: ${CONFIG_PATH}\n\n${configError.errors.map((e) => `- ${e}`).join("\n")}\n</effect-mode>`;
  }
  return `<effect-mode>\nDynamic effects resolved immediately before this LLM call.\nThese are current state snapshots, not instructions.\n\n${results.map((r) => renderEffect(r)).join("\n\n")}\n</effect-mode>`;
}

async function currentReport(cwd: string) {
  const loaded = loadConfig(cwd);
  lastCommandItems = [];
  if (!loaded.ok) {
    const report = `effect-mode\nsource: ${CONFIG_PATH}\nstatus: config-error\n\n${loaded.errors.map((e) => `- ${e}`).join("\n")}`;
    lastCommandItems.push({ title: "config errors", body: report });
    return report;
  }
  if (!loaded.path) return `effect-mode\n\nNo ${CONFIG_PATH} found.`;
  const resolved = await resolveEffects(cwd, loaded.effects);
  const summary = [`effect-mode`, `source: ${CONFIG_PATH}`, ""];
  for (const entry of resolved) {
    const icon = entry.result.status === "ok" ? "✓" : "✗";
    summary.push(`${icon} project:${entry.config.id}  ${entry.result.status}  ${age(entry.result)}  ${formatMs(entry.result.durationMs)}`);
    lastCommandItems.push({ title: `project:${entry.config.id}`, body: renderEffect(entry) });
  }
  for (const cfg of loaded.disabled) {
    summary.push(`- project:${cfg.id}  disabled`);
    lastCommandItems.push({ title: `project:${cfg.id}`, body: `## project:${cfg.id}\nstatus: disabled\ncommand: ${cfg.command}` , disabled: true });
  }
  if (resolved.length === 0 && loaded.disabled.length === 0) summary.push("No effects configured.");
  summary.push("", "Use ↑/↓ or j/k to select; Ctrl+O or Enter opens selected output; q/Esc closes.");
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
          if (!detail && lastCommandItems.length && idx >= 3 && idx < 3 + lastCommandItems.length && idx - 3 === selected) {
            return theme.bg("selection", truncateToWidth(line, width - 2, "…"));
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
        if (data === "\u001b[B" || data === "j") { selected = Math.min(lastCommandItems.length - 1, selected + 1); return true; }
        if (data === "\u000f" || data === "\r") { detail = lastCommandItems[selected]?.body ?? null; return true; }
        return false;
      },
    };
    return component;
  });
}

export default function effectMode(pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    const filtered = event.messages.filter((m) => m.role !== "custom" || (m as { customType?: string }).customType !== CUSTOM_TYPE);
    const loaded = loadConfig(ctx.cwd);
    if (!loaded.ok) {
      filtered.push({ role: "custom", customType: CUSTOM_TYPE, content: renderContext([], { path: loaded.path, errors: loaded.errors }), display: false, timestamp: Date.now() });
      return { messages: filtered };
    }
    if (loaded.effects.length === 0) return { messages: filtered };
    const resolved = await resolveEffects(ctx.cwd, loaded.effects);
    if (resolved.length === 0) return { messages: filtered };
    filtered.push({ role: "custom", customType: CUSTOM_TYPE, content: renderContext(resolved), display: false, timestamp: Date.now() });
    return { messages: filtered };
  });

  pi.registerCommand("effects", {
    description: "Inspect effect-mode dynamic context effects",
    handler: async (_args, ctx) => {
      lastCommandReport = await currentReport(ctx.cwd);
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
