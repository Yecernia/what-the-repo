import { performance } from "node:perf_hooks";
import {
  createModels,
  createProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AnthropicMessagesCompat,
  type ApiKeyAuth,
  type Model,
  type OpenAICompletionsCompat,
  type Provider,
  type ProviderStreams,
  type FetchFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ProviderConfig } from "./provider-types.js";
import type { PiModelRuntime } from "./types.js";
import type { ProviderCallGate } from "./provider-gate.js";
import type {
  ProviderBudgetPermit,
  ProviderUsageBudget,
  ProviderUsageReport,
} from "./provider-budget.js";
import { ProviderBudgetExceededError } from "./provider-budget.js";
import {
  defaultRuntimeMetrics,
  METRIC_NAMES,
  type RuntimeMetrics,
} from "../observability/metrics.js";
import { createPublicFetch } from "../security/outbound-url.js";
import type { ProviderRequestDiagnostic } from "./worker-diagnostics.js";

export interface ModelRuntimeOptions {
  providerGate?: ProviderCallGate;
  providerBudget?: ProviderUsageBudget;
  ownerId?: string;
  metrics?: RuntimeMetrics;
}

class DeferredAssistantStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: ((value: IteratorResult<AssistantMessageEvent>) => void)[] = [];
  private done = false;
  private readonly finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (result: AssistantMessage) => void;

  constructor() {
    this.finalResultPromise = new Promise<AssistantMessage>((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(): void {
    this.done = true;
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true });
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

function configuredBuiltinProvider(config: ProviderConfig): Provider {
  const sourceId = config.adapterProvider ?? config.provider;
  const source = builtinProviders().find((provider) => provider.id === sourceId);
  if (!source) throw new Error(`unsupported_provider:${config.provider}`);
  const baseUrl = config.baseUrl || source.baseUrl;
  const sourceModels = source.getModels();
  const hasRequestedModel = sourceModels.some((model) => model.id === config.modelId);
  // Keep Pi's provider stream/auth implementation and model compatibility data,
  // while honoring the endpoint selected by the user's API-key preset. A model
  // returned by the upstream Provider may be newer than Pi's catalog, so add a
  // conservative descriptor that reuses the adapter's wire format.
  if (
    !baseUrl
    || (
      baseUrl === source.baseUrl
      && config.provider === source.id
      && hasRequestedModel
      && config.reasoning === undefined
      && config.thinkingLevelMap === undefined
      && config.compat === undefined
      && config.cost === undefined
      && config.contextWindow === undefined
      && config.maxOutputTokens === undefined
    )
  ) return source;
  const streams: ProviderStreams = {
    stream: source.stream.bind(source),
    streamSimple: source.streamSimple.bind(source),
  };
  const models = sourceModels.map((model) => ({
    ...model,
    provider: config.provider,
    baseUrl,
    ...(model.id === config.modelId
      ? {
        reasoning: config.reasoning ?? model.reasoning,
        thinkingLevelMap: config.thinkingLevelMap ?? model.thinkingLevelMap,
        compat: config.compat ?? model.compat,
        cost: config.cost ?? model.cost,
        contextWindow: config.contextWindow ?? model.contextWindow,
        maxTokens: config.maxOutputTokens ?? model.maxTokens,
      }
      : {}),
  }));
  if (!hasRequestedModel && config.modelId) {
    const baseline = sourceModels.find((model) => model.api === config.api) ?? sourceModels[0];
    if (baseline) {
      models.push({
        ...baseline,
        id: config.modelId,
        name: config.modelId,
        api: config.api,
        provider: config.provider,
        baseUrl,
        // Unknown models are called conservatively. Do not send Pi's
        // reasoning knobs unless the Provider catalog explicitly describes it.
        reasoning: config.reasoning ?? false,
        thinkingLevelMap: config.thinkingLevelMap ?? (config.reasoning ? baseline.thinkingLevelMap : undefined),
        compat: config.compat ?? baseline.compat,
        contextWindow: config.contextWindow ?? baseline.contextWindow,
        maxTokens: config.maxOutputTokens ?? baseline.maxTokens,
        cost: config.cost ?? baseline.cost,
      });
    }
  }
  return createProvider({
    id: config.provider,
    name: source.name,
    baseUrl,
    headers: source.headers,
    auth: source.auth,
    filterModels: source.filterModels,
    models,
    api: streams,
  });
}

// Only our observer around this exact fenced transport may replace it. Arbitrary
// per-call fetch options must never bypass the provider's public-network policy.
const observedFetchBases = new WeakMap<FetchFunction, FetchFunction>();
function providerFetch(base: FetchFunction, requested?: FetchFunction): FetchFunction {
  return requested && observedFetchBases.get(requested) === base ? requested : base;
}

function customProvider(config: ProviderConfig, fetch: FetchFunction): Provider {
  const apiKeyAuth: ApiKeyAuth = {
    name: "what-the-repo provider key",
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      if (!credential?.key) return undefined;
      const auth: { apiKey: string; headers?: Record<string, string> } = { apiKey: credential.key };
      if (config.authHeader === "api-key") auth.headers = { "api-key": credential.key };
      else if (config.authHeader === "authorization") auth.headers = { authorization: "Bearer " + credential.key };
      return { auth, source: "per-run credential" };
    },
  };
  const common = {
    id: config.provider,
    name: config.provider,
    baseUrl: config.baseUrl,
    auth: { apiKey: apiKeyAuth },
  };
  // Anthropic-compatible domestic endpoints use Pi's real Messages adapter;
  // this keeps /v1/messages, tool blocks, and streaming semantics intact.
  if (config.api === "anthropic-messages") {
    const model: Model<"anthropic-messages"> = {
      id: config.modelId,
      name: config.modelId,
      api: "anthropic-messages",
      provider: config.provider,
      baseUrl: config.baseUrl,
      reasoning: config.reasoning ?? config.thinkingLevel !== "off",
      input: ["text"],
      cost: config.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: config.contextWindow ?? 128_000,
      maxTokens: config.maxOutputTokens ?? 16_384,
      thinkingLevelMap: config.thinkingLevelMap,
      compat: config.compat as AnthropicMessagesCompat | undefined,
    };
    const streams = anthropicMessagesApi();
    return createProvider({
      ...common,
      models: [model],
      api: {
        stream: (requestModel, context, options) => streams.stream(requestModel, context, { ...options, fetch: providerFetch(fetch, options?.fetch) }),
        streamSimple: (requestModel, context, options) => streams.streamSimple(requestModel, context, { ...options, fetch: providerFetch(fetch, options?.fetch) }),
      },
    });
  }

  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? config.thinkingLevel !== "off",
    input: ["text"],
    cost: config.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxOutputTokens ?? 16_384,
    thinkingLevelMap: config.thinkingLevelMap,
    compat: config.compat as OpenAICompletionsCompat | undefined,
  };
  const streams = openAICompletionsApi();
  return createProvider({
    ...common,
    models: [model],
    // Keep the transport on the provider itself. Some internal Pi operations
    // (for example context compaction) call Models.completeSimple directly
    // and do not receive per-call options from our Agent stream wrapper.
    api: {
      stream: (requestModel, context, options) => streams.stream(requestModel, context, { ...options, fetch: providerFetch(fetch, options?.fetch) }),
      streamSimple: (requestModel, context, options) => streams.streamSimple(requestModel, context, { ...options, fetch: providerFetch(fetch, options?.fetch) }),
    },
  });
}

export function createModelRuntime(config: ProviderConfig, options: ModelRuntimeOptions = {}): PiModelRuntime {
  const publicFetch = config.builtin ? undefined : createPublicFetch();
  const provider = config.builtin
    ? configuredBuiltinProvider(config)
    : customProvider(config, publicFetch as FetchFunction);
  if (!provider) throw new Error(`unsupported_provider:${config.provider}`);
  const models = createModels();
  models.setProvider(provider);
  const model = provider.getModels().find((candidate) => candidate.id === config.modelId)
    ?? models.getModel(config.provider, config.modelId);
  if (!model) throw new Error(`unsupported_model:${config.provider}:${config.modelId}`);
  return {
    models,
    model: model as Model<Api>,
    apiKey: config.apiKey,
    fetch: publicFetch,
    networkTimeoutMs: config.networkTimeoutMs,
    providerGate: options.providerGate,
    providerBudget: options.providerBudget,
    ownerId: options.ownerId,
    metrics: options.metrics ?? defaultRuntimeMetrics,
  };
}

interface ProviderUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function providerLabels(runtime: PiModelRuntime): { provider: string; model: string } {
  return {
    provider: runtime.model.provider,
    model: runtime.model.id,
  };
}

function usageFrom(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const row = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
  const input = typeof row.input === "number" ? row.input : 0;
  const output = typeof row.output === "number" ? row.output : 0;
  const cacheRead = typeof row.cacheRead === "number" ? row.cacheRead : 0;
  const cacheWrite = typeof row.cacheWrite === "number" ? row.cacheWrite : 0;
  const cost = row.cost && typeof row.cost.total === "number" ? row.cost.total : 0;
  if (!(input || output || cacheRead || cacheWrite || cost)) return null;
  return { input, output, cacheRead, cacheWrite, cost };
}

function recordProviderCall(
  runtime: PiModelRuntime,
  outcome: "success" | "error" | "aborted" | "gate_error",
  durationMs: number,
  usage: ProviderUsage | null,
): void {
  const metrics = runtime.metrics;
  if (!metrics) return;
  const labels = { ...providerLabels(runtime), outcome };
  metrics.increment(METRIC_NAMES.providerCalls, 1, labels);
  metrics.observe(METRIC_NAMES.providerDuration, durationMs, providerLabels(runtime));
  if (!usage) return;
  metrics.increment(METRIC_NAMES.providerTokens, usage.input, { ...providerLabels(runtime), token_type: "input" });
  metrics.increment(METRIC_NAMES.providerTokens, usage.output, { ...providerLabels(runtime), token_type: "output" });
  metrics.increment(METRIC_NAMES.providerTokens, usage.cacheRead, { ...providerLabels(runtime), token_type: "cache_read" });
  metrics.increment(METRIC_NAMES.providerTokens, usage.cacheWrite, { ...providerLabels(runtime), token_type: "cache_write" });
  metrics.increment(METRIC_NAMES.providerCost, usage.cost, providerLabels(runtime));
}

function recordGateWait(runtime: PiModelRuntime, elapsedMs: number): void {
  if (!runtime.metrics || elapsedMs < 1) return;
  const labels = providerLabels(runtime);
  runtime.metrics.increment(METRIC_NAMES.providerGateWaits, 1, labels);
  runtime.metrics.observe(METRIC_NAMES.providerGateWaitDuration, elapsedMs, labels);
}

function estimatedProviderReservation(runtime: PiModelRuntime): number {
  const cost = runtime.model.cost;
  const input = Math.max(0, Math.min(runtime.model.contextWindow, 128_000)) * Math.max(0, cost.input);
  const output = Math.max(0, runtime.model.maxTokens) * Math.max(0, cost.output);
  const cacheRead = Math.max(0, Math.min(runtime.model.contextWindow, 128_000)) * Math.max(0, cost.cacheRead);
  return (input + output + cacheRead) / 1_000_000;
}

function usageReport(
  usage: ProviderUsage | null,
  status: ProviderUsageReport["status"],
  operationStarted: boolean,
): ProviderUsageReport {
  return {
    usageKnown: usage !== null || !operationStarted,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cachedTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    costUsd: usage?.cost ?? 0,
    status,
  };
}

// Keep a useful transport cause without recording URLs, headers or provider text.
const TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
function transportErrorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const row = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof row.code === "string" && TRANSPORT_ERROR_CODES.has(row.code)) return row.code;
    if (row.name === "AbortError") return "request_aborted";
    if (row.name === "TimeoutError") return "request_timeout";
    current = row.cause;
  }
  return "transport_error";
}

async function acquireBudget(
  runtime: PiModelRuntime,
  signal: AbortSignal | undefined,
): Promise<ProviderBudgetPermit | undefined> {
  if (!runtime.providerBudget || !runtime.ownerId) return undefined;
  return runtime.providerBudget.acquire({
    ownerId: runtime.ownerId,
    provider: runtime.model.provider,
    model: runtime.model.id,
    estimatedCostUsd: estimatedProviderReservation(runtime),
    signal,
  });
}

export async function withProviderPermit<T>(
  runtime: PiModelRuntime,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const acquireStarted = performance.now();
  let permit: Awaited<ReturnType<ProviderCallGate["acquire"]>> | undefined;
  let budgetPermit: ProviderBudgetPermit | undefined;
  let active = false;
  let finalUsage: ProviderUsage | null = null;
  let status: ProviderUsageReport["status"] = "failed";
  try {
    permit = await runtime.providerGate?.acquire(signal);
    recordGateWait(runtime, performance.now() - acquireStarted);
    try {
      budgetPermit = await acquireBudget(runtime, signal);
    } catch (error) {
      if (error instanceof ProviderBudgetExceededError) {
        runtime.metrics?.increment(METRIC_NAMES.providerBudgetRejects, 1, {
          ...providerLabels(runtime),
          kind: error.kind,
          scope: error.scope,
        });
      }
      throw error;
    }
    signal?.throwIfAborted();
    runtime.metrics?.addGauge(METRIC_NAMES.providerActive, 1, providerLabels(runtime));
    active = true;
    const callStarted = performance.now();
    try {
      const value = await operation();
      finalUsage = usageFrom(value);
      status = "completed";
      recordProviderCall(runtime, "success", performance.now() - callStarted, finalUsage);
      return value;
    } catch (error) {
      finalUsage = usageFrom(error);
      status = signal?.aborted ? "cancelled" : "failed";
      recordProviderCall(
        runtime,
        signal?.aborted ? "aborted" : "error",
        performance.now() - callStarted,
        finalUsage,
      );
      throw error;
    }
  } finally {
    if (active) runtime.metrics?.addGauge(METRIC_NAMES.providerActive, -1, providerLabels(runtime));
    try {
      await budgetPermit?.release(usageReport(finalUsage, !active && signal?.aborted ? "cancelled" : status, active));
    } catch {
      runtime.metrics?.increment(METRIC_NAMES.providerBudgetRecordErrors, 1, providerLabels(runtime));
    }
    await permit?.release();
  }
}

export function streamWithProviderPermit(
  runtime: PiModelRuntime,
  candidate: Model<Api>,
  context: Parameters<ReturnType<typeof createModels>["streamSimple"]>[1],
  streamOptions: Parameters<ReturnType<typeof createModels>["streamSimple"]>[2] | undefined,
  diagnostic?: ProviderRequestDiagnostic,
): ReturnType<ReturnType<typeof createModels>["streamSimple"]> {
  const wrapped = new DeferredAssistantStream();
  void (async () => {
    const acquireStarted = performance.now();
    let permit: Awaited<ReturnType<ProviderCallGate["acquire"]>> | undefined;
    let budgetPermit: ProviderBudgetPermit | undefined;
    let active = false;
    let finalUsage: ProviderUsage | null = null;
    let outcome: "success" | "error" | "aborted" | "gate_error" = "success";
    let budgetRejected = false;
    let usageStatus: ProviderUsageReport["status"] = "failed";
    let callStarted = performance.now();
    try {
      permit = await runtime.providerGate?.acquire(streamOptions?.signal);
      recordGateWait(runtime, performance.now() - acquireStarted);
      if (diagnostic) diagnostic.gateWaitMs = performance.now() - acquireStarted;
      const budgetStarted = performance.now();
      try {
        budgetPermit = await acquireBudget(runtime, streamOptions?.signal);
        if (diagnostic) {
          diagnostic.budgetWaitMs = performance.now() - budgetStarted;
          diagnostic.usageEventId = budgetPermit?.eventId ?? null;
        }
      } catch (error) {
        if (error instanceof ProviderBudgetExceededError) {
          budgetRejected = true;
          runtime.metrics?.increment(METRIC_NAMES.providerBudgetRejects, 1, {
            ...providerLabels(runtime),
            kind: error.kind,
            scope: error.scope,
          });
        }
        throw error;
      }
      streamOptions?.signal?.throwIfAborted();
      runtime.metrics?.addGauge(METRIC_NAMES.providerActive, 1, providerLabels(runtime));
      active = true;
      callStarted = performance.now();
      if (diagnostic) diagnostic.requestStartedAt = new Date().toISOString();
      const baseFetch = runtime.fetch ?? streamOptions?.fetch ?? (diagnostic ? globalThis.fetch : undefined);
      const observedFetch: FetchFunction | undefined = diagnostic && baseFetch
        ? async (...args) => {
          const started = performance.now();
          let status: number | null = null;
          let errorCode: string | undefined;
          try {
            const response = await baseFetch(...args);
            status = response.status;
            return response;
          } catch (error) {
            errorCode = transportErrorCode(error);
            throw error;
          } finally {
            if (diagnostic.transport.length < 32) diagnostic.transport.push({ headersMs: performance.now() - started, status, ...(errorCode ? { errorCode } : {}) });
          }
        }
        : baseFetch;
      if (observedFetch && baseFetch && observedFetch !== baseFetch) observedFetchBases.set(observedFetch, baseFetch);
      const source = runtime.models.streamSimple(candidate, context, {
        ...streamOptions,
        ...(observedFetch ? { fetch: observedFetch } : {}),
        ...(diagnostic ? { onPayload: async (payload: unknown, requestModel: typeof candidate) => {
          const replacement = await streamOptions?.onPayload?.(payload, requestModel);
          const effective = replacement ?? payload;
          const fields = effective && typeof effective === "object" ? effective as Record<string, unknown> : {};
          const limit = fields.max_tokens ?? fields.max_completion_tokens ?? fields.max_output_tokens;
          const wireTokenLimits = Object.fromEntries(
            ["max_tokens", "max_completion_tokens", "max_output_tokens"]
              .filter((key) => typeof fields[key] === "number" && Number.isFinite(fields[key]))
              .map((key) => [key, fields[key]]),
          );
          diagnostic.requestLimits = {
            modelMaxTokens: candidate.maxTokens,
            wireMaxTokens: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
            wireTokenLimits,
          };
          // Preserve caller overrides; never retain the payload, source, credentials or thinking.
          return replacement;
        } } : {}),
      });
      for await (const event of source) {
        if (diagnostic
          && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
          && event.delta.length > 0) {
          diagnostic.lastContentMs = performance.now() - callStarted;
          diagnostic.firstContentMs ??= diagnostic.lastContentMs;
          diagnostic.contentEvents++;
        }
        if (event.type === "done") {
          finalUsage = usageFrom(event.message);
          if (diagnostic) diagnostic.completionReason = event.reason;
        }
        else if (event.type === "error") {
          finalUsage = usageFrom(event.error);
          if (diagnostic) diagnostic.completionReason = event.reason;
          outcome = event.reason === "aborted" || streamOptions?.signal?.aborted ? "aborted" : "error";
        }
        wrapped.push(event);
      }
      usageStatus = outcome === "success" ? "completed" : outcome === "aborted" ? "cancelled" : "failed";
      wrapped.end();
    } catch (error) {
      outcome = streamOptions?.signal?.aborted ? "aborted" : "error";
      if (diagnostic) diagnostic.completionReason = outcome;
      usageStatus = outcome === "aborted" ? "cancelled" : "failed";
      const message = error instanceof Error ? error.message : "provider_gate_failed";
      const assistant: AssistantMessage = {
        role: "assistant",
        content: [],
        api: runtime.model.api,
        provider: runtime.model.provider,
        model: runtime.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: streamOptions?.signal?.aborted ? "aborted" : "error",
        errorMessage: message,
        timestamp: Date.now(),
      };
      wrapped.push({
        type: "error",
        reason: assistant.stopReason === "aborted" ? "aborted" : "error",
        error: assistant,
      });
      finalUsage = usageFrom(error) ?? finalUsage;
    } finally {
      if (!active && !budgetRejected) outcome = streamOptions?.signal?.aborted ? "aborted" : "gate_error";
      if (diagnostic) {
        diagnostic.durationMs = performance.now() - callStarted;
        diagnostic.status = budgetRejected ? "budget_rejected" : outcome;
        diagnostic.usage = usageReport(finalUsage, usageStatus, active);
      }
      if (!budgetRejected) {
        recordProviderCall(runtime, outcome, performance.now() - callStarted, finalUsage);
      }
      if (active) runtime.metrics?.addGauge(METRIC_NAMES.providerActive, -1, providerLabels(runtime));
      try {
        await budgetPermit?.release(usageReport(finalUsage, usageStatus, active));
      } catch {
        runtime.metrics?.increment(METRIC_NAMES.providerBudgetRecordErrors, 1, providerLabels(runtime));
      }
      await permit?.release();
    }
  })();
  return wrapped as unknown as ReturnType<ReturnType<typeof createModels>["streamSimple"]>;
}
