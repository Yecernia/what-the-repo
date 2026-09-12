import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type {
  PiSessionFactory,
  PiSessionReport,
  PiTraceEvent,
  PiUsage,
  RestrictedToolDescriptor,
} from "./contracts.js";
import { MAX_PI_TRACE_EVENT_BYTES, MAX_PI_TRACE_EVENTS, utf8Bytes } from "./limits.js";

export class PiBudgetExceededError extends Error {
  override readonly name = "PiBudgetExceededError";

  constructor(message: string, readonly report: PiSessionReport) {
    super(message);
  }
}

interface SdkSession {
  sessionId: string;
  prompt(text: string, options?: Record<string, unknown>): Promise<void>;
  compact?(instructions?: string): Promise<unknown>;
  abort?(): Promise<void>;
  dispose?(): void | Promise<void>;
  subscribe?(listener: (event: Record<string, unknown>) => void): () => void;
  getSessionStats?(): {
    sessionId: string;
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    cost?: number;
  };
}

interface PiSdkModule {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
  SessionManager: {
    create(cwd: string, sessionDir: string, options?: Record<string, unknown>): unknown;
    inMemory(cwd?: string): unknown;
  };
  SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
  createExtensionRuntime(): ExtensionRuntimeLike;
}

interface ExtensionRuntimeLike {
  flagValues: Map<string, boolean | string>;
  pendingProviderRegistrations: unknown[];
  pendingNativeProviderRegistrations: unknown[];
  assertActive(): void;
  invalidate(message?: string): void;
  trackEventBusSubscription(unsubscribe: () => void): () => void;
  registerProvider(...args: unknown[]): void;
  registerNativeProvider(...args: unknown[]): void;
  unregisterProvider(...args: unknown[]): void;
}

interface TypeboxModule {
  Type: { Unsafe(schema: Record<string, unknown>): unknown };
}

interface BudgetModel {
  maxTokens?: unknown;
  contextWindow?: unknown;
  cost?: unknown;
}

interface BudgetRequestOptions {
  maxTokens?: unknown;
  [key: string]: unknown;
}

interface BudgetContext {
  [key: string]: unknown;
}

interface BudgetedStream {
  result?: () => Promise<unknown>;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

interface BudgetTracker {
  request(model: BudgetModel, context: BudgetContext, options: BudgetRequestOptions | undefined): {
    options: BudgetRequestOptions;
    release: (result?: unknown) => void;
    fail: () => void;
  };
}

interface BudgetReservation {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pi model pricing is missing a valid ${label}`);
  }
  return value;
}

function requestTokenEstimate(context: BudgetContext): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(context);
  } catch {
    throw new Error("Pi request context cannot be deterministically serialized");
  }
  if (typeof serialized !== "string") {
    throw new Error("Pi request context cannot be deterministically serialized");
  }
  // A byte-per-token upper bound is deliberately conservative for every
  // supported language and avoids pretending that a provider tokenizer exists.
  return Buffer.byteLength(serialized, "utf8") + 1_024;
}

function modelRates(model: BudgetModel): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const raw = model.cost;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Pi model pricing is unavailable; refusing the model request");
  }
  const rows: Record<string, unknown>[] = [raw as Record<string, unknown>];
  const tiers = (raw as Record<string, unknown>).tiers;
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) throw new Error("Pi model pricing tiers are invalid");
    for (const tier of tiers) {
      if (tier === null || typeof tier !== "object" || Array.isArray(tier)) {
        throw new Error("Pi model pricing tier is invalid");
      }
      rows.push(tier as Record<string, unknown>);
      finiteNonNegative((tier as Record<string, unknown>).inputTokensAbove, "tier threshold");
    }
  }
  const rates = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const row of rows) {
    rates.input = Math.max(rates.input, finiteNonNegative(row.input, "input price"));
    rates.output = Math.max(rates.output, finiteNonNegative(row.output, "output price"));
    rates.cacheRead = Math.max(rates.cacheRead, finiteNonNegative(row.cacheRead, "cache-read price"));
    rates.cacheWrite = Math.max(rates.cacheWrite, finiteNonNegative(row.cacheWrite, "cache-write price"));
  }
  return rates;
}

function outputTokenCap(model: BudgetModel, options: BudgetRequestOptions | undefined): number {
  const modelMax = model.maxTokens;
  if (typeof modelMax !== "number" || !Number.isSafeInteger(modelMax) || modelMax < 1) {
    throw new Error("Pi model maxTokens is unavailable; refusing the model request");
  }
  const requested = options?.maxTokens;
  if (requested !== undefined &&
    (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)) {
    throw new Error("Pi request maxTokens is invalid");
  }
  return Math.min(modelMax, requested === undefined ? modelMax : requested);
}

function maximumReservation(
  model: BudgetModel,
  context: BudgetContext,
  options: BudgetRequestOptions | undefined,
): BudgetReservation {
  const inputTokens = requestTokenEstimate(context);
  const outputTokens = outputTokenCap(model, options);
  const rates = modelRates(model);
  // A provider may classify prompt tokens as input, cache-read, or cache-write.
  // Anthropic long-lived cache writes can cost 2x the regular input rate, so
  // include that multiplier in the worst-case per-token rate.
  const inputRate = Math.max(rates.input, rates.cacheRead, rates.cacheWrite, rates.input * 2);
  const costUsd = (inputTokens * inputRate + outputTokens * rates.output) / 1_000_000;
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error("Pi model pricing cannot prove a finite request cost");
  }
  return { inputTokens, outputTokens, costUsd };
}

function usageFromAssistantMessage(value: unknown): PiUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi model response is missing usage");
  }
  const usage = (value as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("Pi model response is missing usage");
  }
  const row = usage as Record<string, unknown>;
  const cost = row.cost;
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    throw new Error("Pi model response is missing cost");
  }
  return {
    inputTokens: nonNegative(row.input, "input tokens"),
    outputTokens: nonNegative(row.output, "output tokens"),
    cachedTokens: nonNegative(row.cacheRead, "cached tokens"),
    cacheWriteTokens: nonNegative(row.cacheWrite, "cache write tokens"),
    costUsd: nonNegative((cost as Record<string, unknown>).total, "total cost"),
  };
}

function createBudgetTracker(
  budget: { maxTokens: number; maxCostUsd: number },
  report: () => PiSessionReport,
): BudgetTracker {
  let spentTokens = 0;
  let spentCost = 0;
  let reservedTokens = 0;
  let reservedCost = 0;
  return {
    request(model, context, options) {
      const maximum = maximumReservation(model, context, options);
      const remainingTokens = budget.maxTokens - spentTokens - reservedTokens;
      const remainingCost = budget.maxCostUsd - spentCost - reservedCost;
      if (maximum.inputTokens + 1 > remainingTokens) {
        throw new PiBudgetPreflightError("Pi token budget preflight rejected the model request", report());
      }
      const rates = modelRates(model);
      const inputRate = Math.max(rates.input, rates.cacheRead, rates.cacheWrite, rates.input * 2);
      const inputCost = maximum.inputTokens * inputRate / 1_000_000;
      if (inputCost > remainingCost || rates.output <= 0) {
        throw new PiBudgetPreflightError("Pi cost budget preflight rejected the model request", report());
      }
      const affordableOutputTokens = Math.floor((remainingCost - inputCost) * 1_000_000 / rates.output);
      const outputTokens = Math.min(maximum.outputTokens, remainingTokens - maximum.inputTokens, affordableOutputTokens);
      if (!Number.isSafeInteger(outputTokens) || outputTokens < 1) {
        throw new PiBudgetPreflightError("Pi cost budget preflight rejected the model request", report());
      }
      const reservation = {
        inputTokens: maximum.inputTokens,
        outputTokens,
        costUsd: inputCost + outputTokens * rates.output / 1_000_000,
      };
      reservedTokens += reservation.inputTokens + reservation.outputTokens;
      reservedCost += reservation.costUsd;
      let settled = false;
      const release = (result?: unknown): void => {
        if (settled) return;
        settled = true;
        reservedTokens -= reservation.inputTokens + reservation.outputTokens;
        reservedCost -= reservation.costUsd;
        if (result === undefined) throw new Error("Pi model request completed without a response");
        const usage = usageFromAssistantMessage(result);
        spentTokens += usageTokens(usage);
        spentCost += usage.costUsd;
        if (spentTokens > budget.maxTokens || spentCost > budget.maxCostUsd) {
          throw new PiBudgetExceededError(
            spentTokens > budget.maxTokens ? "Pi token budget exceeded" : "Pi cost budget exceeded",
            report(),
          );
        }
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        reservedTokens -= reservation.inputTokens + reservation.outputTokens;
        reservedCost -= reservation.costUsd;
      };
      const cappedOptions: BudgetRequestOptions = { ...(options ?? {}), maxTokens: outputTokens };
      return { options: cappedOptions, release, fail };
    },
  };
}

export class PiBudgetPreflightError extends Error {
  override readonly name = "PiBudgetPreflightError";

  constructor(message: string, readonly report: PiSessionReport) {
    super(message);
  }
}

function budgetedModelRuntime(
  source: unknown,
  tracker: BudgetTracker,
): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return source;
  const target = source as Record<string, unknown>;
  const wrappedNames = new Set(["stream", "complete", "streamSimple", "completeSimple"]);
  const invoke = (name: string, args: unknown[]): unknown => {
    const method = target[name];
    if (typeof method !== "function") throw new Error(`Pi model runtime does not expose ${name}`);
    const model = args[0] as BudgetModel;
    const context = args[1] as BudgetContext;
    const request = tracker.request(model, context, args[2] as BudgetRequestOptions | undefined);
    const invokeArgs = [model, context, request.options, ...args.slice(3)];
    try {
      const result = Reflect.apply(method as (...values: unknown[]) => unknown, source, invokeArgs);
      if (name === "complete" || name === "completeSimple") {
        return Promise.resolve(result).then((value) => {
          request.release(value);
          return value;
        }, (error) => {
          request.fail();
          throw error;
        });
      }
      const stream = result as BudgetedStream;
      let finalized = false;
      const finalize = (value: unknown): void => {
        if (finalized) return;
        finalized = true;
        request.release(value);
      };
      const fail = (): void => {
        if (finalized) return;
        finalized = true;
        request.fail();
      };
      return {
        ...stream,
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          try {
            const iteratorFactory = stream[Symbol.asyncIterator];
            if (typeof iteratorFactory !== "function") {
              throw new Error("Pi model stream is not async iterable");
            }
            const iterator = iteratorFactory.call(stream);
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              const event: unknown = next.value;
              const row = event as Record<string, unknown>;
              if (row?.type === "done") finalize(row.message);
              else if (row?.type === "error") finalize(row.error);
              yield event;
            }
          } catch (error) {
            fail();
            throw error;
          }
        },
        async result(): Promise<unknown> {
          try {
            if (typeof stream.result !== "function") throw new Error("Pi model stream has no result method");
            const value = await stream.result.call(stream);
            finalize(value);
            return value;
          } catch (error) {
            fail();
            throw error;
          }
        },
      };
    } catch (error) {
      request.fail();
      throw error;
    }
  };
  return new Proxy(source, {
    get(current, property, receiver) {
      if (typeof property === "string" && wrappedNames.has(property)) {
        return (...args: unknown[]) => invoke(property, args);
      }
      const value = Reflect.get(current, property, receiver);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

export interface PiSdkFactoryOptions {
  modelRuntime: unknown;
  model: unknown;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  loadSdk?: () => Promise<PiSdkModule>;
  loadTypebox?: () => Promise<TypeboxModule>;
}

async function loadPiSdk(): Promise<PiSdkModule> {
  const packageName = "@earendil-works/pi-coding-agent";
  return (await import(packageName)) as unknown as PiSdkModule;
}

async function loadTypebox(): Promise<TypeboxModule> {
  const packageName = "typebox";
  return (await import(packageName)) as unknown as TypeboxModule;
}

function traceEvent(event: Record<string, unknown>): PiTraceEvent {
  const result: PiTraceEvent = { eventType: String(event.type ?? "unknown") };
  const toolName = event.toolName ?? event.tool_name;
  if (typeof toolName === "string") result.toolName = toolName;
  const toolCallId = event.toolCallId ?? event.tool_call_id;
  if (typeof toolCallId === "string") result.toolCallId = toolCallId;
  if (typeof event.isError === "boolean") result.isError = event.isError;
  return result;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Pi usage is missing a valid ${label}`);
  }
  return value;
}

function emptyUsage(): PiUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

function messageUsage(event: Record<string, unknown>): PiUsage | undefined {
  if (event.type !== "message_end") return undefined;
  const message = event.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const row = message as Record<string, unknown>;
  if (row.role !== "assistant") return undefined;
  const usage = row.usage;
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    throw new Error("Pi assistant response did not include usage");
  }
  const values = usage as Record<string, unknown>;
  const cost = values.cost;
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) {
    throw new Error("Pi assistant response did not include cost");
  }
  return {
    inputTokens: nonNegative(values.input, "input tokens"),
    outputTokens: nonNegative(values.output, "output tokens"),
    cachedTokens: nonNegative(values.cacheRead, "cached tokens"),
    cacheWriteTokens: nonNegative(values.cacheWrite, "cache write tokens"),
    costUsd: nonNegative((cost as Record<string, unknown>).total, "total cost"),
  };
}

function addUsage(target: PiUsage, usage: PiUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cachedTokens += usage.cachedTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.costUsd += usage.costUsd;
}

function usageTokens(usage: PiUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cachedTokens + usage.cacheWriteTokens;
}

function customTool(
  tool: RestrictedToolDescriptor,
  typebox: TypeboxModule,
  resultDigests: Map<string, string>,
): Record<string, unknown> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    executionMode: "sequential",
    parameters: typebox.Type.Unsafe(tool.parameters),
    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
    ) => {
      const result = await tool.execute(params, signal, { toolCallId });
      const resultDigest = createHash("sha256").update(result.text).digest("hex");
      resultDigests.set(toolCallId, resultDigest);
      return {
        content: [{ type: "text", text: result.text }],
        details: { resultDigest },
        isError: result.isError ?? false,
      };
    },
  };
}

function securityExtension(
  runtime: ExtensionRuntimeLike,
  getCompactionContext: () => string | Promise<string>,
  allowedToolNames: Set<string>,
  seenToolCallIds: Set<string>,
): Record<string, unknown> {
  const handlers = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
  handlers.set("tool_call", [
    (event) => {
      const toolName = String(event.toolName ?? "");
      if (!allowedToolNames.has(toolName)) {
        return { block: true, terminate: true, reason: "tool is outside the evolution task allowlist" };
      }
      const toolCallId = event.toolCallId;
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        return { block: true, terminate: true, reason: "tool call id is required for the operation ledger" };
      }
      if (seenToolCallIds.has(toolCallId)) {
        return { block: true, terminate: true, reason: "duplicate tool call id is not replayable" };
      }
      seenToolCallIds.add(toolCallId);
      return undefined;
    },
  ]);
  handlers.set("session_before_compact", [
    async (event) => {
      const preparation = event.preparation as Record<string, unknown> | undefined;
      const firstKeptEntryId = preparation?.firstKeptEntryId;
      const tokensBefore = preparation?.tokensBefore;
      if (typeof firstKeptEntryId !== "string" || typeof tokensBefore !== "number") {
        return { cancel: true };
      }
      return {
        compaction: {
          summary: await getCompactionContext(),
          firstKeptEntryId,
          tokensBefore,
          details: { source: "what-the-repo-evolution-ledger" },
        },
      };
    },
  ]);
  return {
    path: "<what-the-repo:evolution-security>",
    resolvedPath: "<what-the-repo:evolution-security>",
    sourceInfo: {
      path: "<what-the-repo:evolution-security>",
      source: "what-the-repo",
      scope: "temporary",
      origin: "top-level",
    },
    handlers,
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
    runtime,
  };
}

export function createPiSdkSessionFactory(options: PiSdkFactoryOptions): PiSessionFactory {
  if (options?.modelRuntime === undefined || options?.modelRuntime === null ||
    options.model === undefined || options.model === null) {
    throw new Error("Pi model runtime and model must be injected explicitly");
  }
  const model = typeof options.model === "object" && options.model !== null
    ? options.model as Record<string, unknown>
    : {};
  if (model.provider === "amazon-bedrock" || model.api === "bedrock-converse-stream") {
    throw new Error(
      "Amazon Bedrock is disabled for restricted Pi sessions until the provider client can enforce maxAttempts: 1",
    );
  }
  return async ({
    cwd,
    agentDir,
    sessionDir,
    sessionId,
    systemPrompt,
    getCompactionContext,
    persistEvent,
    tools,
    budget,
  }) => {
    if (!Number.isSafeInteger(budget?.maxTokens) || budget.maxTokens < 1 ||
      typeof budget.maxCostUsd !== "number" || !Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd <= 0) {
      throw new Error("Pi session requires finite positive token and cost budgets");
    }
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const sdk = await (options.loadSdk ?? loadPiSdk)();
    const typebox = await (options.loadTypebox ?? loadTypebox)();
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      // Every provider request must pass the product budget preflight. Pi's
      // internal retry loop would create additional network requests after a
      // single reservation, so retries stay disabled in the restricted mode.
      retry: { enabled: false, maxRetries: 0 },
      enableInstallTelemetry: false,
      enableAnalytics: false,
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
    const extensionRuntime = sdk.createExtensionRuntime();
    const allowedToolNames = new Set(tools.map((tool) => tool.name));
    const seenToolCallIds = new Set<string>();
    const resultDigests = new Map<string, string>();
    const resourceLoader = {
      getExtensions: () => ({
        extensions: [securityExtension(extensionRuntime, getCompactionContext, allowedToolNames, seenToolCallIds)],
        errors: [],
        runtime: extensionRuntime,
      }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    if (typeof sdk.SessionManager.create !== "function") {
      throw new Error("the pinned Pi SDK does not expose persistent SessionManager.create");
    }
    const sessionManager = sdk.SessionManager.create(cwd, sessionDir, { id: sessionId });
    const events: PiTraceEvent[] = [];
    const observedUsage = emptyUsage();
    const currentReport = (): PiSessionReport => ({
      sessionId,
      events: [...events],
      usage: { ...observedUsage },
    });
    const tracker = createBudgetTracker(budget, currentReport);
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      modelRuntime: budgetedModelRuntime(options.modelRuntime, tracker),
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      settingsManager,
      resourceLoader,
      sessionManager,
      noTools: "all",
      tools: tools.map((tool) => tool.name),
      customTools: tools.map((tool) => customTool(tool, typebox, resultDigests)),
    });
    if (session.sessionId !== sessionId) {
      await Promise.resolve(session.abort?.()).catch(() => undefined);
      await Promise.resolve(session.dispose?.()).catch(() => undefined);
      throw new Error(
        "Pi Session object ID is missing or does not match the persisted EvolutionTask session",
      );
    }
    let budgetMessage: string | undefined;
    let runtimeFailure: Error | undefined;
    let abortPromise: Promise<void> | undefined;
    const abortForBudget = (message: string): void => {
      if (budgetMessage) return;
      budgetMessage = message;
      abortPromise = Promise.resolve(session.abort?.()).then(() => undefined, () => undefined);
    };
    const abortForRuntimeFailure = (error: unknown): void => {
      if (runtimeFailure) return;
      runtimeFailure = error instanceof Error ? error : new Error(String(error));
      abortPromise = Promise.resolve(session.abort?.()).then(() => undefined, () => undefined);
    };
    const unsubscribe = session.subscribe?.((event) => {
      try {
        const usage = messageUsage(event);
        if (usage) {
          addUsage(observedUsage, usage);
          if (usageTokens(observedUsage) > budget.maxTokens) {
            abortForBudget("Pi token budget exceeded");
          } else if (observedUsage.costUsd > budget.maxCostUsd) {
            abortForBudget("Pi cost budget exceeded");
          }
        }
      } catch (error) {
        abortForBudget(error instanceof Error ? error.message : String(error));
      }
      try {
        if (events.length >= MAX_PI_TRACE_EVENTS) {
          throw new Error("Pi trace event count budget exceeded");
        }
        const traced = traceEvent(event);
        if (traced.toolCallId) {
          traced.operationId = traced.toolCallId;
          traced.resultDigest = resultDigests.get(traced.toolCallId);
        }
        if (utf8Bytes(JSON.stringify(traced)) > MAX_PI_TRACE_EVENT_BYTES) {
          throw new Error("Pi trace event byte budget exceeded");
        }
        persistEvent(traced);
        events.push(traced);
      } catch (error) {
        abortForRuntimeFailure(error);
      }
    });
    let disposed = false;
    const disposeSession = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      await session.dispose?.();
    };
    const rejectIdentityMismatch = async (message: string): Promise<never> => {
      await Promise.resolve(session.abort?.()).catch(() => undefined);
      await disposeSession().catch(() => undefined);
      throw new Error(message);
    };

    return {
      async prompt(input: string): Promise<PiSessionReport> {
        const started = Date.now();
        try {
          await session.prompt(input, { expandPromptTemplates: false, source: "sdk" });
        } catch (error) {
          await abortPromise;
          if (runtimeFailure) throw runtimeFailure;
          if (!budgetMessage) throw error;
        }
        if (runtimeFailure) {
          await abortPromise;
          throw runtimeFailure;
        }
        if (events.length >= MAX_PI_TRACE_EVENTS) {
          throw new Error("Pi trace event count budget exceeded before completion event");
        }
        const completed = { eventType: "pi_prompt_complete", elapsedMs: Date.now() - started };
        persistEvent(completed);
        events.push(completed);
        const stats = session.getSessionStats?.();
        if (!stats?.tokens || stats.cost === undefined) {
          throw new Error("Pi session usage statistics are unavailable");
        }
        if (session.sessionId !== sessionId) {
          return rejectIdentityMismatch(
            "Pi Session object ID is missing or does not match the persisted EvolutionTask session",
          );
        }
        if (stats.sessionId !== sessionId) {
          return rejectIdentityMismatch(
            "Pi session statistics ID is missing or does not match the persisted EvolutionTask session",
          );
        }
        const report: PiSessionReport = {
          sessionId,
          events: [...events],
          usage: {
            inputTokens: nonNegative(stats.tokens.input, "input tokens"),
            outputTokens: nonNegative(stats.tokens.output, "output tokens"),
            cachedTokens: nonNegative(stats.tokens.cacheRead, "cached tokens"),
            cacheWriteTokens: nonNegative(stats.tokens.cacheWrite, "cache write tokens"),
            costUsd: nonNegative(stats.cost, "total cost"),
          },
        };
        const finalBudgetMessage = budgetMessage ??
          (usageTokens(report.usage) > budget.maxTokens ? "Pi token budget exceeded" : undefined) ??
          (report.usage.costUsd > budget.maxCostUsd ? "Pi cost budget exceeded" : undefined);
        if (finalBudgetMessage) {
          await abortPromise;
          throw new PiBudgetExceededError(finalBudgetMessage, report);
        }
        return report;
      },
      async compact(instructions: string): Promise<void> {
        if (instructions !== await getCompactionContext()) {
          throw new Error("compaction instructions do not match the evolution task");
        }
        await session.compact?.();
      },
      async abort(): Promise<void> {
        await session.abort?.();
      },
      async dispose(): Promise<void> {
        await disposeSession();
      },
    };
  };
}
