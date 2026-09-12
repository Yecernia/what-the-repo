import type { ProviderCompat } from "./provider-catalog.js";

export interface ProviderConfig {
  provider: string;
  /** Pi adapter/catalog provider when the product preset is a region or plan variant. */
  adapterProvider?: string;
  connectionId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelSelector: string;
  modelId: string;
  api: string;
  builtin: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  /** Pi model-level thinking mapping, selected by exact upstream model ID. */
  thinkingLevelMap?: Record<string, string | null>;
  /** Explicit wire-format settings for the selected provider endpoint. */
  compat?: ProviderCompat;
  /** Optional provider-specific API-key header in addition to Pi's auth field. */
  authHeader?: "api-key" | "authorization";
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  networkTimeoutMs?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}
