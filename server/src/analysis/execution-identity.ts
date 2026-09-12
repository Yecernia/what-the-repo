import { createHash } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { loadProductSkill, type ProductSkill } from "../agent/skill-registry.js";
import { createModelRuntime } from "../agent/model-runtime.js";
import { resolveDeploymentProvider } from "../agent/provider-resolver.js";
import type { PiModelRuntime } from "../agent/types.js";
import { ANALYSIS_CONFIG_DIGEST } from "./identity.js";
import { WEB_SEARCH_VERSION } from "./web-research-client.js";
import { runtimeForSkill, withAgentModels, type RoleRuntimeOptions } from "../agent/role-models.js";

export const ANALYSIS_MODEL_ROLES = ["component-explanation", "architecture-planning", "repository-value-discovery"] as const;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function skillExecutionIdentity(skill: ProductSkill) {
  return { id: skill.id, version: skill.version, content_digest: digest([skill.skill.name, skill.skill.description, skill.skill.content]),
    context: skill.contextBuilderId, input_schema: skill.inputSchemaId, output_schema: skill.outputSchemaId };
}

/** No credential values or endpoint query strings are exposed in stored identity. */
export function modelExecutionIdentity(runtime: PiModelRuntime) {
  const model = runtime.model;
  return { provider: model.provider, model: model.id, api: model.api, endpoint_digest: digest(model.baseUrl ?? ""),
    thinking_level_map: model.thinkingLevelMap, reasoning: model.reasoning, context_window: model.contextWindow,
    max_tokens: model.maxTokens, compat: model.compat };
}

export function resolveAnalysisProvider(config: ServerConfig) {
  return resolveDeploymentProvider({ providerId: config.analysisProviderId,
    baseUrl: config.analysisProviderBaseUrl ?? config.freeProviderBaseUrl,
    model: config.analysisProviderModel ?? config.freeProviderModel,
    apiKey: config.analysisProviderApiKey ?? config.freeProviderApiKey, connectionId: "platform-analysis" });
}

export async function selectAnalysisExecution(runtime: PiModelRuntime | null, searchConfigured: boolean) {
  const ids = ANALYSIS_MODEL_ROLES;
  const skills = await Promise.all(ids.map(id => runtime?.skills?.[id] ?? loadProductSkill(id)));
  return {
    runtime: runtime ? { ...runtime, skills: Object.fromEntries(skills.map(skill => [skill.id, skill])) } : null,
    modelsByRole: Object.fromEntries(ids.map(id => {
      const model = runtime && runtimeForSkill(runtime, id).model;
      return [id, model ? { provider: model.provider, model: model.id } : null];
    })),
    digest: digest({ base: ANALYSIS_CONFIG_DIGEST,
      models: ids.map(id => ({ role: id, model: runtime ? modelExecutionIdentity(runtimeForSkill(runtime, id)) : null })),
      thinking_level: "medium", skills: skills.map(skillExecutionIdentity),
      search: `${WEB_SEARCH_VERSION}:${searchConfigured ? "configured" : "unconfigured"}` }),
  };
}

/** API cache lookup and Worker execution must resolve the same effective configuration. */
export async function resolveAnalysisExecution(config: ServerConfig, options: RoleRuntimeOptions = {}) {
  const provider = resolveAnalysisProvider(config);
  const runtime = provider ? withAgentModels(config,
    createModelRuntime(provider, { ...options, providerGate: options.providerGateFactory?.(provider) }), provider, ANALYSIS_MODEL_ROLES, options) : null;
  return { provider, ...await selectAnalysisExecution(runtime, Boolean(config.webSearchApiKey?.trim())) };
}
