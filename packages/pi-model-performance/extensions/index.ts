import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Sample = {
  model: string;
  timestamp: number;
  turnIndex: number;
  latencyMs: number | null;
  reasoningMs: number | null;
  totalMs: number;
  streamMs: number | null;
  outputTokens: number;
  responseTps: number | null;
  e2eTps: number | null;
};

type DebugEvent = {
  name: string;
  at: number;
};

type ActiveTurn = {
  startedAt: number;
  requestStartedAt: number | null;
  turnIndex: number;
  firstActivityAt: number | null;
  firstTokenAt: number | null;
  lastTextLength: number;
  debugEvents: DebugEvent[];
};

const ENTRY_TYPE = "pi-model-performance:sample";
const MAX_SAMPLES = 200;

export default function piModelPerformance(pi: ExtensionAPI) {
  let activeTurn: ActiveTurn | null = null;
  let samples: Sample[] = [];
  let debugEnabled = false;

  function formatMs(value: number | null): string {
    return value == null ? "—" : `${Math.round(value)}ms`;
  }

  function formatRate(value: number | null): string {
    return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} t/s`;
  }

  function average(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function renderSample(sample: Sample): string {
    return [
      sample.model,
      `latency ${formatMs(sample.latencyMs)}`,
      `reasoning ${formatMs(sample.reasoningMs)}`,
      `response ${formatRate(sample.responseTps)}`,
      `${sample.outputTokens} tok`,
      `total ${formatMs(sample.totalMs)}`,
    ].join(" • ");
  }

  function getPerformanceText(sample: Sample | undefined): string {
    if (!sample) return "— • —";
    return `${formatMs(sample.latencyMs)} • ${formatRate(sample.responseTps)}`;
  }

  function formatTokens(value: number): string {
    return value < 1000 ? `${value}` : `${(value / 1000).toFixed(1)}k`;
  }

  function addDebugEvent(name: string) {
    if (!activeTurn || !debugEnabled) return;
    activeTurn.debugEvents.push({ name, at: Date.now() });
  }

  function formatDebugTimeline(turn: ActiveTurn, endedAt?: number): string {
    const base = turn.requestStartedAt ?? turn.startedAt;
    const events = [...turn.debugEvents];
    if (endedAt != null) events.push({ name: "message_end", at: endedAt });
    return events
      .map((event) => `${event.name} +${Math.max(0, event.at - base)}ms`)
      .join(" • ");
  }

  function getUsageText(ctx: ExtensionContext): string {
    let input = 0;
    let output = 0;
    let cost = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const message = entry.message as AssistantMessage;
        input += message.usage?.input ?? 0;
        output += message.usage?.output ?? 0;
        cost += message.usage?.cost?.total ?? 0;
      }
    }

    return `↑${formatTokens(input)} ↓${formatTokens(output)} $${cost.toFixed(3)}`;
  }

  function installFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const sample = samples[samples.length - 1];
        const usage = theme.fg("dim", getUsageText(ctx));
        const modelText = ctx.model
          ? `(${ctx.model.provider}) ${ctx.model.id} • ${pi.getThinkingLevel()}`
          : `no-model • ${pi.getThinkingLevel()}`;
        const right = theme.fg("dim", `${getPerformanceText(sample)} • ${modelText}`);
        const pad = " ".repeat(Math.max(1, width - visibleWidth(usage) - visibleWidth(right)));
        return [truncateToWidth(usage + pad + right, width)];
      },
    }));
  }

  function updateFooter(ctx: ExtensionContext) {
    installFooter(ctx);
  }

  function recordSample(sample: Sample) {
    samples.push(sample);
    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
    pi.appendEntry(ENTRY_TYPE, sample);
  }

  pi.on("session_start", async (_event, ctx) => {
    activeTurn = null;
    samples = [];

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
        samples.push(entry.data as Sample);
      }
    }

    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
    updateFooter(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    activeTurn = {
      startedAt: Date.now(),
      requestStartedAt: null,
      turnIndex: event.turnIndex,
      firstActivityAt: null,
      firstTokenAt: null,
      lastTextLength: 0,
      debugEvents: [{ name: "turn_start", at: Date.now() }],
    };

    updateFooter(ctx);
  });

  pi.on("before_provider_request", async () => {
    if (!activeTurn) return;
    activeTurn.requestStartedAt = Date.now();
    addDebugEvent("before_provider_request");
  });

  pi.on("message_update", async (event) => {
    if (!activeTurn) return;
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (activeTurn.firstActivityAt == null) {
      activeTurn.firstActivityAt = Date.now();
      addDebugEvent(`first_activity:${streamEvent.type}`);
    }

    if (streamEvent.type === "start") {
      addDebugEvent("stream_start");
      return;
    }

    if (streamEvent.type === "text_start") {
      addDebugEvent("text_start");
      activeTurn.lastTextLength = Math.max(activeTurn.lastTextLength, 0);
      return;
    }

    if (streamEvent.type === "text_delta") {
      activeTurn.lastTextLength += streamEvent.delta.length;
      if (activeTurn.firstTokenAt == null && streamEvent.delta.length > 0) {
        activeTurn.firstTokenAt = Date.now();
        addDebugEvent(`first_text_delta(${streamEvent.delta.length})`);
      }
      return;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!activeTurn) return;
    if (event.message.role !== "assistant") return;

    const endedAt = Date.now();
    const assistantMessage = event.message;
    const requestStartedAt = activeTurn.requestStartedAt ?? activeTurn.startedAt;
    const firstActivityAt = activeTurn.firstActivityAt;
    const firstTokenAt = activeTurn.firstTokenAt;
    const totalMs = Math.max(0, endedAt - requestStartedAt);
    const streamMs = firstTokenAt == null ? null : Math.max(0, endedAt - firstTokenAt);
    const latencyMs = firstActivityAt == null ? null : Math.max(0, firstActivityAt - requestStartedAt);
    const reasoningMs = firstActivityAt == null || firstTokenAt == null ? null : Math.max(0, firstTokenAt - firstActivityAt);
    const outputTokens = assistantMessage.usage?.output ?? 0;
    const responseTps = streamMs && streamMs > 0 && outputTokens > 0 ? outputTokens / (streamMs / 1000) : null;
    const e2eTps = totalMs > 0 && outputTokens > 0 ? outputTokens / (totalMs / 1000) : null;
    const model = assistantMessage.model
      ? `${assistantMessage.model.provider}/${assistantMessage.model.id}`
      : ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown-model";

    const sample: Sample = {
      model,
      timestamp: endedAt,
      turnIndex: activeTurn.turnIndex,
      latencyMs,
      reasoningMs,
      totalMs,
      streamMs,
      outputTokens,
      responseTps,
      e2eTps,
    };

    if (debugEnabled) {
      ctx.ui.notify(formatDebugTimeline(activeTurn, endedAt), "info");
    }

    recordSample(sample);
    updateFooter(ctx);
    activeTurn = null;
  });

  pi.registerCommand("perf-last", {
    description: "Show the most recent latency/reasoning/response sample",
    handler: async (_args, ctx) => {
      const sample = samples[samples.length - 1];
      if (!sample) {
        ctx.ui.notify("No samples yet. Send a prompt first.", "info");
        updateFooter(ctx);
        return;
      }

      ctx.ui.notify(renderSample(sample), "info");
      updateFooter(ctx);
    },
  });

  pi.registerCommand("perf-summary", {
    description: "Show average latency/reasoning/response over recent assistant turns. Usage: /perf-summary [count]",
    handler: async (args, ctx) => {
      const requested = Number.parseInt((args || "").trim(), 10);
      const count = Number.isFinite(requested) && requested > 0 ? requested : 10;
      const recent = samples.slice(-count);

      if (recent.length === 0) {
        ctx.ui.notify("No samples yet. Send a prompt first.", "info");
        updateFooter(ctx);
        return;
      }

      const avgLatency = average(recent.flatMap((sample) => (sample.latencyMs == null ? [] : [sample.latencyMs])));
      const avgReasoning = average(recent.flatMap((sample) => (sample.reasoningMs == null ? [] : [sample.reasoningMs])));
      const avgResponse = average(recent.flatMap((sample) => (sample.responseTps == null ? [] : [sample.responseTps])));
      const avgE2eTps = average(recent.flatMap((sample) => (sample.e2eTps == null ? [] : [sample.e2eTps])));
      const avgTokens = average(recent.map((sample) => sample.outputTokens));

      ctx.ui.notify(
        [
          `samples ${recent.length}`,
          `latency ${formatMs(avgLatency)}`,
          `reasoning ${formatMs(avgReasoning)}`,
          `response ${formatRate(avgResponse)}`,
          `end-to-end ${formatRate(avgE2eTps)}`,
          `avg output ${avgTokens == null ? "—" : `${avgTokens.toFixed(1)} tok`}`,
        ].join(" • "),
        "info",
      );

      updateFooter(ctx);
    },
  });

  async function refreshPerformanceState(ctx: ExtensionContext) {
    samples = [];
    activeTurn = null;
    updateFooter(ctx);
    ctx.ui.notify("Cleared in-memory performance state for this runtime.", "info");
  }

  pi.registerCommand("perf-reset", {
    description: "Clear in-memory performance samples for this runtime",
    handler: async (_args, ctx) => {
      await refreshPerformanceState(ctx);
    },
  });

  pi.registerCommand("perf-debug", {
    description: "Toggle debug timing notifications for streaming milestones",
    handler: async (_args, ctx) => {
      debugEnabled = !debugEnabled;
      ctx.ui.notify(`Performance debug ${debugEnabled ? "enabled" : "disabled"}.`, "info");
    },
  });
}
