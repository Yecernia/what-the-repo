/** Endpoint-specific facts, reviewed against official notices on 2026-09-19.
 * A replacement is not necessarily an API error: hide retired names so users
 * do not unknowingly select another model with different capabilities/pricing.
 * Stable aliases that the vendor explicitly continues to support stay eligible.
 */
interface LifecycleRule {
  endpoints: readonly string[];
  models: readonly string[];
  effectiveAt: string;
  kind: "retired" | "replaced";
  source: string;
}

const TOKENHUB_API = ["tokenhub.tencentmaas.com", "tokenhub.tencentmaas.com/v1"];
const TOKENHUB_PLANS = [
  "tokenhub.tencentmaas.com/plan/v3",
  "api.lkeap.cloud.tencent.com/plan/v3",
  "api.lkeap.cloud.tencent.com/coding/v3",
];

export const MODEL_LIFECYCLE_RULES: readonly LifecycleRule[] = [
  {
    endpoints: TOKENHUB_API,
    models: ["qwen3.5-flash", "qwen3.5-plus"],
    effectiveAt: "2026-09-08T00:00:00+08:00", kind: "replaced",
    source: "https://cloud.tencent.com/announce/detail/2427",
  },
  {
    endpoints: [...TOKENHUB_API, ...TOKENHUB_PLANS], models: ["kimi-k2.5"],
    effectiveAt: "2026-08-31T00:00:00+08:00", kind: "replaced",
    source: "https://cloud.tencent.com/announce/detail/2414",
  },
  {
    endpoints: [...TOKENHUB_API, ...TOKENHUB_PLANS],
    models: ["glm-5", "glm-5-0", "glm-5-turbo", "glm-5.1", "glm-5-1"],
    effectiveAt: "2026-10-09T00:00:00+08:00", kind: "replaced",
    source: "https://cloud.tencent.com/announce/detail/2469",
  },
  {
    endpoints: TOKENHUB_API, models: ["glm-5v-turbo"],
    effectiveAt: "2026-10-30T23:59:59+08:00", kind: "replaced",
    source: "https://cloud.tencent.com/announce/detail/2479",
  },
  {
    endpoints: TOKENHUB_API, models: ["youtu-vita"],
    effectiveAt: "2026-10-15T00:00:00+08:00", kind: "retired",
    source: "https://cloud.tencent.com/announce/detail/2447",
  },
  {
    endpoints: ["api.hunyuan.cloud.tencent.com/v1"],
    models: ["hunyuan-turbos-vision", "hunyuan-t1-vision-20250916", "hunyuan-turbos-vision-video"],
    effectiveAt: "2026-06-22T00:00:00+08:00", kind: "retired",
    source: "https://cloud.tencent.com/announce/detail/2310",
  },
  {
    endpoints: ["api.deepseek.com", "api.deepseek.com/v1", "api.deepseek.com/anthropic"],
    models: ["deepseek-chat", "deepseek-reasoner"],
    // The notice specifies a date only. Allow the whole date before exclusion.
    effectiveAt: "2026-07-25T00:00:00Z", kind: "retired",
    source: "https://api-docs.deepseek.com/updates/",
  },
];

export function modelLifecycle(modelId: string, baseUrl: string | null | undefined, now = Date.now()) {
  if (!baseUrl) return undefined;
  let endpoint: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.port) return undefined;
    endpoint = url.hostname.toLowerCase() + url.pathname.replace(/\/+$/, "");
  } catch { return undefined; }
  const rule = MODEL_LIFECYCLE_RULES.find(item => item.endpoints.includes(endpoint)
    && item.models.includes(modelId.trim().toLowerCase()));
  return rule ? { ...rule, active: now >= Date.parse(rule.effectiveAt) } : undefined;
}
