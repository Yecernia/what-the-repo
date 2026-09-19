import type { ServerConfig } from "../config.js";
import { createHash } from "node:crypto";
import type { AgentModelRole } from "../agent-model-config.js";
import type { ProviderConfig } from "./provider-types.js";
import type { PiModelRuntime } from "./types.js";
import type { ProductSkillId } from "./skill-registry.js";
import type { ProviderGateFactory } from "./provider-gate.js";
import { createModelRuntime, type ModelRuntimeOptions } from "./model-runtime.js";
import { resolveDeploymentProvider } from "./provider-resolver.js";
import { safePublicHttpsUrl } from "../security/outbound-url.js";

export function resolveAgentProvider(config: ServerConfig, role: AgentModelRole, fallback: ProviderConfig | null): ProviderConfig | null {
  const override = config.agentModels?.[role];
  if (!override) return fallback;
  const providerId = override.provider ?? (fallback?.provider === "deployment-custom" ? "custom" : fallback?.provider) ?? "deepseek";
  const sameProvider = !override.provider || override.provider === (fallback?.provider === "deployment-custom" ? "custom" : fallback?.provider);
  const baseUrl = override.baseUrl ?? (sameProvider ? fallback?.baseUrl : undefined);
  // A model-only override may inherit its deployment key; changing destinations must supply a key.
  const sameDestination = sameProvider && (!override.baseUrl || override.baseUrl.replace(/\/$/, "") === fallback?.baseUrl.replace(/\/$/, ""));
  const apiKey = override.apiKey ?? (sameDestination ? fallback?.apiKey : undefined);
  if (baseUrl && !safePublicHttpsUrl(baseUrl)) throw new Error(`invalid_agent_provider:${role}`);
  const resolved = resolveDeploymentProvider({ providerId, baseUrl, model: override.model, apiKey, connectionId: `platform-agent:${role}` });
  if (!resolved) throw new Error(`invalid_agent_provider:${role}`);
  // Role names must not multiply concurrency for the same upstream account/model.
  resolved.connectionId = fallback && sameDestination && apiKey === fallback.apiKey
    ? fallback.connectionId
    : `platform-agent:${createHash("sha256").update(JSON.stringify([resolved.provider, resolved.baseUrl, resolved.apiKey])).digest("hex").slice(0, 24)}`;
  resolved.modelSelector = `deployment:${resolved.connectionId}:${resolved.model}`;
  if (override.connectionId) resolved.connectionId = override.connectionId;
  return resolved;
}

export type RoleRuntimeOptions = ModelRuntimeOptions & { providerGateFactory?: ProviderGateFactory; business?: import('./provider-budget.js').UsageBusiness };

/** Build only explicit overrides. The fallback keeps existing model choices and mock runtimes intact. */
export function withAgentModels(config: ServerConfig, runtime: PiModelRuntime, fallback: ProviderConfig | null,
  roles: readonly AgentModelRole[], options: RoleRuntimeOptions = {}): PiModelRuntime {
  const roleRuntimes = { ...runtime.roleRuntimes };
  for (const role of roles) {
    if (!config.agentModels?.[role]) continue;
    const provider = resolveAgentProvider(config, role, fallback)!;
    roleRuntimes[role] = createModelRuntime(provider, { ...options, providerGate: options.providerGateFactory?.(provider,
      options.business ?? options.attribution?.business, options.ownerId ? { ownerId: options.ownerId, taskId: options.attribution?.taskId ?? '' } : undefined) });
  }
  return { ...runtime, roleRuntimes };
}

/** Keep job-wide request limits and accounting while selecting a role's own transport and gate. */
export function runtimeForSkill(runtime: PiModelRuntime, role: ProductSkillId): PiModelRuntime {
  const selected = runtime.roleRuntimes?.[role];
  if (!selected) return runtime.attribution ? { ...runtime, attribution: { ...runtime.attribution, agentRole: role } } : runtime;
  return { ...selected,
    attribution: runtime.attribution ? { ...runtime.attribution, agentRole: role, connectionId: selected.providerConnectionId ?? selected.attribution?.connectionId ?? runtime.attribution.connectionId } : undefined,
    skills: runtime.skills ?? selected.skills,
    beforeWorkerRequest: runtime.beforeWorkerRequest ?? selected.beforeWorkerRequest,
    providerBudget: runtime.providerBudget ?? selected.providerBudget,
    ownerId: runtime.ownerId ?? selected.ownerId,
    metrics: runtime.metrics ?? selected.metrics,
  };
}
