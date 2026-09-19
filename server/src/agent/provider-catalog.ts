import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";
import { modelLifecycle } from "./model-lifecycle.js";

export type ProviderCompat = OpenAICompletionsCompat | AnthropicMessagesCompat;

// Invalidate published analysis reuse when endpoint request semantics change.
export const PROVIDER_WIRE_VERSION = "provider-wire-v3-scoped-qwen-output-limit";

export type ProviderPreset =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "zai"
  | "zai-api-cn"
  | "zai-coding-global"
  | "zai-coding-cn"
  | "zai-anthropic-cn"
  | "moonshotai"
  | "moonshotai-cn"
  | "kimi-coding"
  | "kimi-coding-openai"
  | "qwen-token-plan"
  | "qwen-token-plan-cn"
  | "qwen-token-plan-individual"
  | "qwen-token-plan-personal-cn"
  | "qwen-token-plan-team-cn"
  | "qwen-coding-plan-cn"
  | "qwen-token-plan-anthropic-cn"
  | "qwen-token-plan-personal-anthropic-cn"
  | "qwen-token-plan-team-anthropic-cn"
  | "qwen-coding-plan-anthropic-cn"
  | "qwen-api-cn"
  | "qwen-api-intl"
  | "minimax"
  | "minimax-cn"
  | "minimax-openai-cn"
  | "minimax-token-plan-cn"
  | "minimax-token-plan-openai-cn"
  | "xiaomi"
  | "xiaomi-token-plan-cn"
  | "xiaomi-anthropic-cn"
  | "xiaomi-token-plan-anthropic-cn"
  | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp"
  | "doubao"
  | "doubao-coding-plan-cn"
  | "doubao-agent-plan-cn"
  | "hunyuan"
  | "hunyuan-tokenhub-api-cn"
  | "hunyuan-tokenhub-anthropic-cn"
  | "hunyuan-token-plan-cn"
  | "hunyuan-token-plan-enterprise-cn"
  | "hunyuan-coding-plan-cn"
  | "custom";

export type ProviderApi = "openai-completions" | "anthropic-messages";
export type ProviderAuthHeader = "api-key" | "authorization";

export interface VerifiedModelCapabilityOverride {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: ProviderCompat;
}

/**
 * Product-side model facts verified from an upstream model document.
 * Provider IDs are intentionally not part of the key: the same model may be
 * exposed by several relays, while its intrinsic thinking capability is
 * verified only once. API/provider overrides only describe wire differences.
 */
export interface VerifiedModelCapability {
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: ProviderCompat;
  byApi?: Partial<Record<ProviderApi, VerifiedModelCapabilityOverride>>;
  byProvider?: Readonly<Record<string, VerifiedModelCapabilityOverride>>;
}

export interface ProviderCatalogModel {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  reasoning: boolean;
  /** Pi's model-level mapping, reused only when the same model ID is found upstream. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Explicit wire-format settings for this provider endpoint. */
  compat?: ProviderCompat;
  /** Optional provider-specific API-key header in addition to Pi's auth field. */
  authHeader?: ProviderAuthHeader;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderPresetDefinition {
  id: ProviderPreset;
  family: string;
  family_label: string;
  variant_label: string;
  label: string;
  base_url: string;
  custom_base_url: boolean;
  api: ProviderApi;
  pi_provider?: string;
  /** Explicit wire-format settings for OpenAI/Anthropic-compatible endpoints. */
  compat?: ProviderCompat;
  /** Optional provider-specific API-key header in addition to Pi's auth field. */
  authHeader?: ProviderAuthHeader;
  icon: string;
}

// A provider's OpenAI-compatible /models endpoint may mix chat models with
// task-specific generators and utility models. Keep this deny-list narrow:
// vision/vl/multimodal names remain eligible because they can still answer
// conversational requests; only explicit generation/utility naming is removed.
const ALWAYS_NON_CONVERSATIONAL_MODEL_ID_PATTERNS: readonly RegExp[] = [
  /^(?:hy|hunyuan)[-_.]mt\d*(?:[-_.]|$)/i,
  /^doubao[-_.]seed[-_.]translation(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:seededit|seed3d|seaweed|tripo|hi3d|hitem3d|hyper3d|indextts)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:kl|vd|pixverse)[-_.]video(?:[-_.]|$)/i,
  /(?:^|[-_.])wand[-_.](?:dubbing|vega[-_.]image)(?:\d|[-_.]|$)/i,
  /(?:^|[-_.])(?:hy|hunyuan)[-_.]world\d*(?:[-_.]|$)/i,
  /(?:^|[-_.])seedance(?:[-_.]|$)/i,
  /(?:^|[-_.])seedream(?:[-_.]|$)/i,
  /(?:^|[-_.])vidu(?:[-_.]|$)/i,
  /(?:^|[-_.])cogview(?:[-_.]|$)/i,
  /(?:^|[-_.])speech[-_.]v?\d+(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:kling|pixverse|hunyuan|hy|yt|doubao|minimax)[-_.]video(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:hunyuan|hy|doubao|minimax)[-_.](?:image|music|voice|speech)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:qwen|hunyuan|hy|doubao|wan|flux|sdxl|stable[-_.]?diffusion)[-_.]image(?:[-_.]|$)/i,
];

const NON_CONVERSATIONAL_MODEL_ID_PATTERNS: readonly RegExp[] = [
  /(?:^|[-_.])(?:text|image|video|audio)[-_.]to[-_.](?:image|video|audio|music)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:image|video|audio|music)[-_.]?(?:gen|generation|synthesis|creation|edit|t2i|t2v|i2v|v2v)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:t2i|t2v|i2v|v2v|text2image|text2video|image2video)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:video|image|music|audio)[-_.]v?\d+(?:[.-]\d+)*(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:flux|imagen|stable[-_.]?diffusion|sdxl|cogvideox)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:text[-_.]?embedding|embedding|embeddings|embed|rerank|reranker|tts|asr|stt|moderation)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:bge|e5|gte|m3e)[-_.](?:m3|large|base|small|multilingual|embedding|reranker)(?:[-_.]|$)/i,
  /(?:^|[-_.])jina[-_.]?embeddings?(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:hunyuan|hy|doubao|qwen)[-_.]3d(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:3d|avatar)[-_.](?:generation|gen|creation)(?:[-_.]|$)/i,
];

const CONVERSATIONAL_VIDEO_MODEL_HINT = /(?:vision|vl|multimodal)[-_.]video|video[-_.](?:understanding|qa|caption|analysis)/i;

export function isLikelyConversationalModelId(modelId: string): boolean {
  // Provider namespaces are not model capabilities. Inspect the final model
  // name, but keep the original ID unchanged for selection and requests.
  const normalized = modelId.trim().split("/").at(-1) ?? "";
  if (!normalized) return false;
  if (ALWAYS_NON_CONVERSATIONAL_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  if (CONVERSATIONAL_VIDEO_MODEL_HINT.test(normalized)) return true;
  return !NON_CONVERSATIONAL_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface ProviderModelContext {
  provider?: string;
  base_url?: string | null;
  now?: number;
}

export function connectionModelLifecycle(modelId: string, context: ProviderModelContext) {
  const baseUrl = context.provider === "custom" ? context.base_url
    : providerPreset(context.provider ?? "")?.base_url || context.base_url;
  return modelLifecycle(modelId, baseUrl, context.now);
}

export function filterLikelyConversationalModelIds(modelIds: readonly string[], context: ProviderModelContext = {}): string[] {
  const unique = new Set<string>();
  for (const candidate of modelIds) {
    const id = candidate.trim();
    if (id.length > 500 || /[\s\u0000-\u001f\u007f]/u.test(id)) continue;
    if (!isLikelyConversationalModelId(id) || connectionModelLifecycle(id, context)?.active || unique.has(id)) continue;
    unique.add(id);
    if (unique.size >= 100) break;
  }
  return [...unique];
}

/** Read capability metadata before applying the ID fallback or the list limit. */
export function discoverProviderModels(payload: unknown, context: ProviderModelContext = {}): {
  models: string[]; excludedModels: string[]; valid: boolean;
} {
  const invalid = { models: [], excludedModels: [], valid: false };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalid;
  const row = payload as Record<string, unknown>;
  const source = [row.data, row.models, row.items].find(Array.isArray);
  if (!source) return invalid;
  const excluded = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
      .filter((item): item is string => typeof item === "string").map(item => item.trim().toLowerCase());
  const ids = source.flatMap((candidate: unknown): string[] => {
    const item = typeof candidate === "string" ? { id: candidate } : record(candidate);
    const id = (typeof item.id === "string" ? item.id : typeof item.model === "string" ? item.model : typeof item.name === "string" ? item.name : "").trim();
    const reject = (): string[] => { if (id) excluded.add(id); return []; };
    const status = String(item.status ?? "").toLowerCase().replace(/[-_\s]/g, "");
    if (/^(shutdown|offline|disabled|deleted|unavailable|retired|discontinued|decommissioned)$/.test(status)) return reject();
    // Retiring / pre-offline still accept calls; do not silently treat them as offline.
    const tasks = [...strings(item.task_type), ...strings(item.model_type)].map(task => task.replace(/[-_\s]/g, ""));
    if (tasks.some(task => /^(embedding|embeddings|rerank|reranker|texttoimage|texttovideo|imagetovideo|imagegeneration|videogeneration|speechsynthesis|speechrecognition|tts|asr|3dgeneration|translation|machinetranslation|texttranslation)$/.test(task))) return reject();
    const modalities = record(item.modalities);
    const input = strings(item.input_modalities ?? modalities.input_modalities);
    const output = strings(item.output_modalities ?? modalities.output_modalities ?? record(item.architecture).output_modalities);
    if ((input.length && !input.includes("text")) || (output.length && !output.includes("text"))) return reject();
    // Some endpoints include a readable generation family even when the ID is opaque.
    if (!filterLikelyConversationalModelIds([id], context).length
      || (typeof item.name === "string" && !isLikelyConversationalModelId(item.name))) return reject();
    // TokenHub lists opaque task IDs without capability metadata. Only infer
    // chat for recognized language-model families; unknown IDs can be added
    // through the real chat probe instead of being silently called "verified".
    if (context.provider?.startsWith("hunyuan-tokenhub") && !output.includes("text")) {
      const name = id.split("/").at(-1) ?? "";
      if (!/^(?:hy\d|hy[-_.](?:vision|role)|hunyuan[-_.]|youtu[-_.]vita|deepseek[-_.]|glm[-_.]|kimi[-_.]|moonshot[-_.]|qwen|qwq|qvq|mimo[-_.]|minimax[-_.](?:m\d|text)|doubao[-_.]|gpt[-_.]|o[134](?:[-_.]|$)|claude[-_.]|gemini[-_.]|llama|mistral|mixtral)/i.test(name)) return [];
    }
    return [id];
  });
  // A duplicate online row must not override explicit negative metadata.
  return { models: filterLikelyConversationalModelIds(ids.filter(id => !excluded.has(id)), context), excludedModels: [...excluded], valid: true };
}

export function providerModelIds(payload: unknown, provider?: string): string[] {
  return discoverProviderModels(payload, { provider }).models;
}

/** Absence or unknown capabilities are not evidence that a manual model died. */
export function mergeDiscoveredModelIds(
  discovered: { models: string[]; excludedModels?: string[] }, manual: readonly string[], context: ProviderModelContext,
): string[] {
  const excluded = new Set(discovered.excludedModels);
  return filterLikelyConversationalModelIds([...manual, ...discovered.models].filter(id => !excluded.has(id)), context);
}

const synthetic = (
  id: ProviderPreset,
  family: string,
  familyLabel: string,
  variantLabel: string,
  baseUrl: string,
  options: {
    api?: ProviderApi;
    compat?: ProviderCompat;
    authHeader?: ProviderAuthHeader;
    icon?: string;
    piProvider?: string | false;
  } = {},
): ProviderPresetDefinition => ({
  id,
  family,
  family_label: familyLabel,
  variant_label: variantLabel,
  label: familyLabel + " · " + variantLabel,
  base_url: baseUrl,
  custom_base_url: false,
  api: options.api ?? "openai-completions",
  pi_provider: options.piProvider === false ? undefined : options.piProvider ?? id,
  compat: options.compat,
  authHeader: options.authHeader,
  icon: options.icon ?? family,
});

const OPENAI_COMPAT_DEFAULTS: OpenAICompletionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
};

// Conservative defaults for third-party Anthropic-compatible endpoints. The
// adapter omits optional Anthropic extensions unless the provider is known to
// support them.
const ANTHROPIC_COMPAT_DEFAULTS: AnthropicMessagesCompat = {
  supportsEagerToolInputStreaming: false,
  supportsLongCacheRetention: false,
  supportsCacheControlOnTools: false,
  supportsTemperature: true,
  supportsStrictTools: false,
  supportsToolReferences: false,
};

const QWEN_COMPAT: OpenAICompletionsCompat = {
  ...OPENAI_COMPAT_DEFAULTS,
  thinkingFormat: "qwen",
};

const MIMO_COMPAT: OpenAICompletionsCompat = {
  ...OPENAI_COMPAT_DEFAULTS,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
};

const HUNYUAN_COMPAT: OpenAICompletionsCompat = {
  ...OPENAI_COMPAT_DEFAULTS,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
};

const ZAI_COMPAT: OpenAICompletionsCompat = {
  ...OPENAI_COMPAT_DEFAULTS,
  thinkingFormat: "zai",
  zaiToolStream: true,
};

const TENCENT_TOKENHUB_COMPAT: OpenAICompletionsCompat = {
  ...HUNYUAN_COMPAT,
  supportsReasoningEffort: true,
};

const KIMI_OPENAI_COMPAT: OpenAICompletionsCompat = {
  ...OPENAI_COMPAT_DEFAULTS,
  supportsReasoningEffort: true,
  supportsStrictMode: false,
  thinkingFormat: "openai",
  requiresReasoningContentOnAssistantMessages: true,
  deferredToolsMode: "kimi",
};

const BINARY_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: "disabled",
  minimal: null,
  low: "enabled",
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

const EFFORT_3_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

const DEEPSEEK_V4_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: "disabled",
  minimal: null,
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
};

const GLM_5_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: "none",
  minimal: null,
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const GLM_53_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

const HY3_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: "disabled",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: null,
};

const KIMI_K3_THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

const modelCapabilityAliases = (
  ids: readonly string[],
  capability: VerifiedModelCapability,
): Record<string, VerifiedModelCapability> => Object.fromEntries(
  ids.map((id) => [id, capability]),
);

const providerCapabilityOverrides = (
  providers: readonly string[],
  override: VerifiedModelCapabilityOverride,
): Readonly<Record<string, VerifiedModelCapabilityOverride>> => Object.fromEntries(
  providers.map((provider) => [provider, override]),
);

const QWEN_PROVIDER_IDS = [
  "qwen-token-plan-cn",
  "qwen-token-plan-personal-cn",
  "qwen-token-plan-team-cn",
  "qwen-coding-plan-cn",
  "qwen-api-cn",
] as const;

// Only these documented models on Alibaba's OpenAI-compatible endpoints use
// the total (thinking + answer) output limit. Old models and other relays keep
// their own field; this set never supplies selectable models to the UI.
// https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
const QWEN_TOTAL_OUTPUT_MODEL_IDS = new Set([
  "qwen3.5-plus", "qwen3.5-plus-2026-02-15", "qwen3.5-flash", "qwen3.5-flash-2026-02-23",
  "qwen3.6-plus", "qwen3.6-plus-2026-04-08", "qwen3.6-flash", "qwen3.6-flash-2026-04-08",
  "qwen3.7-max", "qwen3.7-max-2026-06-08", "qwen3.7-plus", "qwen3.7-plus-2026-05-18",
  "qwen3.7-flash", "qwen3.7-flash-2026-05-18", "qwen3.8-max", "qwen3.8-flash",
  "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
  "glm-5", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5-turbo",
  "MiniMax-M2.5", "MiniMax-M2.7", "MiniMax-M3",
  "deepseek-v3", "deepseek-r1", "deepseek-r1-0528", "deepseek-v3.1",
  "deepseek-v3.2", "deepseek-v3.2-exp", "deepseek-v4-pro", "deepseek-v4-flash",
]);

const HUNYUAN_PROVIDER_IDS = [
  "hunyuan",
  "hunyuan-tokenhub-api-cn",
  "hunyuan-token-plan-cn",
  "hunyuan-token-plan-enterprise-cn",
  "hunyuan-coding-plan-cn",
] as const;

const QWEN_BINARY_OVERRIDE: VerifiedModelCapabilityOverride = {
  reasoning: true,
  thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
};

const HUNYUAN_BINARY_OVERRIDE: VerifiedModelCapabilityOverride = {
  reasoning: true,
  thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
  compat: { supportsReasoningEffort: false },
};

const DEEPSEEK_V4_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: DEEPSEEK_V4_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: true } },
  },
};

const GLM_5_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: GLM_5_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: true } },
  },
};

const GLM_53_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: GLM_53_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: true } },
  },
};

const GLM_BINARY_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
};

const DOUBAO_20_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: EFFORT_3_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: true } },
  },
};

const HY3_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: HY3_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: true } },
  },
};

const HY4_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
  byApi: {
    "openai-completions": { compat: { supportsReasoningEffort: false } },
  },
};

const KIMI_K3_CAPABILITY: VerifiedModelCapability = {
  reasoning: true,
  thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP,
  byApi: {
    "anthropic-messages": {
      reasoning: true,
      thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP,
    },
  },
  byProvider: {
    "kimi-coding-openai": { compat: KIMI_OPENAI_COMPAT },
  },
};

const MINIMAX_M3_CAPABILITY: VerifiedModelCapability = {
  reasoning: false,
  byApi: {
    "anthropic-messages": {
      reasoning: true,
      thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
    },
  },
};

/**
 * Exact model IDs confirmed by the provider model tables. This is a capability
 * index only; it never supplies models to the UI before the provider returns
 * the same ID from its verified `/models` endpoint.
 */
export const VERIFIED_MODEL_CAPABILITIES: Readonly<Record<string, VerifiedModelCapability>> = {
  // GA 2026-09-10: https://api-docs.deepseek.com/updates/
  "deepseek-flash": DEEPSEEK_V4_CAPABILITY,
  // Temporary 2026-09-08 beta: preserve the Flash thinking protocol when explicitly
  // configured. This entry does not advertise the model or bypass manual verification.
  "deepseek-v4.1-flash-expires-on-0910": DEEPSEEK_V4_CAPABILITY,
  ...modelCapabilityAliases([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4-flash-0731",
    "deepseek-v4-pro-0813",
    "deepseek-v4-flash-202605",
    "deepseek-v4-pro-202606",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-flash-202605",
    "deepseek/deepseek-v4-pro-202606",
  ], DEEPSEEK_V4_CAPABILITY),
  "deepseek-v3.2": {
    reasoning: true,
    thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
  },
  ...modelCapabilityAliases([
    "glm-5",
    "glm-5.1",
    "glm-5.2",
    "glm-5-turbo",
  ], GLM_5_CAPABILITY),
  ...modelCapabilityAliases(["glm-5.3", "glm-5-3", "glm-5.3-flash"], GLM_53_CAPABILITY),
  ...modelCapabilityAliases([
    "glm-4.7",
    "glm-4.7-flash",
    "glm-4.7-flashx",
    "glm-4.6",
    "glm-4.5",
    "glm-4.5-air",
    "glm-4.5-airx",
    "glm-4.5-flash",
    "glm-4-long",
  ], GLM_BINARY_CAPABILITY),
  "glm-5.2-highspeed": { reasoning: false },
  ...modelCapabilityAliases([
    "qwen3-max-2026-01-23",
    "qwen3-max",
    "qwen3-max-preview",
    "qwen3.5-plus",
    "qwen3.5-plus-2026-02-15",
    "qwen3.5-flash",
    "qwen3.5-flash-2026-02-23",
    "qwen3.6-flash",
    "qwen3.6-flash-2026-04-08",
    "qwen3.6-plus",
    "qwen3.6-plus-2026-04-08",
    "qwen3.7-flash",
    "qwen3.7-flash-2026-05-18",
    "qwen3.7-max",
    "qwen3.7-max-2026-06-08",
    "qwen3.7-plus",
    "qwen3.7-plus-2026-05-18",
    "qwen3.8-flash",
  ], {
    reasoning: true,
    thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
    byProvider: {
      ...providerCapabilityOverrides(QWEN_PROVIDER_IDS, QWEN_BINARY_OVERRIDE),
      ...providerCapabilityOverrides(HUNYUAN_PROVIDER_IDS, HUNYUAN_BINARY_OVERRIDE),
    },
  }),
  ...modelCapabilityAliases([
    "qwen3-coder-plus",
    "qwen3-coder-next",
    "qwen3-coder-flash",
    "qwen3-235b-a22b-thinking-2507",
    "qwen3-30b-a3b-thinking-2507",
    "qwen3-next-80b-a3b-instruct",
    "qwq-plus",
    "qwq-32b",
    "qvq-max",
    "qvq-plus",
  ], {
    reasoning: true,
    thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
    byProvider: providerCapabilityOverrides(QWEN_PROVIDER_IDS, QWEN_BINARY_OVERRIDE),
  }),
  ...modelCapabilityAliases([
    "deepseek-v3.1",
    "deepseek-v3.1-terminus",
    "deepseek-v3.2-exp",
    "deepseek-r1",
    "deepseek-r1-0528",
  ], {
    reasoning: true,
    thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
    byProvider: providerCapabilityOverrides(QWEN_PROVIDER_IDS, QWEN_BINARY_OVERRIDE),
  }),
  ...modelCapabilityAliases([
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "minimax-m2.5",
    "minimax-m-2-5",
    "minimax-m2.7",
    "minimax-m-2-7",
  ], { reasoning: false }),
  ...modelCapabilityAliases([
    "MiniMax-M3",
    "minimax-m3",
    "minimax-m-3-0",
  ], MINIMAX_M3_CAPABILITY),
  ...modelCapabilityAliases([
    "mimo-v2-flash",
    "mimo-v2-omni",
    "mimo-v2-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "mimo-v2.5-pro-ultraspeed",
  ], { reasoning: true, thinkingLevelMap: BINARY_THINKING_LEVEL_MAP }),
  ...modelCapabilityAliases([
    "k3",
    "k3-256k",
    "kimi-k3",
    "Kimi-K3",
  ], KIMI_K3_CAPABILITY),
  ...modelCapabilityAliases([
    "kimi-k2.5",
    "kimi-k2.6",
  ], {
    reasoning: true,
    thinkingLevelMap: BINARY_THINKING_LEVEL_MAP,
    byProvider: {
      ...providerCapabilityOverrides(QWEN_PROVIDER_IDS, QWEN_BINARY_OVERRIDE),
      ...providerCapabilityOverrides(HUNYUAN_PROVIDER_IDS, HUNYUAN_BINARY_OVERRIDE),
    },
  }),
  ...modelCapabilityAliases([
    "kimi-for-coding",
    "kimi-for-coding-highspeed",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
  ], { reasoning: false }),
  ...modelCapabilityAliases([
    "doubao-seed-1.6",
    "doubao-seed-1.6-thinking",
    "doubao-seed-1.6-flash",
    "doubao-seed-2-1-pro",
    "doubao-seed-2.1-pro",
    "doubao-seed-2-1-turbo",
    "doubao-seed-2.1-turbo",
    "doubao-seed-evolving",
    "doubao-seed-code",
    "ark-code-latest",
  ], { reasoning: false }),
  ...modelCapabilityAliases([
    "doubao-seed-2-0-pro-260215",
    "doubao-seed-2.0-pro-260215",
    "doubao-seed-2.0-pro",
    "doubao-seed-2-0-lite-260215",
    "doubao-seed-2.0-lite-260215",
    "doubao-seed-2.0-lite",
    "doubao-seed-2-0-mini-260215",
    "doubao-seed-2.0-mini-260215",
    "doubao-seed-2.0-mini",
    "doubao-seed-2-0-code-260215",
    "doubao-seed-2.0-code-260215",
    "doubao-seed-2.0-code",
  ], DOUBAO_20_CAPABILITY),
  ...modelCapabilityAliases(["hy4-preview"], HY4_CAPABILITY),
  ...modelCapabilityAliases(["hy3", "hy3-preview", "hy3-202608"], HY3_CAPABILITY),
  "tc-code-latest": { reasoning: false },
} as const;

export function verifiedModelCapability(
  modelId: string,
  api?: ProviderApi,
  provider?: string,
): VerifiedModelCapabilityOverride | null {
  const base = VERIFIED_MODEL_CAPABILITIES[modelId.trim()];
  const qwenTotalOutput = api === "openai-completions"
    && QWEN_PROVIDER_IDS.some((id) => id === provider)
    && QWEN_TOTAL_OUTPUT_MODEL_IDS.has(modelId.trim());
  if (!base && !qwenTotalOutput) return null;
  const override = provider ? base?.byProvider?.[provider] : undefined;
  const apiOverride = api ? base?.byApi?.[api] : undefined;
  const selected = override ?? apiOverride;
  const compat = selected?.compat ?? base?.compat;
  return {
    reasoning: selected?.reasoning ?? base?.reasoning,
    thinkingLevelMap: selected?.thinkingLevelMap ?? base?.thinkingLevelMap,
    compat: qwenTotalOutput ? { ...compat, maxTokensField: "max_completion_tokens" } : compat,
  };
}

export const PROVIDER_PRESETS: readonly ProviderPresetDefinition[] = [
  synthetic("deepseek", "deepseek", "DeepSeek", "官方 API", "https://api.deepseek.com", {
    icon: "deepseek",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      // DeepSeek does not use OpenAI's max_completion_tokens field.
      maxTokensField: "max_tokens",
    },
  }),
  synthetic("qwen-token-plan-cn", "qwen", "通义千问", "Token Plan · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", {
    icon: "qwen",
    compat: QWEN_COMPAT,
  }),
  synthetic("qwen-token-plan-personal-cn", "qwen", "通义千问", "Token Plan 个人版 · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", {
    icon: "qwen",
    piProvider: "qwen-token-plan-cn",
    compat: QWEN_COMPAT,
  }),
  synthetic("qwen-token-plan-team-cn", "qwen", "通义千问", "Token Plan 团队版 · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", {
    icon: "qwen",
    piProvider: "qwen-token-plan-cn",
    compat: QWEN_COMPAT,
  }),
  synthetic("qwen-coding-plan-cn", "qwen", "通义千问", "Coding Plan · 中国大陆", "https://coding.dashscope.aliyuncs.com/v1", {
    icon: "qwen",
    piProvider: "qwen-token-plan-cn",
    compat: QWEN_COMPAT,
  }),
  synthetic("qwen-token-plan-anthropic-cn", "qwen", "通义千问", "Token Plan Anthropic · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", {
    api: "anthropic-messages",
    icon: "qwen",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("qwen-token-plan-personal-anthropic-cn", "qwen", "通义千问", "Token Plan 个人版 Anthropic · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", {
    api: "anthropic-messages",
    icon: "qwen",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("qwen-token-plan-team-anthropic-cn", "qwen", "通义千问", "Token Plan 团队版 Anthropic · 中国大陆", "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", {
    api: "anthropic-messages",
    icon: "qwen",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("qwen-coding-plan-anthropic-cn", "qwen", "通义千问", "Coding Plan Anthropic · 中国大陆", "https://coding.dashscope.aliyuncs.com/apps/anthropic", {
    api: "anthropic-messages",
    icon: "qwen",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("qwen-api-cn", "qwen", "通义千问", "百炼兼容 API · 中国大陆", "https://dashscope.aliyuncs.com/compatible-mode/v1", {
    icon: "qwen",
    piProvider: false,
    compat: QWEN_COMPAT,
  }),
  synthetic("minimax-cn", "minimax", "MiniMax", "API · 中国大陆", "https://api.minimaxi.com/anthropic", { api: "anthropic-messages", icon: "minimax" }),
  synthetic("minimax-openai-cn", "minimax", "MiniMax", "OpenAI 兼容 API · 中国大陆", "https://api.minimaxi.com/v1", {
    icon: "minimax",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("minimax-token-plan-cn", "minimax", "MiniMax", "Token Plan · 中国大陆", "https://api.minimaxi.com/anthropic", { api: "anthropic-messages", icon: "minimax", piProvider: "minimax-cn" }),
  synthetic("minimax-token-plan-openai-cn", "minimax", "MiniMax", "Token Plan OpenAI 兼容 · 中国大陆", "https://api.minimaxi.com/v1", {
    icon: "minimax",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("xiaomi", "mimo", "小米 MiMo", "官方 API", "https://api.xiaomimimo.com/v1", { icon: "xiaomi", authHeader: "api-key", compat: MIMO_COMPAT }),
  synthetic("xiaomi-token-plan-cn", "mimo", "小米 MiMo", "Token Plan · 中国大陆", "https://token-plan-cn.xiaomimimo.com/v1", { icon: "xiaomi", authHeader: "api-key", compat: MIMO_COMPAT }),
  synthetic("xiaomi-anthropic-cn", "mimo", "小米 MiMo", "Anthropic 兼容 API · 中国大陆", "https://api.xiaomimimo.com/anthropic", {
    api: "anthropic-messages",
    icon: "xiaomi",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("xiaomi-token-plan-anthropic-cn", "mimo", "小米 MiMo", "Token Plan Anthropic · 中国大陆", "https://token-plan-cn.xiaomimimo.com/anthropic", {
    api: "anthropic-messages",
    icon: "xiaomi",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("zai-api-cn", "glm", "智谱 GLM", "开放平台 API · 中国大陆", "https://open.bigmodel.cn/api/paas/v4", { icon: "zhipu", piProvider: "zai" }),
  synthetic("zai-coding-cn", "glm", "智谱 GLM", "Coding Plan · 中国大陆", "https://open.bigmodel.cn/api/coding/paas/v4", { icon: "zhipu", compat: ZAI_COMPAT }),
  synthetic("zai-anthropic-cn", "glm", "智谱 GLM", "Anthropic 兼容 API · 中国大陆", "https://open.bigmodel.cn/api/anthropic", {
    api: "anthropic-messages",
    icon: "zhipu",
    piProvider: false,
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("moonshotai-cn", "kimi", "Kimi", "API · 中国大陆", "https://api.moonshot.cn/v1", { icon: "moonshot" }),
  synthetic("kimi-coding", "kimi", "Kimi", "Coding Plan", "https://api.kimi.com/coding", { api: "anthropic-messages", icon: "moonshot" }),
  synthetic("kimi-coding-openai", "kimi", "Kimi", "Coding Plan OpenAI 兼容", "https://api.kimi.com/coding/v1", {
    icon: "moonshot",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("doubao", "doubao", "豆包", "火山方舟兼容 API", "https://ark.cn-beijing.volces.com/api/v3", {
    icon: "doubao",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("doubao-coding-plan-cn", "doubao", "豆包", "Coding Plan · 中国大陆", "https://ark.cn-beijing.volces.com/api/coding/v3", {
    icon: "doubao",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("doubao-agent-plan-cn", "doubao", "豆包", "Agent Plan · 中国大陆", "https://ark.cn-beijing.volces.com/api/plan/v3", {
    icon: "doubao",
    piProvider: false,
    compat: OPENAI_COMPAT_DEFAULTS,
  }),
  synthetic("hunyuan", "hunyuan", "腾讯混元", "OpenAI 兼容 API", "https://api.hunyuan.cloud.tencent.com/v1", {
    icon: "hunyuan",
    piProvider: false,
    compat: HUNYUAN_COMPAT,
  }),
  synthetic("hunyuan-tokenhub-api-cn", "hunyuan", "腾讯混元", "TokenHub 按量 API · 中国大陆", "https://tokenhub.tencentmaas.com/v1", {
    icon: "hunyuan",
    piProvider: false,
    compat: TENCENT_TOKENHUB_COMPAT,
  }),
  synthetic("hunyuan-tokenhub-anthropic-cn", "hunyuan", "腾讯混元", "TokenHub Anthropic · 中国大陆", "https://tokenhub.tencentmaas.com", {
    api: "anthropic-messages",
    icon: "hunyuan",
    piProvider: false,
    authHeader: "authorization",
    compat: ANTHROPIC_COMPAT_DEFAULTS,
  }),
  synthetic("hunyuan-token-plan-cn", "hunyuan", "腾讯混元", "Token Plan · 中国大陆", "https://api.lkeap.cloud.tencent.com/plan/v3", {
    icon: "hunyuan",
    piProvider: false,
    compat: TENCENT_TOKENHUB_COMPAT,
  }),
  synthetic("hunyuan-token-plan-enterprise-cn", "hunyuan", "腾讯混元", "Token Plan 企业版 · 中国大陆", "https://tokenhub.tencentmaas.com/plan/v3", {
    icon: "hunyuan",
    piProvider: false,
    compat: TENCENT_TOKENHUB_COMPAT,
  }),
  synthetic("hunyuan-coding-plan-cn", "hunyuan", "腾讯混元", "Coding Plan · 中国大陆", "https://api.lkeap.cloud.tencent.com/coding/v3", {
    icon: "hunyuan",
    piProvider: false,
    compat: TENCENT_TOKENHUB_COMPAT,
  }),
  {
    id: "custom",
    family: "custom",
    family_label: "自定义接口",
    variant_label: "OpenAI 兼容",
    label: "自定义 OpenAI 兼容接口",
    base_url: "",
    custom_base_url: true,
    api: "openai-completions",
    icon: "custom",
  },
] as const;

// These definitions remain readable so old settings can be shown and deleted,
// but they are deliberately excluded from the public provider picker and from
// model resolution. Use the supported presets or a custom endpoint instead.
const RETIRED_PROVIDER_PRESETS: readonly ProviderPresetDefinition[] = [
  synthetic("qwen-token-plan", "qwen", "通义千问", "已停用的境外 Token Plan", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", { icon: "qwen" }),
  synthetic("qwen-token-plan-individual", "qwen", "通义千问", "已停用的境外个人版", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", { icon: "qwen" }),
  synthetic("qwen-api-intl", "qwen", "通义千问", "已停用的境外 API", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", { icon: "qwen", piProvider: false }),
  synthetic("minimax", "minimax", "MiniMax", "已停用的境外 API", "https://api.minimax.io/anthropic", { api: "anthropic-messages", icon: "minimax" }),
  synthetic("xiaomi-token-plan-ams", "mimo", "小米 MiMo", "已停用的欧洲 Token Plan", "https://token-plan-ams.xiaomimimo.com/v1", { icon: "xiaomi" }),
  synthetic("xiaomi-token-plan-sgp", "mimo", "小米 MiMo", "已停用的新加坡 Token Plan", "https://token-plan-sgp.xiaomimimo.com/v1", { icon: "xiaomi" }),
  synthetic("zai", "glm", "智谱 GLM", "已停用的境外 Coding Plan", "https://api.z.ai/api/coding/paas/v4", { icon: "zhipu", piProvider: "zai" }),
  synthetic("zai-coding-global", "glm", "智谱 GLM", "已停用的境外 Coding Plan", "https://api.z.ai/api/coding/paas/v4", { icon: "zhipu", piProvider: "zai" }),
  synthetic("moonshotai", "kimi", "Kimi", "已停用的境外 API", "https://api.moonshot.ai/v1", { icon: "moonshot" }),
];

const LEGACY_PROVIDER_PRESETS: readonly ProviderPresetDefinition[] = [
  {
    id: "openai",
    family: "openai",
    family_label: "OpenAI",
    variant_label: "历史连接",
    label: "OpenAI（历史连接）",
    base_url: "https://api.openai.com/v1",
    custom_base_url: false,
    api: "openai-completions",
    pi_provider: "openai",
    icon: "openai",
  },
  {
    id: "anthropic",
    family: "anthropic",
    family_label: "Anthropic",
    variant_label: "历史连接",
    label: "Anthropic（历史连接）",
    base_url: "https://api.anthropic.com",
    custom_base_url: false,
    api: "anthropic-messages",
    pi_provider: "anthropic",
    icon: "anthropic",
  },
  {
    id: "google",
    family: "google",
    family_label: "Google",
    variant_label: "历史连接",
    label: "Google（历史连接）",
    base_url: "https://generativelanguage.googleapis.com/v1beta",
    custom_base_url: false,
    api: "openai-completions",
    pi_provider: "google",
    icon: "google",
  },
  {
    id: "xai",
    family: "xai",
    family_label: "xAI",
    variant_label: "历史连接",
    label: "xAI（历史连接）",
    base_url: "https://api.x.ai/v1",
    custom_base_url: false,
    api: "openai-completions",
    pi_provider: "xai",
    icon: "xai",
  },
];

export const CONFIGURABLE_PROVIDER_IDS: readonly ProviderPreset[] = PROVIDER_PRESETS.map((preset) => preset.id);
export const SUPPORTED_PROVIDER_IDS: readonly ProviderPreset[] = [
  ...PROVIDER_PRESETS.map((preset) => preset.id),
  ...RETIRED_PROVIDER_PRESETS.map((preset) => preset.id),
  ...LEGACY_PROVIDER_PRESETS.map((preset) => preset.id),
];

export function providerPreset(id: string): ProviderPresetDefinition | null {
  return [...PROVIDER_PRESETS, ...RETIRED_PROVIDER_PRESETS, ...LEGACY_PROVIDER_PRESETS]
    .find((preset) => preset.id === id) ?? null;
}

export function isProviderPreset(value: unknown): value is ProviderPreset {
  return typeof value === "string" && SUPPORTED_PROVIDER_IDS.includes(value as ProviderPreset);
}

export function isConfigurableProviderPreset(value: unknown): value is ProviderPreset {
  return typeof value === "string" && CONFIGURABLE_PROVIDER_IDS.includes(value as ProviderPreset);
}

export function providerFamilyPresets(family: string): readonly ProviderPresetDefinition[] {
  return PROVIDER_PRESETS.filter((preset) => preset.family === family);
}

export function providerFamilies(): Array<{ id: string; label: string; icon: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; label: string; icon: string }> = [];
  for (const preset of PROVIDER_PRESETS) {
    if (seen.has(preset.family)) continue;
    seen.add(preset.family);
    result.push({ id: preset.family, label: preset.family_label, icon: preset.icon });
  }
  return result;
}

export function providerDefaultLabel(provider: string): string {
  return providerPreset(provider)?.label ?? "模型连接";
}
