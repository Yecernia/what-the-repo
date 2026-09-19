import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider as PiBuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ServerConfig } from "../config.js";
import type {
  Project,
  ProviderConnectionSettings,
  ProviderPreset,
  ProviderSettings,
  ThinkingLevelPreference,
} from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";
import type { ProviderConfig } from "./provider-types.js";
import { safePublicHttpsUrl } from "../security/outbound-url.js";
import {
  CONFIGURABLE_PROVIDER_IDS,
  PROVIDER_PRESETS,
  SUPPORTED_PROVIDER_IDS,
  providerDefaultLabel,
  providerPreset,
  filterLikelyConversationalModelIds,
  verifiedModelCapability,
  type ProviderCatalogModel,
  type ProviderCompat,
  type ProviderAuthHeader,
} from "./provider-catalog.js";

export {
  CONFIGURABLE_PROVIDER_IDS,
  PROVIDER_PRESETS,
  SUPPORTED_PROVIDER_IDS,
  providerDefaultLabel,
  providerFamilies,
  isConfigurableProviderPreset,
} from "./provider-catalog.js";

// Stable saved selection ID; the actual model and display name come from config.
export const FREE_SELECTOR = "free:deepseek-v4-flash";
export const MODEL_SELECTOR_PREFIX = "provider:";
export function presetBaseUrl(provider: string): string | null {
  return providerPreset(provider)?.base_url || null;
}

export interface ProviderOwner {
  owner_id: string;
  kind: "guest" | "github";
}

export interface AvailableModelOption {
  selector: string;
  connection_id: string;
  provider: string;
  model_id: string;
  label: string;
  thinking_levels: ThinkingLevelPreference[];
  /** `provider-default` means no extra thinking parameter is sent. */
  thinking_mode?: "pi" | "provider-default";
}

type ThinkingCapabilityInput = {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null> | Partial<Record<string, string | null>>;
};

export function thinkingLevelsForModel(model: ThinkingCapabilityInput): ThinkingLevelPreference[] {
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]) as ThinkingLevelPreference[];
}

function hasPiThinkingControls(model: ThinkingCapabilityInput): boolean {
  return model.reasoning && thinkingLevelsForModel(model).some((level) => level !== "off");
}

type CatalogModel = (ProviderCatalogModel | Model<Api>) & { authHeader?: ProviderAuthHeader };

const PI_PROVIDER_IDS = new Set<string>(getBuiltinProviders());

export function piProviderId(provider: string): PiBuiltinProvider | null {
  const candidate = providerPreset(provider)?.pi_provider
    ?? (PI_PROVIDER_IDS.has(provider) ? provider : null);
  return candidate && PI_PROVIDER_IDS.has(candidate)
    ? candidate as PiBuiltinProvider
    : null;
}

function piModels(provider: string): Model<Api>[] {
  const id = piProviderId(provider);
  return id ? getBuiltinModels(id) as Model<Api>[] : [];
}

function piModelCapabilityScore(model: Model<Api>): number {
  const levels = thinkingLevelsForModel(model);
  const adjustableLevels = levels.filter((level) => level !== "off").length;
  return (model.reasoning ? 1_000 : 0)
    + adjustableLevels * 10
    + (model.provider === "openai" ? 1 : 0);
}

/**
 * Pi catalogs models by provider, but model capabilities belong to the model
 * ID. Keep one best capability record so a relay/custom endpoint can still
 * recognize a model that Pi lists under another provider.
 */
const PI_MODEL_INDEX = (() => {
  const index = new Map<string, Model<Api>>();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider) as Model<Api>[]) {
      const current = index.get(model.id);
      if (!current || piModelCapabilityScore(model) > piModelCapabilityScore(current)) {
        index.set(model.id, model);
      }
    }
  }
  return index;
})();

function piModelCapability(modelId: string): Model<Api> | null {
  return PI_MODEL_INDEX.get(modelId.trim()) ?? null;
}

interface ResolvedModelCapability {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: ProviderCompat;
}

function mergeCompat(
  base: ProviderCompat | undefined,
  override: ProviderCompat | undefined,
): ProviderCompat | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) } as ProviderCompat;
}

function modelCapabilityFor(
  provider: string,
  modelId: string,
  known?: Model<Api> | null,
): ResolvedModelCapability {
  const preset = providerPreset(provider);
  const api = preset?.api ?? "openai-completions";
  const pi = piModelCapability(modelId);
  const verified = verifiedModelCapability(modelId, api, provider);
  // Endpoint wire requirements override catalog defaults, while unspecified
  // options (for example reasoning-history support) stay intact.
  const baseCompat = mergeCompat(known?.compat ?? pi?.compat, preset?.compat);
  return {
    reasoning: verified?.reasoning ?? pi?.reasoning ?? known?.reasoning ?? false,
    thinkingLevelMap: verified?.thinkingLevelMap ?? pi?.thinkingLevelMap ?? known?.thinkingLevelMap,
    compat: mergeCompat(baseCompat, verified?.compat),
  };
}

function providerModelDescriptor(
  provider: ProviderPreset,
  modelId: string,
  baseUrlOverride?: string,
  capability?: Model<Api> | null,
): ProviderCatalogModel | null {
  const preset = providerPreset(provider);
  const id = modelId.trim();
  if (!preset || !id) return null;
  const resolved = modelCapabilityFor(provider, id, capability);
  return {
    id,
    name: id,
    api: preset.api,
    baseUrl: baseUrlOverride?.trim() || preset.base_url,
    reasoning: resolved.reasoning,
    thinkingLevelMap: resolved.thinkingLevelMap,
    compat: resolved.compat,
    authHeader: preset.authHeader,
  };
}

export interface CatalogModelsOptions {
  /** Internal deployment paths may describe a configured model before verification. */
  includePending?: boolean;
}

export function hasTrustedProviderModels(connection: ProviderConnectionSettings): boolean {
  return Boolean(
    (connection.models_source === "provider" || connection.models_source === "verified")
      // Eligibility can change after verification; never delete a user's key
      // merely because all previously verified models have been retired.
      && !connection.verify_error
      && connection.last_verified_at
      && Number.isFinite(Date.parse(connection.last_verified_at)),
  );
}

export function catalogModelsForConnection(
  connection: ProviderConnectionSettings,
  options: CatalogModelsOptions = {},
): CatalogModel[] {
  const preset = providerPreset(connection.provider);
  if (!preset || !CONFIGURABLE_PROVIDER_IDS.includes(connection.provider)) return [];
  const trusted = hasTrustedProviderModels(connection);
  if (!trusted && !options.includePending) return [];
  const piCatalog = piModels(connection.provider);
  const piById = new Map(piCatalog.map((model) => [model.id, model]));
  const byId = new Map<string, CatalogModel>();
  for (const modelId of filterLikelyConversationalModelIds(connection.custom_models, connection)) {
    const id = modelId.trim();
    const known = piById.get(id);
    const capability = modelCapabilityFor(connection.provider, id, known);
    const model = known
      ? {
        ...known,
        api: preset.api,
        baseUrl: connection.provider === "custom"
          ? connection.base_url ?? preset.base_url
          : preset.base_url,
        reasoning: capability.reasoning,
        thinkingLevelMap: capability.thinkingLevelMap,
        compat: capability.compat,
        authHeader: preset.authHeader,
      }
      : providerModelDescriptor(
        connection.provider,
        id,
        connection.provider === "custom" ? connection.base_url ?? undefined : preset.base_url,
        undefined,
      );
    if (model) byId.set(model.id, model);
  }
  return [...byId.values()];
}

function freeCatalogModel(config: ServerConfig) {
  if (!config.freeProviderModel) return null;
  const models = getBuiltinModels("deepseek");
  // Pi's pinned catalog predates this GA alias. Both have the documented 1M /
  // 384K limits and the same thinking protocol; keep Pi's native adapter.
  const model = models.find((candidate) => candidate.id === config.freeProviderModel)
    ?? (config.freeProviderModel === "deepseek-flash" ? models.find(candidate => candidate.id === "deepseek-v4-flash") : undefined);
  if (!model) return null;
  const capability = modelCapabilityFor("deepseek", config.freeProviderModel, model);
  return {
    ...model,
    id: config.freeProviderModel,
    name: config.freeProviderModel,
    reasoning: capability.reasoning,
    thinkingLevelMap: capability.thinkingLevelMap,
    compat: capability.compat,
  };
}

export function encodeModelSelector(connectionId: string, modelId: string): string {
  return `${MODEL_SELECTOR_PREFIX}${connectionId}:${encodeURIComponent(modelId)}`;
}

export function decodeModelSelector(value: string): { connectionId: string; modelId: string } | null {
  if (!value.startsWith(MODEL_SELECTOR_PREFIX)) return null;
  const remainder = value.slice(MODEL_SELECTOR_PREFIX.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0) return null;
  const connectionId = remainder.slice(0, separator);
  try {
    const modelId = decodeURIComponent(remainder.slice(separator + 1));
    return connectionId && modelId ? { connectionId, modelId } : null;
  } catch {
    return null;
  }
}

export function builtinModelOptions(
  connection: ProviderConnectionSettings,
): AvailableModelOption[] {
  return catalogModelsForConnection(connection).map((model) => {
    const supportsPiThinking = hasPiThinkingControls(model);
    return {
      thinking_levels: supportsPiThinking
        ? thinkingLevelsForModel(model)
        : ["off"] as ThinkingLevelPreference[],
      thinking_mode: supportsPiThinking ? "pi" as const : "provider-default" as const,
      selector: encodeModelSelector(connection.connection_id, model.id),
      connection_id: connection.connection_id,
      provider: connection.provider,
      model_id: model.id,
      label: `${connection.label} / ${model.id}`,
    };
  });
}

export function availableModels(
  config: ServerConfig,
  store: ProductStore,
  owner: ProviderOwner,
  settings: ProviderSettings,
): AvailableModelOption[] {
  const rows: AvailableModelOption[] = [];
  if (config.freeProviderBaseUrl && config.freeProviderModel && config.freeProviderApiKey) {
    const catalogModel = freeCatalogModel(config);
    rows.push({
      selector: FREE_SELECTOR,
      connection_id: config.freeConnectionId ?? "deployment-free",
      provider: config.freeProviderId ?? "deepseek",
      model_id: config.freeProviderModel,
      label: `${config.freeProviderModel}（免费体验）`,
      thinking_levels: catalogModel ? thinkingLevelsForModel(catalogModel) : ["off"],
      thinking_mode: catalogModel && hasPiThinkingControls(catalogModel) ? "pi" : "provider-default",
    });
  }
  if (owner.kind === "guest") return rows;
  for (const connection of settings.connections) {
    if (!CONFIGURABLE_PROVIDER_IDS.includes(connection.provider)) continue;
    if (!store.keys.get(owner.owner_id, connection.connection_id)) continue;
    rows.push(...builtinModelOptions(connection));
  }
  return rows;
}

/** Return a selector that still belongs to a configured connection.
 * Older settings stored a bare model id; translate that shape when possible
 * so a provider/plan change cannot leave an unusable selector behind. */
export function effectiveModelSelector(
  config: ServerConfig,
  store: ProductStore,
  owner: ProviderOwner,
  settings: ProviderSettings,
  requested = settings.model,
): string {
  const options = availableModels(config, store, owner, settings);
  const candidate = typeof requested === "string" ? requested.trim() : "";
  if (candidate === FREE_SELECTOR && options.some((option) => option.selector === FREE_SELECTOR)) {
    return FREE_SELECTOR;
  }
  const exact = options.find((option) => option.selector === candidate);
  if (exact) return exact.selector;
  const legacy = options.find((option) => option.model_id === candidate);
  if (legacy) return legacy.selector;
  return owner.kind === "guest" ? FREE_SELECTOR : options[0]?.selector ?? FREE_SELECTOR;
}

function connectionForSelector(
  settings: ProviderSettings,
  selector: string,
): { connection: ProviderConnectionSettings; modelId: string } | null {
  const decoded = decodeModelSelector(selector);
  if (!decoded) return null;
  const connection = settings.connections.find((item) => item.connection_id === decoded.connectionId);
  return connection ? { connection, modelId: decoded.modelId } : null;
}

export function resolveProvider(input: {
  config: ServerConfig;
  store: ProductStore;
  owner: ProviderOwner;
  settings: ProviderSettings;
  selectedModel: string;
}): ProviderConfig | null {
  const { config, store, owner, settings, selectedModel } = input;
  if (selectedModel === FREE_SELECTOR || owner.kind === "guest") {
    if (config.freeProviderId) {
      const resolved = resolveDeploymentProvider({ providerId: config.freeProviderId, baseUrl: config.freeProviderBaseUrl,
        model: config.freeProviderModel, apiKey: config.freeProviderApiKey, connectionId: config.freeConnectionId ?? 'deployment-free' });
      return resolved ? { ...resolved, modelSelector: FREE_SELECTOR } : null;
    }
    if (!config.freeProviderBaseUrl || !config.freeProviderModel || !config.freeProviderApiKey) return null;
    const catalogModel = freeCatalogModel(config);
    return {
      provider: catalogModel ? "deepseek" : "deployment-free",
      connectionId: "deployment-free",
      baseUrl: config.freeProviderBaseUrl,
      apiKey: config.freeProviderApiKey,
      model: config.freeProviderModel,
      modelId: config.freeProviderModel,
      modelSelector: FREE_SELECTOR,
      api: catalogModel?.api ?? "openai-completions",
      builtin: Boolean(catalogModel),
      contextWindow: catalogModel?.contextWindow,
      maxOutputTokens: catalogModel?.maxTokens,
      reasoning: catalogModel?.reasoning ?? false,
      thinkingLevelMap: catalogModel?.thinkingLevelMap,
      compat: catalogModel?.compat,
      thinkingLevel: catalogModel
        ? clampThinkingLevel(catalogModel, settings.thinking_level) as ThinkingLevelPreference
        : "off",
      cost: providerCostEstimate(config.freeProviderModel, config.freeProviderBaseUrl, catalogModel?.cost),
    };
  }
  const resolved = connectionForSelector(settings, selectedModel);
  if (!resolved) return null;
  const { connection, modelId } = resolved;
  const apiKey = store.keys.get(owner.owner_id, connection.connection_id);
  if (!apiKey) return null;
  const model = catalogModelsForConnection(connection)
    .find((candidate) => candidate.id === modelId);
  if (!model) return null;
  const supportsPiThinking = hasPiThinkingControls(model);
  const preset = providerPreset(connection.provider);
  if (!preset) return null;
  const adapterProvider = piProviderId(connection.provider);
  const baseUrl = connection.provider === "custom"
    ? connection.base_url ?? ""
    : preset.base_url || model.baseUrl;
  if (connection.provider === "custom" && !safePublicHttpsUrl(baseUrl)) return null;
  return {
    provider: connection.provider,
    adapterProvider: adapterProvider ?? undefined,
    connectionId: connection.connection_id,
    baseUrl,
    apiKey,
    model: modelId,
    modelId,
    modelSelector: selectedModel,
    api: model.api,
    builtin: Boolean(adapterProvider),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
      reasoning: supportsPiThinking,
      thinkingLevelMap: supportsPiThinking ? model.thinkingLevelMap : undefined,
      compat: model.compat,
      authHeader: model.authHeader,
      thinkingLevel: supportsPiThinking
      ? clampThinkingLevel(
        model as Parameters<typeof clampThinkingLevel>[0],
        settings.thinking_level,
      ) as ThinkingLevelPreference
      : "off",
    cost: providerCostEstimate(modelId, baseUrl, "cost" in model ? model.cost : undefined),
  };
}

export async function resolveProjectProvider(
  config: ServerConfig,
  store: ProductStore,
  project: Project,
): Promise<ProviderConfig | null> {
  const [settings, rawOwner] = await Promise.all([
    store.loadSettings(project.owner_id),
    store.loadUser(project.owner_id),
  ]);
  const owner: ProviderOwner = {
    owner_id: project.owner_id,
    kind: rawOwner?.kind === "github" ? "github" : "guest",
  };
  return resolveProvider({
    config,
    store,
    owner,
    settings,
    selectedModel: project.model_override || effectiveModelSelector(config, store, owner, settings),
  });
}

/** Build a deployment-owned provider without consulting a user's key vault. */
export function resolveDeploymentProvider(input: {
  providerId?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
  connectionId: string;
}): ProviderConfig | null {
  const providerId = input.providerId?.trim() || "deepseek";
  const baseUrl = input.baseUrl?.trim() || presetBaseUrl(providerId as ProviderPreset) || "";
  const modelId = input.model?.trim() || "";
  const apiKey = input.apiKey?.trim() || "";
  if (!baseUrl || !modelId || !apiKey) return null;
  if (providerId === "custom") {
    return {
      provider: "deployment-custom",
      connectionId: input.connectionId,
      baseUrl,
      apiKey,
      model: modelId,
      modelSelector: `deployment:${input.connectionId}:${modelId}`,
      modelId,
      api: "openai-completions",
      builtin: false,
      reasoning: true,
      thinkingLevel: "low",
    };
  }
  if (!SUPPORTED_PROVIDER_IDS.includes(providerId as ProviderPreset)) return null;
  const preset = providerPreset(providerId);
  if (!preset) return null;
  const connection: ProviderConnectionSettings = {
    connection_id: input.connectionId,
    provider: providerId as ProviderPreset,
    label: providerId,
    base_url: null,
    custom_models: [modelId],
    last_verified_at: null,
    verify_error: null,
  };
  const catalog = catalogModelsForConnection(connection, { includePending: true })
    .find((candidate) => candidate.id === modelId);
  const capability = modelCapabilityFor(providerId, modelId, catalog as Model<Api> | undefined);
  const capabilityModel = {
    reasoning: catalog?.reasoning ?? capability.reasoning,
    thinkingLevelMap: catalog?.thinkingLevelMap ?? capability.thinkingLevelMap,
  };
  const supportsPiThinking = hasPiThinkingControls(capabilityModel);
  const adapterProvider = piProviderId(providerId);
  return {
    provider: providerId,
    adapterProvider: adapterProvider ?? undefined,
    connectionId: input.connectionId,
    baseUrl,
    apiKey,
    model: modelId,
    modelSelector: `deployment:${input.connectionId}:${modelId}`,
    modelId,
    api: catalog?.api ?? preset.api,
    builtin: Boolean(catalog && adapterProvider),
    contextWindow: catalog?.contextWindow,
    maxOutputTokens: catalog?.maxTokens,
    reasoning: supportsPiThinking,
    thinkingLevelMap: supportsPiThinking ? capabilityModel.thinkingLevelMap : undefined,
    compat: catalog?.compat ?? capability.compat,
    authHeader: catalog?.authHeader ?? preset.authHeader,
    thinkingLevel: supportsPiThinking
      ? thinkingLevelsForModel(capabilityModel).at(-1) ?? "off"
      : "off",
    cost: providerCostEstimate(modelId, baseUrl, catalog && "cost" in catalog ? catalog.cost : undefined),
  };
}

function providerCostEstimate(modelId: string, baseUrl: string, catalogCost: ProviderConfig["cost"]): ProviderConfig["cost"] {
  // Verified 2026-09-11: https://api-docs.deepseek.com/quick_start/pricing/
  // Reserve/estimate at published peak rates; time-of-day discounts and the final
  // invoice belong to the provider. Do not apply official rates to relay services.
  if (URL.canParse(baseUrl) && new URL(baseUrl).hostname === "api.deepseek.com") {
    if (modelId === "deepseek-flash" || modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-flash-vision-exp") {
      return { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 };
    }
    if (modelId === "deepseek-v4.1-flash-expires-on-0910") {
      return { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 };
    }
    if (modelId === "deepseek-v4-pro") return { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 };
  }
  return catalogCost;
}
