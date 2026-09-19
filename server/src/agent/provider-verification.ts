import type { ProviderConnectionSettings } from "../domain/conversation.js";
import { assertPublicHttpsUrl } from "../security/outbound-url.js";
import { connectionModelLifecycle, filterLikelyConversationalModelIds } from "./provider-catalog.js";
import { catalogModelsForConnection, resolveDeploymentProvider } from "./provider-resolver.js";
import { createModelRuntime, streamWithProviderPermit, type ModelRuntimeOptions } from "./model-runtime.js";
import type { ProviderGateFactory } from "./provider-gate.js";

/** A short real chat through the same adapter used by conversations and analysis. */
export async function verifyManualModel(
  connection: ProviderConnectionSettings,
  apiKey: string,
  model: string,
  options: ModelRuntimeOptions & { providerGateFactory?: ProviderGateFactory } = {},
): Promise<{ ok: boolean; message: string }> {
  if (connectionModelLifecycle(model, connection)?.active) {
    return { ok: false, message: "模型已下线或已被其他模型替换，请刷新列表后重新选择" };
  }
  if (filterLikelyConversationalModelIds([model], connection)[0] !== model) {
    return { ok: false, message: "模型名称无效或属于非对话模型" };
  }
  const config = resolveDeploymentProvider({
    providerId: connection.provider, baseUrl: connection.base_url,
    model, apiKey, connectionId: connection.connection_id,
  });
  if (!config) return { ok: false, message: "模型连接配置不可用" };
  if (connection.provider === "custom") {
    // A user's custom endpoint uses the catalog's conservative chat defaults,
    // rather than the deployment-only fallback's assumed reasoning support.
    const descriptor = catalogModelsForConnection({ ...connection, custom_models: [model] }, { includePending: true })[0];
    if (!descriptor) return { ok: false, message: "模型连接配置不可用" };
    Object.assign(config, { provider: "custom", reasoning: descriptor.reasoning, thinkingLevelMap: descriptor.thinkingLevelMap, compat: descriptor.compat, thinkingLevel: "off" });
  }
  try {
    await assertPublicHttpsUrl(config.baseUrl);
    const runtime = createModelRuntime(config, {
      ...options, providerGate: options.providerGateFactory?.(config, 'chat', options.ownerId
        ? { ownerId: options.ownerId, taskId: options.attribution?.taskId ?? 'verification' } : undefined),
    });
    const result = await streamWithProviderPermit(runtime, runtime.model, {
      messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }],
    }, { apiKey, maxTokens: 1024, signal: AbortSignal.timeout(60_000) }).result();
    const hasText = result.content.some(part => part.type === "text" && part.text.trim());
    if (!["stop", "length"].includes(result.stopReason) || !hasText) {
      return { ok: false, message: "模型验证失败，请检查名称、模型权限、额度或网络后重试" };
    }
    return { ok: true, message: "模型验证成功，已收到对话回复" };
  } catch {
    return { ok: false, message: "模型验证失败，请检查名称、模型权限、额度或网络后重试" };
  }
}
