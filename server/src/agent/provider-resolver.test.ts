import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  builtinModelOptions,
  catalogModelsForConnection,
  hasTrustedProviderModels,
  piProviderId,
  providerFamilies,
} from "./provider-resolver.js";
import {
  filterLikelyConversationalModelIds,
  providerModelIds,
  isLikelyConversationalModelId,
  providerPreset,
  CONFIGURABLE_PROVIDER_IDS,
} from "./provider-catalog.js";

test("model discovery keeps chat and vision models but filters task-specific models", () => {
  const ids = [
    "doubao-pro-32k-chat",
    "deepseek-vl2",
    "qwen2.5-vl-72b-instruct",
    "hunyuan-turbos-vision-video-20250728",
    "video-understanding-v1",
    "doubao-seedance-1.0",
    "doubao-seedream-4.0",
    "hunyuan-video-v1.5",
    "kling-video-v3",
    "vidu-video-q3-turbo",
    "hunyuan-music-generation",
    "text-to-image-v3",
    "bge-embedding-v1",
    "bge-m3",
    "bge-reranker-v2",
    "doubao-tts",
  ];
  assert.equal(isLikelyConversationalModelId("deepseek-vl2"), true);
  assert.equal(isLikelyConversationalModelId("qwen-multimodal-chat"), true);
  assert.deepEqual(filterLikelyConversationalModelIds(ids), [
    "doubao-pro-32k-chat",
    "deepseek-vl2",
    "qwen2.5-vl-72b-instruct",
    "hunyuan-turbos-vision-video-20250728",
    "video-understanding-v1",
  ]);
});

test("model filtering handles current generator families and namespaced IDs without excluding new chat models", () => {
  for (const id of [
    "cogview-4", "cogView-4-250304", "hy-3d-3.0", "hy-3d-3.1",
    "yt-video-humanactor", "yt-video-fx", "speech-2.6-hd", "speech-02-turbo",
    "Qwen/Qwen-Image", "vendor/seedance-2.0", "vendor/embedding-v1",
    "tripo-3d-3.1", "tripo-3d-rigging-check", "wand-dubbing-clone-v2",
    "wand-dubbing-sts-v1", "wand-vega-image-lite", "vd-video-q3-pro",
    "pixverse-video-c1", "hy-world2-scene", "hy-world2-panorama", "hi3d-2.1", "indextts-2",
    "doubao-seaweed-241128", "doubao-seededit-3-0-i2i", "doubao-seed3d-2-0", "hyper3d-gen2-260112",
  ]) assert.equal(isLikelyConversationalModelId(id), false, id);
  const chatIds = [
    "vendor/new-chat-v1", "Qwen/Qwen3-VL-32B-Instruct", "youtu-vita",
    "hy-vision-2.0-instruct", "vendor/video-understanding-v1",
    "hunyuan-turbos-vision-video-20250728", "speech-assistant-chat",
    "doubao-pro-32k-functioncall", "doubao-seed-character", "deepseek-v4.1-experimental",
  ];
  assert.deepEqual(filterLikelyConversationalModelIds(chatIds), chatIds);
});

test("discovery uses availability and output metadata before limiting IDs", () => {
  const data = [
    ...Array.from({ length: 110 }, (_, i) => ({ id: `old-chat-${i}`, status: "Shutdown" })),
    { id: "opaque-image-service", modalities: { input_modalities: ["text"], output_modalities: ["image"] } },
    { id: "opaque-3d-service", modalities: { output_modalities: ["three_d"] } },
    { id: "utility", task_type: "Embedding" },
    { id: "speech-transcriber", modalities: { input_modalities: ["audio"], output_modalities: ["text"] } },
    { id: "old-functioncall", status: "Shutdown" },
    { id: "functioncall-chat", modalities: { input_modalities: ["text"], output_modalities: ["text"] } },
    { id: "vision-chat", modalities: { input_modalities: ["text", "video"], output_modalities: ["text"] } },
    { id: "retiring-chat", status: "Retiring" },
    { id: "pre-offline-chat", status: "pre-offline" },
    { id: "hidden-image-id", name: "WAND-Vega-Image1.0 Lite" },
  ];
  assert.deepEqual(providerModelIds({ data }), ["functioncall-chat", "vision-chat", "retiring-chat", "pre-offline-chat"]);
  // The generic name fallback remains compatible with /models variants.
  assert.deepEqual(providerModelIds({ models: [{ model: "new-chat" }, "new-chat"] }), ["new-chat"]);
  assert.deepEqual(providerModelIds({ data: [{ id: 'hy4-preview' }, { id: 'opaque-task' }, { id: 'opaque-chat', modalities: { output_modalities: ['text'] } }] }, 'hunyuan-tokenhub-api-cn'), ['hy4-preview', 'opaque-chat']);
});

test("provider catalog exposes domestic families and Pi-backed plan variants", () => {
  const families = providerFamilies().map((family) => family.id);
  for (const family of ["deepseek", "qwen", "glm", "kimi", "minimax", "mimo", "doubao", "hunyuan", "custom"]) {
    assert.ok(families.includes(family), family);
  }
  assert.equal(families.includes("openai"), false);
  assert.equal(families.includes("anthropic"), false);
  assert.equal(families.includes("google"), false);
  assert.equal(families.includes("xai"), false);
  assert.equal(CONFIGURABLE_PROVIDER_IDS.includes("zai"), false);
  assert.equal(CONFIGURABLE_PROVIDER_IDS.includes("zai-coding-global"), false);
  assert.equal(CONFIGURABLE_PROVIDER_IDS.includes("qwen-token-plan"), false);
  assert.equal(providerPreset("zai-coding-global")?.variant_label, "已停用的境外 Coding Plan");
  assert.equal(providerPreset("qwen-token-plan-cn")?.base_url, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerPreset("qwen-token-plan-personal-cn")?.base_url, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerPreset("qwen-token-plan-team-cn")?.base_url, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerPreset("qwen-coding-plan-cn")?.base_url, "https://coding.dashscope.aliyuncs.com/v1");
  assert.equal(providerPreset("qwen-token-plan-anthropic-cn")?.api, "anthropic-messages");
  assert.equal(providerPreset("qwen-coding-plan-anthropic-cn")?.base_url, "https://coding.dashscope.aliyuncs.com/apps/anthropic");
  assert.equal(providerPreset("minimax-token-plan-cn")?.base_url, "https://api.minimaxi.com/anthropic");
  assert.equal(providerPreset("minimax-openai-cn")?.base_url, "https://api.minimaxi.com/v1");
  assert.equal(providerPreset("minimax-token-plan-openai-cn")?.base_url, "https://api.minimaxi.com/v1");
  assert.equal(providerPreset("xiaomi-anthropic-cn")?.api, "anthropic-messages");
  assert.equal(providerPreset("zai-anthropic-cn")?.base_url, "https://open.bigmodel.cn/api/anthropic");
  assert.equal(providerPreset("kimi-coding-openai")?.base_url, "https://api.kimi.com/coding/v1");
  assert.equal(providerPreset("doubao-coding-plan-cn")?.base_url, "https://ark.cn-beijing.volces.com/api/coding/v3");
  assert.equal(providerPreset("doubao-agent-plan-cn")?.base_url, "https://ark.cn-beijing.volces.com/api/plan/v3");
  assert.equal(providerPreset("hunyuan-token-plan-cn")?.base_url, "https://api.lkeap.cloud.tencent.com/plan/v3");
  assert.equal(providerPreset("hunyuan-tokenhub-anthropic-cn")?.base_url, "https://tokenhub.tencentmaas.com");
  assert.equal(providerPreset("hunyuan-tokenhub-anthropic-cn")?.api, "anthropic-messages");
  assert.equal(providerPreset("hunyuan-token-plan-enterprise-cn")?.base_url, "https://tokenhub.tencentmaas.com/plan/v3");
  assert.equal(providerPreset("hunyuan-coding-plan-cn")?.base_url, "https://api.lkeap.cloud.tencent.com/coding/v3");
  for (const id of [
    "qwen-coding-plan-cn",
    "qwen-token-plan-anthropic-cn",
    "qwen-token-plan-personal-anthropic-cn",
    "qwen-token-plan-team-anthropic-cn",
    "qwen-coding-plan-anthropic-cn",
    "qwen-token-plan-personal-cn",
    "qwen-token-plan-team-cn",
    "minimax-token-plan-cn",
    "minimax-openai-cn",
    "minimax-token-plan-openai-cn",
    "xiaomi-anthropic-cn",
    "xiaomi-token-plan-anthropic-cn",
    "zai-anthropic-cn",
    "kimi-coding-openai",
    "doubao-coding-plan-cn",
    "doubao-agent-plan-cn",
    "hunyuan-tokenhub-api-cn",
    "hunyuan-tokenhub-anthropic-cn",
    "hunyuan-token-plan-cn",
    "hunyuan-token-plan-enterprise-cn",
    "hunyuan-coding-plan-cn",
  ] as const) {
    assert.equal(CONFIGURABLE_PROVIDER_IDS.includes(id), true, id);
  }
  const qwenCompat = providerPreset("qwen-coding-plan-cn")?.compat;
  assert.equal(qwenCompat && "thinkingFormat" in qwenCompat ? qwenCompat.thinkingFormat : undefined, "qwen");
  const hunyuanCompat = providerPreset("hunyuan-token-plan-cn")?.compat;
  assert.equal(hunyuanCompat && "thinkingFormat" in hunyuanCompat ? hunyuanCompat.thinkingFormat : undefined, "deepseek");
  assert.equal(piProviderId("qwen-token-plan-cn"), "qwen-token-plan-cn");
  assert.equal(piProviderId("zai-api-cn"), "zai");
  assert.deepEqual(
    catalogModelsForConnection({
      connection_id: "qwen",
      provider: "qwen-token-plan-cn",
      label: "Qwen",
      base_url: null,
      custom_models: ["qwen-new-model"],
      models_source: "provider",
      last_verified_at: "2026-09-01T00:00:00Z",
      verify_error: null,
    }).map((model) => model.id),
    ["qwen-new-model"],
  );
  const qwenUnknown = catalogModelsForConnection({
    connection_id: "qwen-coding",
    provider: "qwen-coding-plan-cn",
    label: "Qwen Coding",
    base_url: null,
    custom_models: ["qwen3-coder-plus"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.equal(
    qwenUnknown[0]?.compat && "thinkingFormat" in qwenUnknown[0].compat
      ? qwenUnknown[0].compat.thinkingFormat
      : undefined,
    "qwen",
  );
  const knownGlm = catalogModelsForConnection({
    connection_id: "glm-coding",
    provider: "zai-coding-cn",
    label: "GLM Coding",
    base_url: null,
    custom_models: ["glm-5.2"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.equal(
    knownGlm[0]?.compat && "supportsReasoningEffort" in knownGlm[0].compat
      ? knownGlm[0].compat.supportsReasoningEffort
      : undefined,
    true,
  );
  const knownTokenHub = catalogModelsForConnection({
    connection_id: "tokenhub",
    provider: "hunyuan-tokenhub-api-cn",
    label: "TokenHub",
    base_url: null,
    custom_models: ["glm-5.2"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.equal(
    knownTokenHub[0]?.compat && "supportsReasoningEffort" in knownTokenHub[0].compat
      ? knownTokenHub[0].compat.supportsReasoningEffort
      : undefined,
    true,
  );
  assert.deepEqual(
    catalogModelsForConnection({
      connection_id: "qwen-known",
      provider: "qwen-token-plan-cn",
      label: "Qwen",
      base_url: null,
      custom_models: getBuiltinModels("qwen-token-plan-cn").slice(0, 2).map((model) => model.id),
      models_source: "provider",
      last_verified_at: "2026-09-01T00:00:00Z",
      verify_error: null,
    }).map((model) => model.id),
    getBuiltinModels("qwen-token-plan-cn").slice(0, 2).map((model) => model.id),
  );
  assert.deepEqual(
    catalogModelsForConnection({
      connection_id: "qwen-unverified",
      provider: "qwen-token-plan-cn",
      label: "Qwen",
      base_url: null,
      custom_models: getBuiltinModels("qwen-token-plan-cn").map((model) => model.id),
      last_verified_at: null,
      verify_error: null,
    }).map((model) => model.id),
    [],
  );
});

test("catalog only trusts provider-returned models and marks unknown models as provider-default thinking", () => {
  const models = catalogModelsForConnection({
    connection_id: "doubao",
    provider: "doubao",
    label: "豆包",
    base_url: null,
    custom_models: ["doubao-live-model", "doubao-live-model"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.deepEqual(models.map((model) => model.id), ["doubao-live-model"]);
  assert.equal(models[0]?.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  assert.equal(models[0]?.api, "openai-completions");
  const options = builtinModelOptions({
    connection_id: "doubao",
    provider: "doubao",
    label: "豆包",
    base_url: null,
    custom_models: ["doubao-live-model"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.equal(options[0]?.thinking_mode, "provider-default");
  assert.deepEqual(
    catalogModelsForConnection({
      connection_id: "manual",
      provider: "doubao",
      label: "豆包",
      base_url: null,
      custom_models: ["should-not-show"],
      models_source: null,
      last_verified_at: "2026-09-01T00:00:00Z",
      verify_error: null,
    }),
    [],
  );
});

test("previously saved provider lists apply the same conversational-model filter", () => {
  const connection = {
    connection_id: "mixed-models",
    provider: "doubao" as const,
    label: "豆包",
    base_url: null,
    custom_models: ["doubao-chat", "doubao-seedance-1.0", "deepseek-vl2", "hunyuan-video", "hy-3d-3.1", "cogview-4", "vendor/seedance-2.0"],
    models_source: "provider" as const,
    last_verified_at: "2026-09-02T00:00:00Z",
    verify_error: null,
  };
  assert.equal(hasTrustedProviderModels(connection), true);
  assert.deepEqual(catalogModelsForConnection(connection).map((model) => model.id), [
    "doubao-chat",
    "deepseek-vl2",
  ]);
});

test("thinking capability follows the upstream model ID across relay providers", () => {
  const options = builtinModelOptions({
    connection_id: "relay",
    provider: "custom",
    label: "中转站",
    base_url: "https://relay.example/v1",
    custom_models: ["gpt-5.4", "gpt-5.6-sol", "glm-5.3"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  assert.equal(options[0]?.model_id, "gpt-5.4");
  assert.equal(options[0]?.thinking_mode, "pi");
  assert.ok((options[0]?.thinking_levels.length ?? 0) > 1);
  assert.equal(options[1]?.model_id, "gpt-5.6-sol");
  assert.equal(options[1]?.thinking_mode, "pi");
  assert.ok(options[1]?.thinking_levels.includes("max"));
  assert.equal(options[2]?.model_id, "glm-5.3");
  assert.equal(options[2]?.thinking_mode, "pi");
  assert.deepEqual(options[2]?.thinking_levels, ["low", "high", "max"]);
});

test("verified domestic model capabilities are deduplicated across provider relays", () => {
  const qwenOptions = builtinModelOptions({
    connection_id: "qwen-models",
    provider: "qwen-coding-plan-cn",
    label: "Qwen Coding",
    base_url: null,
    custom_models: ["qwen3-coder-plus", "qwen3-max-2026-01-23", "glm-5.3", "qwen3.5-flash"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  const qwenById = new Map(qwenOptions.map((option) => [option.model_id, option]));
  assert.equal(qwenById.get("qwen3-coder-plus")?.thinking_mode, "pi");
  assert.deepEqual(qwenById.get("qwen3-coder-plus")?.thinking_levels, ["off", "low"]);
  assert.deepEqual(qwenById.get("qwen3-max-2026-01-23")?.thinking_levels, ["off", "low"]);
  assert.deepEqual(qwenById.get("qwen3.5-flash")?.thinking_levels, ["off", "low"]);
  assert.deepEqual(qwenById.get("glm-5.3")?.thinking_levels, ["low", "high", "max"]);

  const hunyuanOptions = builtinModelOptions({
    connection_id: "hunyuan-models",
    provider: "hunyuan-tokenhub-api-cn",
    label: "TokenHub",
    base_url: null,
    custom_models: ["hy4-preview", "hy3", "tc-code-latest", "glm-5.3"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  const hunyuanById = new Map(hunyuanOptions.map((option) => [option.model_id, option]));
  assert.deepEqual(hunyuanById.get("hy4-preview")?.thinking_levels, ["off", "low"]);
  assert.deepEqual(hunyuanById.get("hy3")?.thinking_levels, ["off", "low", "high"]);
  assert.equal(hunyuanById.get("tc-code-latest")?.thinking_mode, "provider-default");
  assert.deepEqual(hunyuanById.get("glm-5.3")?.thinking_levels, ["low", "high", "max"]);
});

test("MiniMax and Kimi always-thinking aliases stay Provider default", () => {
  const minimaxOptions = builtinModelOptions({
    connection_id: "minimax-models",
    provider: "minimax-cn",
    label: "MiniMax",
    base_url: null,
    custom_models: ["MiniMax-M2.5-highspeed", "MiniMax-M3", "minimax-m-3-0"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  const minimaxById = new Map(minimaxOptions.map((option) => [option.model_id, option]));
  assert.equal(minimaxById.get("MiniMax-M2.5-highspeed")?.thinking_mode, "provider-default");
  assert.deepEqual(minimaxById.get("MiniMax-M2.5-highspeed")?.thinking_levels, ["off"]);
  assert.equal(minimaxById.get("MiniMax-M3")?.thinking_mode, "pi");
  assert.deepEqual(minimaxById.get("MiniMax-M3")?.thinking_levels, ["off", "low"]);
  assert.equal(minimaxById.get("minimax-m-3-0")?.thinking_mode, "pi");

  const kimiOptions = builtinModelOptions({
    connection_id: "kimi-models",
    provider: "kimi-coding",
    label: "Kimi Code",
    base_url: null,
    custom_models: ["k3", "kimi-for-coding", "kimi-k2.7-code-highspeed"],
    models_source: "provider",
    last_verified_at: "2026-09-01T00:00:00Z",
    verify_error: null,
  });
  const kimiById = new Map(kimiOptions.map((option) => [option.model_id, option]));
  assert.deepEqual(kimiById.get("k3")?.thinking_levels, ["low", "high", "max"]);
  assert.equal(kimiById.get("kimi-for-coding")?.thinking_mode, "provider-default");
  assert.equal(kimiById.get("kimi-k2.7-code-highspeed")?.thinking_mode, "provider-default");
});

test("Kimi shared model capabilities survive protocol-specific relays", () => {
  const openAiOptions = builtinModelOptions({
    connection_id: "kimi-openai-models",
    provider: "kimi-coding-openai",
    label: "Kimi Code OpenAI",
    base_url: null,
    custom_models: ["k3", "k3-256k"],
    models_source: "provider",
    last_verified_at: "2026-09-02T00:00:00Z",
    verify_error: null,
  });
  for (const option of openAiOptions) {
    assert.equal(option.thinking_mode, "pi");
    assert.deepEqual(option.thinking_levels, ["low", "high", "max"]);
  }

  const moonshotOptions = builtinModelOptions({
    connection_id: "moonshot-models",
    provider: "moonshotai-cn",
    label: "Kimi API",
    base_url: null,
    custom_models: ["kimi-k2.5", "kimi-k2.6"],
    models_source: "provider",
    last_verified_at: "2026-09-02T00:00:00Z",
    verify_error: null,
  });
  for (const option of moonshotOptions) {
    assert.equal(option.thinking_mode, "pi");
    assert.deepEqual(option.thinking_levels, ["off", "low"]);
  }
});
