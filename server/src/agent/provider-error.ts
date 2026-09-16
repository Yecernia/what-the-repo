/** Public categories only. Never forward an upstream response body to the UI. */
export function providerErrorCode(error: unknown, fallback = "provider_request_failed"): string {
  const explicit = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (explicit.startsWith("site_") && FAILURE_MESSAGES[explicit]) return explicit;
  const value = error instanceof Error ? `${error.name} ${error.message} ${error.cause instanceof Error ? error.cause.message : ""}` : String(error ?? "");
  const businessCode = Object.keys(FAILURE_MESSAGES).find(code => code.startsWith("site_") && value.includes(code));
  if (businessCode) return businessCode;
  if (/provider_budget_exceeded|budget.{0,20}exceed/iu.test(value)) return "provider_budget_exceeded";
  if (/insufficient[_\s-](?:balance|quota|credit)|balance.{0,20}insufficient|credit.{0,20}exhaust|余额不足|欠费/iu.test(value)) return "provider_balance_insufficient";
  if (/\b401\b|invalid[_\s-](?:api[_\s-]?)?key|authentication[_\s-](?:error|failed)/iu.test(value)) return "provider_authentication_failed";
  if (/\b403\b|permission[_\s-]denied|access[_\s-]denied|forbidden/iu.test(value)) return "provider_permission_denied";
  if (/\b429\b|rate[_\s-]limit|too many requests/iu.test(value)) return "provider_rate_limited";
  if (/timeout|timed?\s*out|ETIMEDOUT|\b408\b|\b504\b/iu.test(value)) return "provider_timeout";
  if (/\b(?:500|502|503|529)\b|overloaded|server.{0,10}busy/iu.test(value)) return "provider_busy";
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|socket|connection (?:error|closed|reset)|fetch failed|network error/iu.test(value)) return "provider_connection_failed";
  return fallback;
}

export const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  site_project_chat_round_limit: '此项目已达到聊天上限',
  site_project_chat_size_limit: '此项目已达到聊天上限',
  site_model_pricing_unknown: "平台模型缺少可靠的费用估计，暂时无法在有限预算下调用，请联系管理员。",
  site_analysis_budget_exhausted: "今日全站分析额度已用完，请明天再试。已有分析结果仍可查看。",
  site_chat_budget_exhausted: "今日全站免费聊天额度已用完，请明天再试，也可以使用自己的 API Key 继续聊天。",
  site_budget_disabled: "这项平台服务当前未开放付费用量，请联系管理员。",
  site_evolution_budget_exhausted: "今日自进化额度已用完，请明天再试。",
  site_evolution_task_budget_exhausted: "这个自进化任务的金额预算已用完。",
  site_rate_limited: "请求过于频繁，请稍后重试。",
  site_storage_low: "全站存储容量不足，暂不接收新处理。已有结果仍可查看。",
  platform_provider_balance_insufficient: "平台模型服务的上游账户余额不足，请联系管理员。",
  provider_balance_insufficient: "余额不足，请检查 API 配置。",
  provider_authentication_failed: "API Key 无效，请检查 API 配置。",
  provider_permission_denied: "上游拒绝访问，请检查 API 配置。",
  provider_rate_limited: "上游请求过多，请稍后重试。",
  provider_busy: "上游繁忙，请稍后重试。",
  provider_timeout: "上游请求超时，请稍后重试。",
  provider_connection_failed: "上游连接中断，请稍后重试。",
  provider_request_failed: "上游错误，请稍后重试。",
  provider_transient_error: "上游连接失败，请稍后重试。",
  provider_budget_exceeded: "已达到本站用量上限，请稍后再试。",
  provider_unavailable: "上游暂不可用，请稍后重试。",
  provider_invalid_response: "上游返回了空回答，请重试。",
  provider_key_required: "请先在设置中添加 API Key。",
  server_error: "服务端错误，请稍后重试。",
  internal_error: "服务端错误，请稍后重试。",
  cancelled: "已取消。",
  client_network_error: "网络错误，请重试。",
};

export function failureMessage(code: string): string {
  return FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES.server_error!;
}

/** Legacy analysis failures may carry a safe stage prefix around the category. */
export function analysisFailureCode(value: string): string {
  return Object.keys(FAILURE_MESSAGES).find(code => value.includes(code)) ?? "server_error";
}
