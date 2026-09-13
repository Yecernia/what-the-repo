import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test, { mock } from "node:test";
import { createModelRuntime, streamWithProviderPermit } from "./model-runtime.js";
import { createWorkerDiagnostics } from "./worker-diagnostics.js";
import { withProviderPermit } from "./model-runtime.js";
import { LocalProviderUsageBudget, ProviderBudgetExceededError, type ProviderUsageReport } from "./provider-budget.js";
import { createModels } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { normalizeSettings } from "../domain/conversation.js";
import { resolveDeploymentProvider, resolveProvider, FREE_SELECTOR } from "./provider-resolver.js";

async function captureOpenAiRequest(
  config: Parameters<typeof createModelRuntime>[0],
  reasoning: "low" | "medium" | "high",
): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  const lookup = mock.method(dns, "lookup", (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as typeof dns.lookup);
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const first = JSON.stringify({
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: config.modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    });
    const last = JSON.stringify({
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: config.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return new Response(`data: ${first}\n\ndata: ${last}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const runtime = createModelRuntime(config);
    const stream = runtime.models.streamSimple(runtime.model, {
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }],
    }, { apiKey: config.apiKey, reasoning });
    for await (const event of stream) {
      assert.notEqual(event.type, "error", "The mocked transport must run before checking request fields");
    }
  } finally {
    globalThis.fetch = originalFetch;
    lookup.mock.restore();
  }
  assert.ok(Object.keys(requestBody).length, "Expected a captured request");
  return requestBody;
}

test("DeepSeek deployment sends the documented output-limit field without weakening reasoning", async () => {
  const config = resolveDeploymentProvider({
    providerId: "deepseek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash", apiKey: "test-key", connectionId: "analysis-deployment",
  });
  assert.ok(config);
  const body = await captureOpenAiRequest(config, "medium");
  assert.equal(body.max_tokens, 384_000);
  assert.equal("max_completion_tokens" in body, false);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("a known builtin model applies explicit token limits to requests and budget reservations", async () => {
  const config = { provider: "deepseek", connectionId: "bounded-feedback", baseUrl: "https://api.deepseek.com",
    apiKey: "test-key", model: "deepseek-v4-flash", modelId: "deepseek-v4-flash", modelSelector: "test",
    api: "openai-completions", builtin: true, maxOutputTokens: 2048, contextWindow: 16000 };
  const body = await captureOpenAiRequest(config, "low");
  assert.equal(body.max_tokens ?? body.max_completion_tokens, 2048);
  let reservation = 0;
  const runtime = createModelRuntime(config, { ownerId: "owner", providerBudget: { async acquire(input) {
    reservation = input.estimatedCostUsd ?? 0;
    return { async release() {} };
  } } });
  await withProviderPermit(runtime, undefined, async () => ({ usage: { input: 1 } }));
  const cost = runtime.model.cost;
  assert.equal(reservation, (16000 * (cost.input + cost.cacheRead) + 2048 * cost.output) / 1_000_000);
});

test("DeepSeek free access preserves the same endpoint compatibility and thinking mapping", async () => {
  type Input = Parameters<typeof resolveProvider>[0];
  const config = resolveProvider({
    config: { freeProviderBaseUrl: "https://api.deepseek.com", freeProviderModel: "deepseek-v4-flash", freeProviderApiKey: "test-key" } as Input["config"],
    store: {} as Input["store"], owner: { kind: "guest", owner_id: "test-guest" },
    settings: normalizeSettings({ thinking_level: "medium" }), selectedModel: FREE_SELECTOR,
  });
  assert.ok(config);
  const body = await captureOpenAiRequest(config, "medium");
  assert.equal(body.max_tokens, 384_000);
  assert.equal("max_completion_tokens" in body, false);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(createModelRuntime(config).model.cost, { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 });
});

test("explicit DeepSeek v4.1 beta analysis preserves Flash thinking and output parameters", async () => {
  const config = resolveDeploymentProvider({ providerId: "deepseek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4.1-flash-expires-on-0910", apiKey: "test-key", connectionId: "platform-analysis" });
  assert.ok(config);
  const body = await captureOpenAiRequest(config, "medium");
  assert.equal(body.model, "deepseek-v4.1-flash-expires-on-0910");
  assert.equal(body.max_tokens, 384_000);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(createModelRuntime(config).model.cost, { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 });
});

test("official DeepSeek estimates use current peak rates for reservations without changing model settings", async () => {
  const config = resolveDeploymentProvider({ providerId: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", apiKey: "test-key", connectionId: "analysis-deployment" });
  assert.ok(config);
  let reservation = 0;
  const runtime = createModelRuntime(config, { ownerId: "owner", providerBudget: { async acquire(input) {
    reservation = input.estimatedCostUsd ?? 0;
    return { async release() {} };
  } } });
  assert.deepEqual(runtime.model.cost, { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 });
  assert.equal(runtime.model.maxTokens, 384_000);
  assert.equal(runtime.model.contextWindow, 1_000_000);
  await withProviderPermit(runtime, undefined, async () => ({ usage: { input: 1 } }));
  assert.ok(Math.abs(reservation - 0.499968) < 1e-9);
  const relay = resolveDeploymentProvider({ providerId: "deepseek", baseUrl: "https://relay.example/v1", model: "deepseek-v4-flash", apiKey: "test-key", connectionId: "relay" });
  assert.ok(relay);
  assert.deepEqual(relay.cost, getBuiltinModels("deepseek").find((model) => model.id === "deepseek-v4-flash")!.cost,
    "A relay retains its own catalog estimate instead of the official endpoint override");
});

test("a known builtin model honors explicit cost metadata as an unknown model does", () => {
  const config = { provider: "deepseek", connectionId: "cost-override", baseUrl: "https://api.deepseek.com", apiKey: "test-key",
    model: "deepseek-v4-flash", modelId: "deepseek-v4-flash", modelSelector: "test", api: "openai-completions", builtin: true,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
  assert.deepEqual(createModelRuntime(config).model.cost, config.cost);
});

test("Pi builtin provider keeps its adapter while honoring a normal GLM API endpoint", () => {
  const runtime = createModelRuntime({
    provider: "zai",
    connectionId: "glm-personal",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKey: "test-key",
    model: "glm-5.2",
    modelId: "glm-5.2",
    modelSelector: "provider:glm-personal:glm-5.2",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevel: "medium",
  });

  assert.equal(runtime.model.provider, "zai");
  assert.equal(runtime.model.api, "openai-completions");
  assert.equal(runtime.model.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(
    runtime.model.compat && "thinkingFormat" in runtime.model.compat
      ? runtime.model.compat.thinkingFormat
      : undefined,
    "zai",
  );
});

test("Pi adapter accepts a Provider model that is newer than its bundled catalog", () => {
  const runtime = createModelRuntime({
    provider: "zai",
    adapterProvider: "zai",
    connectionId: "glm-new-model",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "test-key",
    model: "glm-5.3",
    modelId: "glm-5.3",
    modelSelector: "provider:glm-new-model:glm-5.3",
    api: "openai-completions",
    builtin: true,
    reasoning: false,
    thinkingLevel: "off",
  });
  assert.equal(runtime.model.id, "glm-5.3");
  assert.equal(runtime.model.provider, "zai");
  assert.equal(runtime.model.api, "openai-completions");
  assert.equal(runtime.model.reasoning, false);
  assert.equal(runtime.model.thinkingLevelMap, undefined);
});

test("verified GLM-5.3 capability sends its supported ZAI effort", async () => {
  const body = await captureOpenAiRequest({
    provider: "zai",
    adapterProvider: "zai",
    connectionId: "glm-5-3",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKey: "test-key",
    model: "glm-5.3",
    modelId: "glm-5.3",
    modelSelector: "provider:glm-5-3:glm-5.3",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    compat: { thinkingFormat: "zai", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    thinkingLevel: "low",
  }, "low");
  assert.deepEqual(body.thinking, { type: "enabled", clear_thinking: false });
  assert.equal(body.reasoning_effort, "low");
});

test("Kimi K3 OpenAI compatibility sends its documented effort field", async () => {
  const body = await captureOpenAiRequest({
    provider: "kimi-coding-openai",
    connectionId: "kimi-k3-openai",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiKey: "test-key",
    model: "k3",
    modelId: "k3",
    modelSelector: "provider:kimi-k3-openai:k3",
    api: "openai-completions",
    builtin: false,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true,
      deferredToolsMode: "kimi",
    },
    thinkingLevel: "low",
  }, "low");
  assert.equal(body.reasoning_effort, "low");
  assert.equal("thinking" in body, false);
});

test("Hunyuan hy4 preview does not send an unsupported reasoning_effort", async () => {
  const body = await captureOpenAiRequest({
    provider: "deepseek",
    adapterProvider: "deepseek",
    connectionId: "hy4-preview",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    apiKey: "test-key",
    model: "hy4-preview",
    modelId: "hy4-preview",
    modelSelector: "provider:hy4-preview:hy4-preview",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevelMap: { off: "disabled", minimal: null, low: "enabled", medium: null, high: null, xhigh: null, max: null },
    compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    thinkingLevel: "low",
  }, "low");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal("reasoning_effort" in body, false);
});

test("Doubao Seed 2.0 capability sends the documented effort values", async () => {
  const body = await captureOpenAiRequest({
    provider: "zai",
    adapterProvider: "zai",
    connectionId: "doubao-seed-2",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "test-key",
    model: "doubao-seed-2.0-pro",
    modelId: "doubao-seed-2.0-pro",
    modelSelector: "provider:doubao-seed-2:doubao-seed-2.0-pro",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    compat: { thinkingFormat: "openai", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    thinkingLevel: "high",
  }, "high");
  assert.equal(body.reasoning_effort, "high");
  assert.equal("thinking" in body, false);
});

test("Qwen thinking models use the enable_thinking wire flag", async () => {
  const body = await captureOpenAiRequest({
    provider: "zai",
    adapterProvider: "zai",
    connectionId: "qwen-coder",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    apiKey: "test-key",
    model: "qwen3-coder-plus",
    modelId: "qwen3-coder-plus",
    modelSelector: "provider:qwen-coder:qwen3-coder-plus",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevelMap: { off: "disabled", minimal: null, low: "enabled", medium: null, high: null, xhigh: null, max: null },
    compat: { thinkingFormat: "qwen", supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    thinkingLevel: "low",
  }, "low");
  assert.equal(body.enable_thinking, true, JSON.stringify(body));
  assert.equal("reasoning_effort" in body, false);
});

test("Hunyuan hy3 preview maps low/high to reasoning_effort", async () => {
  const body = await captureOpenAiRequest({
    provider: "deepseek",
    adapterProvider: "deepseek",
    connectionId: "hy3",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    apiKey: "test-key",
    model: "hy3",
    modelId: "hy3",
    modelSelector: "provider:hy3:hy3",
    api: "openai-completions",
    builtin: true,
    reasoning: true,
    thinkingLevelMap: { off: "disabled", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
    compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    thinkingLevel: "high",
  }, "high");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("Qwen plan adapter carries its explicit wire format to a new upstream model", () => {
  const runtime = createModelRuntime({
    provider: "qwen-coding-plan-cn",
    adapterProvider: "qwen-token-plan-cn",
    connectionId: "qwen-coding",
    baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
    apiKey: "test-key",
    model: "qwen3-coder-plus",
    modelId: "qwen3-coder-plus",
    modelSelector: "provider:qwen-coding:qwen3-coder-plus",
    api: "openai-completions",
    builtin: true,
    reasoning: false,
    compat: {
      thinkingFormat: "qwen",
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
    thinkingLevel: "off",
  });
  assert.equal(runtime.model.id, "qwen3-coder-plus");
  assert.equal(runtime.model.provider, "qwen-coding-plan-cn");
  assert.equal(runtime.model.reasoning, false);
  assert.equal(
    runtime.model.compat && "thinkingFormat" in runtime.model.compat
      ? runtime.model.compat.thinkingFormat
      : undefined,
    "qwen",
  );
});

test("custom Anthropic-compatible runtime uses Pi Messages transport for unknown models", () => {
  const runtime = createModelRuntime({
    provider: "zai-anthropic-cn",
    connectionId: "glm-anthropic",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKey: "test-key",
    model: "glm-new-anthropic",
    modelId: "glm-new-anthropic",
    modelSelector: "provider:glm-anthropic:glm-new-anthropic",
    api: "anthropic-messages",
    builtin: false,
    reasoning: false,
    compat: {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
      supportsTemperature: true,
      supportsStrictTools: false,
      supportsToolReferences: false,
    },
    thinkingLevel: "off",
  });
  assert.equal(runtime.model.api, "anthropic-messages");
  assert.equal(runtime.model.provider, "zai-anthropic-cn");
  assert.equal(runtime.model.baseUrl, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(runtime.model.reasoning, false);
});

test("custom OpenAI-compatible runtime preserves a provider-specific api-key header", async () => {
  const runtime = createModelRuntime({
    provider: "xiaomi",
    connectionId: "mimo-api",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKey: "test-key",
    model: "mimo-new-model",
    modelId: "mimo-new-model",
    modelSelector: "provider:mimo-api:mimo-new-model",
    api: "openai-completions",
    builtin: false,
    reasoning: false,
    authHeader: "api-key",
    thinkingLevel: "off",
  });
  const auth = await runtime.models.getAuth(runtime.model, { apiKey: "test-key" });
  assert.equal(auth?.auth.apiKey, "test-key");
  assert.equal(auth?.auth.headers?.["api-key"], "test-key");
});

test("custom Anthropic runtime can add a provider-specific Bearer header", async () => {
  const runtime = createModelRuntime({
    provider: "hunyuan-tokenhub-anthropic-cn",
    connectionId: "hunyuan-anthropic",
    baseUrl: "https://tokenhub.tencentmaas.com",
    apiKey: "test-key",
    model: "hunyuan-anthropic-model",
    modelId: "hunyuan-anthropic-model",
    modelSelector: "provider:hunyuan-anthropic:hunyuan-anthropic-model",
    api: "anthropic-messages",
    builtin: false,
    reasoning: false,
    authHeader: "authorization",
    thinkingLevel: "off",
  });
  const auth = await runtime.models.getAuth(runtime.model, { apiKey: "test-key" });
  assert.equal(auth?.auth.headers?.authorization, "Bearer test-key");
});

test("TokenHub plan runtime keeps provider-default thinking for an unknown model", () => {
  const runtime = createModelRuntime({
    provider: "hunyuan-token-plan-cn",
    connectionId: "hunyuan-token",
    baseUrl: "https://api.lkeap.cloud.tencent.com/plan/v3",
    apiKey: "test-key",
    model: "hunyuan-new-model",
    modelId: "hunyuan-new-model",
    modelSelector: "provider:hunyuan-token:hunyuan-new-model",
    api: "openai-completions",
    builtin: false,
    reasoning: false,
    compat: {
      thinkingFormat: "deepseek",
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
    },
    thinkingLevel: "off",
  });
  assert.equal(runtime.model.id, "hunyuan-new-model");
  assert.equal(runtime.model.reasoning, false);
  assert.equal(
    runtime.model.compat && "thinkingFormat" in runtime.model.compat
      ? runtime.model.compat.thinkingFormat
      : undefined,
    "deepseek",
  );
});

test("custom relay runtime keeps the Pi thinking map for a same-name model", () => {
  const runtime = createModelRuntime({
    provider: "custom",
    connectionId: "relay-gpt",
    baseUrl: "https://relay.example/v1",
    apiKey: "test-key",
    model: "gpt-5.4",
    modelId: "gpt-5.4",
    modelSelector: "provider:relay-gpt:gpt-5.4",
    api: "openai-completions",
    builtin: false,
    reasoning: true,
    thinkingLevelMap: { minimal: "low", high: "high" },
    thinkingLevel: "high",
  });
  assert.equal(runtime.model.reasoning, true);
  assert.deepEqual(runtime.model.thinkingLevelMap, { minimal: "low", high: "high" });
});

test("provider runtime checks the owner budget before contacting the provider", async () => {
  const faux = fauxProvider({ provider: "budget-runtime-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = {
    models,
    model: faux.getModel(),
    ownerId: "owner-budget-runtime",
    providerBudget: new LocalProviderUsageBudget({
      maxCallsPerMinute: 1,
      maxCostUsdPerDay: 1,
      minimumReservationUsd: 0.01,
    }),
  };
  let calls = 0;
  const operation = async () => {
    calls += 1;
    return {
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.001 },
      },
    };
  };
  await withProviderPermit(runtime, undefined, operation);
  await assert.rejects(
    () => withProviderPermit(runtime, undefined, operation),
    (error: unknown) => error instanceof ProviderBudgetExceededError,
  );
  assert.equal(calls, 1);
});

test("provider budget record failures do not replace a successful provider result", async () => {
  const faux = fauxProvider({ provider: "budget-record-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  let releaseCalls = 0;
  const runtime = {
    models,
    model: faux.getModel(),
    ownerId: "owner-budget-record",
    providerBudget: {
      async acquire() {
        return {
          async release() {
            releaseCalls += 1;
            throw new Error("usage store unavailable");
          },
        };
      },
    },
  };
  const result = await withProviderPermit(runtime, undefined, async () => ({
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
    value: "provider-result",
  }));
  assert.equal((result as { value: string }).value, "provider-result");
  assert.equal(releaseCalls, 1);
});

test("legacy built-in provider endpoints are ignored during settings normalization", () => {
  const settings = normalizeSettings({
    model: "provider:openai-personal:gpt-4.1-mini",
    connections: [{
      connection_id: "openai-personal",
      provider: "openai",
      label: "旧连接",
      base_url: "https://attacker.example/v1",
      custom_models: [],
    }],
  });
  assert.equal(settings.connections[0]?.base_url, null);
});

test("custom provider runtime exposes a fenced fetch that rejects private URLs before network I/O", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const runtime = createModelRuntime({
      provider: "custom",
      connectionId: "custom-private-test",
      baseUrl: "https://provider.example/v1",
      apiKey: "test-key",
      model: "local-model",
      modelId: "local-model",
      modelSelector: "provider:custom-private-test:local-model",
      api: "openai-completions",
      builtin: false,
      thinkingLevel: "off",
    });
    assert.ok(runtime.fetch);
    await assert.rejects(() => runtime.fetch!("https://127.0.0.1/v1/models"), /outbound_url_blocked/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("custom provider keeps direct Models calls behind the fenced fetch", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const runtime = createModelRuntime({
      provider: "custom",
      connectionId: "custom-direct-models-test",
      baseUrl: "https://127.0.0.1/v1",
      apiKey: "test-key",
      model: "local-model",
      modelId: "local-model",
      modelSelector: "provider:custom-direct-models-test:local-model",
      api: "openai-completions",
      builtin: false,
      thinkingLevel: "off",
    });
    const result = await runtime.models.completeSimple(runtime.model, {
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }],
    }, { apiKey: runtime.apiKey, maxTokens: 1, fetch: globalThis.fetch });
    assert.equal(result.stopReason, "error");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelled HTTP streaming without final usage retains the reservation and reports uncertainty", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const abort = new AbortController();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { content: "partial response" }, finish_reason: null }] };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      init?.signal?.addEventListener("abort", () => controller.error(new Error("request aborted")), { once: true });
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const budget = new LocalProviderUsageBudget({ maxCallsPerMinute: 10, maxCostUsdPerDay: 0.015, minimumReservationUsd: 0.01 });
  const reports: ProviderUsageReport[] = [];
  const runtime = createModelRuntime({ provider: "custom", connectionId: "cancel-test", baseUrl: "https://provider.example/v1",
    apiKey: "test-key", model: "test", modelId: "test", modelSelector: "test", api: "openai-completions", builtin: false, thinkingLevel: "off" },
  { ownerId: "owner", providerBudget: { async acquire(input) {
    const permit = await budget.acquire(input);
    return { eventId: permit.eventId, async release(report) { if (report) reports.push(report); await permit.release(report); } };
  } } });
  const diagnostics = createWorkerDiagnostics();
  const context = { messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }] };
  const row = diagnostics.request(context);
  try {
    for await (const event of streamWithProviderPermit(runtime, runtime.model, context, { apiKey: runtime.apiKey, signal: abort.signal }, row)) {
      if (event.type === "text_delta") abort.abort();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(row.status, "aborted");
    assert.equal(row.usage?.usageKnown, false);
    assert.equal(reports[0]?.status, "cancelled");
    assert.equal(reports[0]?.usageKnown, false);
    await assert.rejects(() => budget.acquire({ ownerId: "owner", provider: "custom", model: "test" }), ProviderBudgetExceededError);
  } finally { diagnostics.finish(); }
});

test("cancellation after admission but before either provider entry releases a known zero reservation", async () => {
  for (const streaming of [false, true]) {
    const abort = new AbortController();
    const reports: ProviderUsageReport[] = [];
    const faux = fauxProvider({ provider: "pre-call-cancel" });
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = { models, model: faux.getModel(), ownerId: "owner", providerBudget: { async acquire() {
      abort.abort(new Error("cancel before model"));
      return { async release(report?: ProviderUsageReport) { if (report) reports.push(report); } };
    } } };
    let called = false;
    if (streaming) {
      for await (const event of streamWithProviderPermit(runtime, runtime.model, { messages: [] }, { signal: abort.signal })) {
        assert.equal(event.type, "error");
      }
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      await assert.rejects(() => withProviderPermit(runtime, abort.signal, async () => { called = true; }), /cancel before model/);
    }
    assert.equal(called, false);
    assert.deepEqual(reports.map((r) => [r.usageKnown, r.costUsd, r.status]), [[true, 0, "cancelled"]]);
  }
});

test("a failed provider operation preserves usage returned with its error", async () => {
  const faux = fauxProvider({ provider: "failed-usage" });
  const models = createModels(); models.setProvider(faux.provider);
  const reports: ProviderUsageReport[] = [];
  const runtime = { models, model: faux.getModel(), ownerId: "owner", providerBudget: { async acquire() {
    return { async release(report?: ProviderUsageReport) { if (report) reports.push(report); } };
  } } };
  await assert.rejects(() => withProviderPermit(runtime, undefined, async () => {
    throw Object.assign(new Error("failed after response"), { usage: { input: 3, output: 7, cost: { total: 0.004 } } });
  }), /failed after response/);
  assert.deepEqual(reports.map((r) => [r.usageKnown, r.outputTokens, r.costUsd, r.status]), [[true, 7, 0.004, "failed"]]);
});

test("provider diagnostics distinguish errors, stops and truncation and retain only effective token limits", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const originalFetch = globalThis.fetch;
  const diagnostics = createWorkerDiagnostics();
  let calls = 0;
  const wireLimits: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    wireLimits.push(body.max_tokens ?? body.max_completion_tokens);
    if (calls === 1) return new Response(JSON.stringify({ error: { message: "test retry" } }), { status: 500, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
    const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { content: "safe test" }, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: calls === 3 ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const runtime = createModelRuntime({ provider: "custom", connectionId: "diagnostic-test", baseUrl: "https://provider.example/v1", apiKey: "test-key", model: "test", modelId: "test", modelSelector: "test", api: "openai-completions", builtin: false, thinkingLevel: "off" });
    const context = { messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }] };
    const failed = diagnostics.request(context);
    const firstStream = streamWithProviderPermit(runtime, runtime.model, context, { apiKey: runtime.apiKey }, failed);
    for await (const _event of firstStream) { /* The adapter settles HTTP 500 without an implicit retry. */ }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(failed.transport.map((attempt) => attempt.status), [500]);
    assert.equal(failed.status, "error");
    assert.equal(failed.completionReason, "error");
    const row = diagnostics.request(context);
    const stream = streamWithProviderPermit(runtime, runtime.model, context, {
      apiKey: runtime.apiKey, maxTokens: 32,
      onPayload: (payload) => ({ ...payload as Record<string, unknown>, max_completion_tokens: 17 }),
    }, row);
    for await (const _event of stream) { /* Mocked HTTP only. */ }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(row.transport.map((attempt) => attempt.status), [200]);
    assert.equal(row.sequence, 2);
    assert.equal(calls, 2);
    assert.equal(row.status, "success");
    assert.equal(row.completionReason, "stop");
    assert.deepEqual(row.requestLimits, { modelMaxTokens: runtime.model.maxTokens, wireMaxTokens: 17, wireTokenLimits: { max_completion_tokens: 17 } });
    assert.equal(wireLimits[1], 17);
    assert.ok(row.contentEvents > 0);
    assert.ok(row.lastContentMs! >= row.firstContentMs!);
    assert.doesNotMatch(JSON.stringify(row), /test-key|safe test|ping/);
    const builtin = createModelRuntime({ provider: "deepseek", connectionId: "builtin-diagnostic-test", baseUrl: "https://api.deepseek.com", apiKey: "test-key", model: "deepseek-v4-flash", modelId: "deepseek-v4-flash", modelSelector: "test", api: "openai-completions", builtin: true, thinkingLevel: "off" });
    const builtinRow = diagnostics.request(context);
    const builtinStream = streamWithProviderPermit(builtin, builtin.model, context, { apiKey: builtin.apiKey }, builtinRow);
    for await (const _event of builtinStream) { /* Builtins use the same mocked default fetch. */ }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(builtinRow.transport.map((attempt) => attempt.status), [200]);
    assert.equal(builtinRow.status, "success");
    assert.equal(builtinRow.completionReason, "length");
    assert.equal(builtinRow.requestLimits?.wireMaxTokens, wireLimits[2]);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; diagnostics.finish(); }
});

test("transport failures retain an allowlisted cause without leaking provider messages or retrying", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const cases = [
    { error: new TypeError("secret endpoint", { cause: Object.assign(new Error("secret header"), { code: "ECONNRESET" }) }), expected: "ECONNRESET" },
    { error: Object.assign(new Error("secret source"), { code: "untrusted-private-key" }), expected: "transport_error" },
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { throw cases[calls++]!.error; });
  const runtime = createModelRuntime({ provider: "custom", connectionId: "transport-test", baseUrl: "https://provider.example/v1", apiKey: "test-key",
    model: "test", modelId: "test", modelSelector: "test", api: "openai-completions", builtin: false, thinkingLevel: "off" });
  const diagnostics = createWorkerDiagnostics();
  try {
    for (const item of cases) {
      const context = { messages: [{ role: "user" as const, content: "ping", timestamp: Date.now() }] };
      const row = diagnostics.request(context);
      for await (const _event of streamWithProviderPermit(runtime, runtime.model, context, { apiKey: runtime.apiKey }, row)) { /* No real network. */ }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(row.transport.length, 1);
      assert.equal(row.transport[0]?.status, null);
      assert.equal(row.transport[0]?.errorCode, item.expected);
      assert.equal(row.usage?.usageKnown, false);
      assert.doesNotMatch(JSON.stringify(row), /secret|untrusted-private|test-key/);
    }
    assert.equal(calls, cases.length);
  } finally { diagnostics.finish(); }
});

test("GA DeepSeek Flash analysis and saved free selector preserve the real model and wire limits", async () => {
  type Input = Parameters<typeof resolveProvider>[0];
  const analysis = resolveDeploymentProvider({ providerId: "deepseek", baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash", apiKey: "test-key", connectionId: "analysis-deployment" });
  const free = resolveProvider({
    config: { freeProviderBaseUrl: "https://api.deepseek.com", freeProviderModel: "deepseek-flash", freeProviderApiKey: "test-key" } as Input["config"],
    store: {} as Input["store"], owner: { kind: "guest", owner_id: "test-guest" },
    settings: normalizeSettings({ thinking_level: "medium", model: "free:deepseek-v4-flash" }), selectedModel: "free:deepseek-v4-flash",
  });
  for (const config of [analysis, free]) {
    assert.ok(config);
    assert.equal(config.modelId, "deepseek-flash");
    const runtime = createModelRuntime(config);
    assert.equal(runtime.model.contextWindow, 1_000_000);
    assert.equal(runtime.model.maxTokens, 384_000);
    assert.deepEqual(runtime.model.cost, { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 });
    const body = await captureOpenAiRequest(config, "medium");
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.max_tokens, 384_000);
    assert.equal("max_completion_tokens" in body, false);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "high");
  }
});
