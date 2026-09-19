import assert from "node:assert/strict";
import test from "node:test";
import { modelLifecycle } from "./model-lifecycle.js";
import { discoverProviderModels, filterLikelyConversationalModelIds, mergeDiscoveredModelIds } from "./provider-catalog.js";
import { catalogModelsForConnection, hasTrustedProviderModels } from "./provider-resolver.js";

test("official lifecycle facts apply to an endpoint, not every reseller or model namespace", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const oldIds = ["qwen3.5-plus", "qwen3.5-flash", "kimi-k2.5"];
  assert.deepEqual(filterLikelyConversationalModelIds(oldIds, { provider: "hunyuan-tokenhub-api-cn", now }), []);
  assert.deepEqual(filterLikelyConversationalModelIds(oldIds, { provider: "qwen-coding-plan-cn", now }), oldIds);
  assert.deepEqual(filterLikelyConversationalModelIds(oldIds, { provider: "custom", base_url: "https://relay.example/v1", now }), oldIds);
  assert.deepEqual(filterLikelyConversationalModelIds(oldIds, { provider: "custom", base_url: "https://tokenhub.tencentmaas.com/v1/", now }), []);
  assert.deepEqual(filterLikelyConversationalModelIds(["vendor/qwen3.5-plus"], { provider: "hunyuan-tokenhub-api-cn", now }), ["vendor/qwen3.5-plus"]);
  assert.equal(modelLifecycle("qwen3.5-plus", "https://tokenhub.tencentmaas.com.example/v1", now), undefined);
  assert.equal(modelLifecycle("qwen3.5-plus", "https://tokenhub.tencentmaas.com/plan/v3", now), undefined);
  const vision = ["hunyuan-t1-vision-20250916", "hunyuan-turbos-vision-video-20250728"];
  assert.deepEqual(filterLikelyConversationalModelIds(vision, { provider: "hunyuan-tokenhub-api-cn", now }), vision);
  assert.deepEqual(filterLikelyConversationalModelIds(vision, { provider: "hunyuan", now }), [vision[1]]);
  assert.deepEqual(filterLikelyConversationalModelIds(["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"], { provider: "deepseek", now }), ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash"]);
});

test("scheduled retirements remain selectable until the exact official cutoff", () => {
  for (const [id, cutoff] of [["glm-5", "2026-10-09T00:00:00+08:00"], ["youtu-vita", "2026-10-15T00:00:00+08:00"], ["glm-5v-turbo", "2026-10-30T23:59:59+08:00"]]) {
    const context = { provider: "hunyuan-tokenhub-api-cn", now: Date.parse(cutoff) - 1 };
    assert.deepEqual(filterLikelyConversationalModelIds([id], context), [id]);
    assert.deepEqual(filterLikelyConversationalModelIds([id], { ...context, now: context.now + 1 }), []);
  }
});

test("translation, terminal status and array metadata override cached manual proofs", () => {
  const result = discoverProviderModels({ data: [
    { id: "hy-mt2-pro" }, { id: "hy-mt2-plus" }, { id: "hy-mt2-lite" },
    { id: "doubao-seed-translation-250915", task_type: ["TextGeneration"] },
    { id: "old-chat", status: " Discontinued " },
    { id: "old-chat", status: "online" },
    { id: "old-2", status: "shut_down" },
    { id: "translate", task_type: ["TextGeneration", "machine_translation"] },
    { id: "opaque-image", output_modalities: ["image"] },
    { id: "new-chat", output_modalities: [" Text ", "image"] },
    { id: "future-chat", status: "pre-offline" },
    { id: "retiring-chat", status: "Retiring" },
    { id: "deprecated-chat", status: "deprecated" },
  ] });
  assert.deepEqual(result.models, ["new-chat", "future-chat", "retiring-chat", "deprecated-chat"]);
  assert.deepEqual(mergeDiscoveredModelIds(result, ["old-chat", "translate", "opaque-image", "unlisted-manual"], {}), ["unlisted-manual", ...result.models]);
  assert.equal(discoverProviderModels({ error: "temporary" }).valid, false);
  assert.equal(discoverProviderModels({ data: [] }).valid, true);
});

test("unknown TokenHub string IDs require manual proof, not automatic family inference", () => {
  const result = discoverProviderModels({ data: ["opaque-service", "hy4-preview"] }, { provider: "hunyuan-tokenhub-api-cn" });
  assert.deepEqual(result.models, ["hy4-preview"]);
  assert.deepEqual(mergeDiscoveredModelIds(result, ["opaque-service"], { provider: "hunyuan-tokenhub-api-cn" }), ["opaque-service", "hy4-preview"]);
});

test("expired saved selections are unavailable without revoking the verified connection", () => {
  const connection = { connection_id: "old", provider: "hunyuan-tokenhub-api-cn" as const, label: "Saved", base_url: null,
    custom_models: ["qwen3.5-plus", "hy-mt2-pro"], models_source: "verified" as const, last_verified_at: "2026-09-01T00:00:00Z", verify_error: null };
  assert.equal(hasTrustedProviderModels(connection), true);
  assert.deepEqual(catalogModelsForConnection(connection), []);
  assert.equal(hasTrustedProviderModels({ ...connection, custom_models: [] }), true);
  assert.equal(hasTrustedProviderModels({ ...connection, models_source: null }), false);
});
