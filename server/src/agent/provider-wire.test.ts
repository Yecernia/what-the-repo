import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import { PROVIDER_PRESETS } from "./provider-catalog.js";
import { resolveDeploymentProvider } from "./provider-resolver.js";
import { createModelRuntime } from "./model-runtime.js";

// Only mocked HTTP: this checks the SDK's serialized request, not upstream availability.
function responseStream(model: string, anthropic: boolean): Response {
  const events = anthropic ? [
    { type: "message_start", message: { id: "audit", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { id: "audit", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: "audit", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  const data = events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(data + (anthropic ? "" : "data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } });
}

const representativeModels: Record<string, string> = {
  deepseek: "deepseek-v4-flash", qwen: "qwen3.5-plus", minimax: "MiniMax-M2.7",
  mimo: "mimo-v2-flash", glm: "glm-5.2", kimi: "kimi-k2.5",
  doubao: "doubao-seed-2.0-pro", hunyuan: "hy3",
};

const qwenTotalOutputCases = ["qwen3.5-plus", "qwen3.8-max", "deepseek-v4-flash", "glm-5.2", "MiniMax-M2.7"];

test("official presets retain output-limit fields for known and newly discovered chat models", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  for (const preset of PROVIDER_PRESETS.filter((entry) => entry.id !== "custom")) {
    const models = [representativeModels[preset.family]!, "audit-new-chat-model"];
    if (preset.id === "qwen-api-cn") models.push("qwen3-max", ...qwenTotalOutputCases.slice(1), "glm-5.2-direct-supplier");
    // The same upstream model retains Tencent's / Anthropic's own wire format.
    if (preset.id === "hunyuan-tokenhub-api-cn" || preset.id === "qwen-token-plan-anthropic-cn") models.push("deepseek-v4-flash");
    for (const model of models) {
      await t.test(`${preset.id} / ${model}`, async (caseTest) => {
        let body: Record<string, unknown> | undefined;
        let requestUrl = "";
        let calls = 0;
        caseTest.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          requestUrl = String(input);
          body = JSON.parse(String(init?.body));
          return responseStream(model, preset.api === "anthropic-messages");
        });
        const config = resolveDeploymentProvider({ providerId: preset.id, model, apiKey: "audit-fake-key", connectionId: "wire-audit" });
        assert.ok(config);
        const runtime = createModelRuntime(config);
        const result = await runtime.models.completeSimple(runtime.model, {
          messages: [{ role: "user", content: "ping", timestamp: 1 }],
        }, { apiKey: config.apiKey, reasoning: "low", maxTokens: runtime.model.maxTokens });
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(calls, 1);
        assert.ok(requestUrl.startsWith(preset.base_url + "/"), requestUrl);
        assert.ok(body);
        assert.equal(body.model, model);
        const expectedField = preset.family === "qwen" && qwenTotalOutputCases.includes(model) && preset.api === "openai-completions"
          ? "max_completion_tokens" : "max_tokens";
        assert.equal(typeof body[expectedField], "number", JSON.stringify(body));
        assert.ok(Number(body[expectedField]) > 0);
        assert.equal(expectedField === "max_tokens" ? "max_completion_tokens" in body : "max_tokens" in body, false);
      });
    }
  }
});
