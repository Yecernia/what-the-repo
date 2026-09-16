import { getUiLanguage, t } from './ui-language';
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

export class StreamError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
  }
}

const SAFE_DETAIL_PATTERNS = [
  /^请(?:先|填写|填入|选择|输入)/u,
  /^访客/u,
  /^当前只支持/u,
  /^公开 GitHub/u,
  /^项目(?:不存在|图谱尚未完成)/u,
  /^模型(?:连接|列表|调用|选择)/u,
  /^模型连接验证/u,
  /^连接名称/u,
  /^这个模型连接/u,
  /^自定义 Provider 的 Base URL/u,
  /^记忆摘要/u,
  /^画像/u,
  /^仓库/u,
  /^本轮回答/u,
  /^回答反馈/u,
  /^分析/u,
  /^GitHub 登录(?:已取消|状态|票据)/u,
];

function safeDetail(detail: unknown): string | null {
  if (typeof detail !== 'string') return null;
  const value = detail.trim();
  if (!value || value.length > 180) return null;
  // Never render URLs, local paths, SQL/stack traces, or credential-shaped data.
  if (/(?:https?:\/\/|[A-Za-z]:[\\/]|(?:^|\s)\/[^\s]+|bearer\s+|(?:api[_ -]?key|secret|password|token)\s*[:=]|sk-[A-Za-z0-9_-]{8,}|(?:stack|traceback|postgres|sql|exception| at ))/iu.test(value)) return null;
  if (!SAFE_DETAIL_PATTERNS.some(pattern => pattern.test(value))) return null;
  const labels: Record<string, string> = {
    site_model_pricing_unknown: "平台模型缺少可靠的费用估计，暂时无法在有限预算下调用，请联系管理员。",
    '自定义 Provider 的 Base URL 必须是 HTTPS 公网地址': t('接口地址必须使用 HTTPS，且能从公网访问。'),
    '这个模型连接已经存在': t('这份 API 配置已经存在。'),
    '模型连接不存在': t('这份 API 配置不存在。'),
    '这个模型连接尚未配置或不可用': t('这份 API 配置尚未设置或暂不可用。'),
    '模型连接只支持新增或删除，请删除后重新添加': t('修改 API 配置需要先删除，再重新添加。'),
  };
  return labels[value] ?? t(value);
}

function publicErrorMessage(status: number, code: string | undefined, detail: unknown): string {
  const failure = code ? conversationErrorMessage(code) : null;
  if (failure) return failure;
  switch (code) {
    case 'no_result':
      return t("服务端错误，请稍后重试。");
    case 'connection_name_duplicate':
      return t("配置名称已存在，请换一个名称。");
    case 'connection_verification_required':
      return t("请先获取或验证模型。");
    case 'rate_limited':
      return t("请求过于频繁，请稍后再试。");
    case 'not_found':
      return t("项目不存在");
    case 'snapshot_unavailable':
      return t("仓库分析结果尚未生成");
    case 'github_oauth_unavailable':
      return t("GitHub 登录服务暂时不可用，请稍后重试。");
    case 'github_oauth_access_denied':
      return t("GitHub 登录已取消。");
    case 'github_oauth_ticket_invalid':
    case 'github_oauth_ticket_replayed':
    case 'invalid_oauth_state':
      return t("GitHub 登录状态已失效，请重新登录。");
    case 'upstream_network_error':
      return t("上游连接失败，请稍后重试。");
  }
  if (status === 401) return t("登录状态已失效，请重新登录。");
  if (status === 403) return t("你暂时无法使用这个功能。");
  if (status === 404) return t("请求的内容不存在或已被移除。");
  if (status === 409) return t("内容已更新，请刷新后重试。");
  if (status === 429) return t("请求过于频繁，请稍后再试。");
  if (status >= 500) return t("服务端错误，请稍后重试。");
  return safeDetail(detail) ?? t("请求内容不符合要求，请检查后重试。");
}

/** Bounded public codes; never render raw provider response text. */
export function conversationErrorMessage(code: string): string | null {
  const labels: Record<string, string> = {
    site_project_chat_round_limit: '此项目已达到聊天上限',
    site_project_chat_size_limit: '此项目已达到聊天上限',
    platform_provider_balance_insufficient: "平台模型服务的上游账户余额不足，请联系管理员。",
  provider_balance_insufficient: '余额不足，请检查 API 配置。',
    provider_authentication_failed: 'API Key 无效，请检查 API 配置。',
    provider_permission_denied: '上游拒绝访问，请检查 API 配置。',
    provider_rate_limited: '上游请求过多，请稍后重试。',
    provider_busy: '上游繁忙，请稍后重试。',
    provider_timeout: '上游请求超时，请稍后重试。',
    provider_connection_failed: '上游连接中断，请稍后重试。',
    provider_request_failed: '上游错误，请稍后重试。',
    provider_invalid_response: '上游返回了空回答，请重试。',
    provider_transient_error: '上游连接失败，请稍后重试。',
    site_analysis_budget_exhausted: "今日全站分析额度已用完，请明天再试。已有分析结果仍可查看。",
    site_chat_budget_exhausted: "今日全站免费聊天额度已用完，请明天再试，也可以使用自己的 API Key 继续聊天。",
    site_budget_disabled: "这项平台服务当前未开放付费用量，请联系管理员。",
    site_evolution_budget_exhausted: "今日自进化额度已用完，请明天再试。",
    site_evolution_task_budget_exhausted: "这个自进化任务的金额预算已用完。",
    site_rate_limited: "请求过于频繁，请稍后重试。",
    site_storage_low: "全站存储容量不足，暂不接收新处理。已有结果仍可查看。",
    provider_budget_exceeded: '已达到本站用量上限，请稍后再试。',
    provider_unavailable: '上游暂不可用，请稍后重试。',
    provider_key_required: '请先在设置中添加 API Key。',
    server_error: '服务端错误，请稍后重试。',
    internal_error: '服务端错误，请稍后重试。',
    last_message_changed: '只能编辑最后一条消息，请刷新后重试。',
    session_busy: '上一轮仍在处理，请等待它结束或取消后再试。',
    client_network_error: '网络错误，请重试。',
    cancelled: '已取消。',
  };
  return labels[code] ? t(labels[code]) : null;
}

/** Convert unknown transport/API errors into copy that is safe to show in the UI. */
export function userFacingError(error: unknown, fallback = t("请求未能完成，请稍后重试。")): string {
  if (error instanceof ApiError) return publicErrorMessage(error.status, error.code, error.message) || fallback;
  if (error instanceof StreamError) return publicErrorMessage(0, error.code, error.message) || fallback;
  const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const name = typeof value?.name === 'string' ? value.name : '';
  const code = typeof value?.code === 'string' ? value.code : undefined;
  if (code && conversationErrorMessage(code)) return conversationErrorMessage(code)!;
  if (code === 'client_network_error' || name === 'AbortError' || name === 'TypeError') {
    return t("网络错误，请重试。");
  }
  return fallback;
}

async function responseError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let detail = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const payload = JSON.parse(text) as { detail?: unknown; code?: unknown };
    if (typeof payload.detail === 'string') detail = payload.detail;
    if (typeof payload.code === 'string') code = payload.code;
  } catch { /* malformed response is handled as a generic server error */ }
  return new ApiError(publicErrorMessage(res.status, code, detail), res.status, code);
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      ...options,
      headers,
    });
  } catch {
    throw new ApiError(t("网络连接失败，请检查网络。"), 0, 'client_network_error');
  }
  if (!res.ok) {
    throw await responseError(res);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const STREAM_RECONNECT_MAX_ATTEMPTS = 5;
const STREAM_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

class StreamTransportError extends Error {
  constructor(message = 'stream_transport_disconnected') {
    super(message);
    this.name = 'StreamTransportError';
  }
}

function clientRunId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function waitForStreamRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, delayMs));
}

interface StreamReadResult {
  runId: string;
  lastSequence: number;
  result: import('./types').SendMessageResult | null;
  terminalError: StreamError | null;
  sawDone: boolean;
}

async function readConversationStream(
  url: string,
  init: RequestInit,
  fallbackRunId: string,
  onProgress: (event: import('./types').RuntimeProgressEvent) => void,
  state: { runId: string; lastSequence: number; connected: boolean },
): Promise<StreamReadResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new StreamTransportError();
  }
  if (!res.ok) throw await responseError(res);
  if (!res.body) throw new StreamTransportError('stream_body_missing');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: import('./types').SendMessageResult | null = null;
  let terminalError: StreamError | null = null;
  let sawDone = false;
  const runId = () => state.runId || fallbackRunId;
  const processFrame = (frame: string): void => {
    let eventType = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      throw new StreamError(t("回答接收失败，请重试。"), 'server_error');
    }
    if (eventType === 'connected') {
      state.connected = true;
      if (typeof payload.run_id === 'string') state.runId = payload.run_id;
      const resumed = payload.resumed === true;
      onProgress({
        run_id: runId(),
        stage: resumed ? 'run_reconnected' : 'run_connected',
        label: resumed ? t("已重新连接") : t("正在准备回答"),
        status: resumed ? 'completed' : 'running',
        elapsed_ms: 0,
        kind: 'summary',
        display_stage: 'connection',
        visible: resumed,
        text: resumed ? t("网络连接已恢复，继续接收本轮回答。") : undefined,
        timestamp: new Date().toISOString(),
      });
    } else if (eventType === 'progress') {
      const event = payload as unknown as import('./types').RuntimeProgressEvent;
      if (typeof event.run_id !== 'string') event.run_id = runId();
      if (typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence)) {
        state.lastSequence = Math.max(state.lastSequence, event.sequence);
      }
      onProgress(event);
    } else if (eventType === 'result') {
      result = payload as unknown as import('./types').SendMessageResult;
    } else if (eventType === 'error') {
      const code = typeof payload.code === 'string' ? payload.code : undefined;
      terminalError = new StreamError(publicErrorMessage(0, code, payload.message), code);
    } else if (eventType === 'done') {
      sawDone = true;
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) processFrame(frame);
      if (chunk.done) break;
    }
  } catch (error) {
    if (error instanceof StreamError) throw error;
    throw new StreamTransportError();
  }
  if (terminalError) throw terminalError;
  return { runId: runId(), lastSequence: state.lastSequence, result, terminalError, sawDone };
}

export const apiClient = {
  // identity
  authConfig: () => api<import('./types').AuthConfigResponse>('/api/auth/config'),
  authMe: () => api<import('./types').IdentityResponse>('/api/auth/me'),
  createGuest: () => api<import('./types').IdentityResponse>('/api/auth/guest', { method: 'POST' }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  githubLoginUrl: (returnTo = '/') => (
    `${BASE}/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`
  ),

  // health
  health: () => api<{ ok: boolean; model_configured: boolean }>('/api/health'),

  // projects
  listProjects: () => api<import('./types').ProjectSummary[]>('/api/projects'),
  createProject: (body: {
    kind: 'github';
    value: string;
    title?: string;
    display_language?: string;
  }) =>
    api<import('./types').ProjectDetail>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  getProject: (id: string) => api<import('./types').ProjectDetail>(`/api/projects/${id}`),
  renameProject: (id: string, title: string) =>
    api<import('./types').ProjectSummary>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteProject: (id: string) => api<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  reanalyze: (id: string) =>
    api<import('./types').AnalysisStatus>(`/api/projects/${id}/reanalyze`, { method: 'POST' }),
  setProjectModel: (id: string, model: string) =>
    api<import('./types').ProjectSummary>(`/api/projects/${id}/model`, {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),

  // messages
  sendMessage: (
    id: string,
    content: string,
    uiContext: import('./types').ConversationSelection | null = null,
    reviewEvidence = false,
    replaceMessageId?: string,
    retryRunId?: string,
  ) =>
    api<import('./types').SendMessageResult>(
      `/api/projects/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          content,
          display_language: getUiLanguage(),
          ui_context: uiContext,
          review_evidence: reviewEvidence,
          ...(replaceMessageId ? { replace_message_id: replaceMessageId } : {}),
          ...(retryRunId ? { retry_run_id: retryRunId } : {}),
        }),
      },
    ),
  sendMessageStream: async (
    id: string,
    content: string,
    uiContext: import('./types').ConversationSelection | null,
    onProgress: (event: import('./types').RuntimeProgressEvent) => void,
    reviewEvidence = false,
    replaceMessageId?: string,
    retryRunId?: string,
  ): Promise<import('./types').SendMessageResult> => {
    const requestedRunId = clientRunId();
    onProgress({ run_id: requestedRunId, stage: 'request_created', label: '', kind: 'summary',
      visible: false, status: 'running', elapsed_ms: 0 });
    const state = { runId: requestedRunId, lastSequence: 0, connected: false };
    let reconnectAttempts = 0;
    for (;;) {
      try {
        const stream = await readConversationStream(
          !state.connected
            ? `${BASE}/api/projects/${id}/messages/stream`
            : `${BASE}/api/projects/${id}/runs/${encodeURIComponent(state.runId)}/stream?after=${state.lastSequence}`,
          !state.connected
            ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                credentials: 'include',
                body: JSON.stringify({
                  run_id: requestedRunId,
                  ...(replaceMessageId ? { replace_message_id: replaceMessageId } : {}),
                  ...(retryRunId ? { retry_run_id: retryRunId } : {}),
                  content,
                  display_language: getUiLanguage(),
                  ui_context: uiContext,
                  review_evidence: reviewEvidence,
                }),
              }
            : {
                method: 'GET',
                headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(state.lastSequence) },
                credentials: 'include',
              },
          requestedRunId,
          onProgress,
          state,
        );
        // A terminal result is authoritative even if the socket closes before
        // the trailing done frame reaches the browser.
        if (stream.result) return stream.result;
        if (stream.terminalError) throw stream.terminalError;
        throw new StreamTransportError('stream_closed_before_result');
      } catch (error) {
        if (!(error instanceof StreamTransportError)) throw error;
        if (reconnectAttempts >= STREAM_RECONNECT_MAX_ATTEMPTS) {
          throw new StreamError(t("网络连接失败，请检查网络。"), 'client_network_error');
        }
        reconnectAttempts += 1;
        onProgress({
          run_id: state.runId || requestedRunId,
          stage: 'reconnecting',
          label: t("正在重新连接（{0}/{1}）", reconnectAttempts, STREAM_RECONNECT_MAX_ATTEMPTS),
          status: 'running',
          elapsed_ms: 0,
          kind: 'summary',
          display_stage: 'connection',
          text: t("网络连接中断，正在恢复本轮回答。"),
          visible: true,
          timestamp: new Date().toISOString(),
        });
        await waitForStreamRetry(STREAM_RECONNECT_DELAYS_MS[reconnectAttempts - 1] ?? 8_000);
      }
    }
  },
  recordMessageFeedback: (projectId: string, messageId: string, vote: import('./types').MessageFeedbackVote) =>
    api<{ message_id: string; feedback: import('./types').MessageFeedback }>(
      `/api/projects/${projectId}/messages/${messageId}/feedback`,
      {
        method: 'POST',
        body: JSON.stringify({ vote }),
      },
    ),
  resolveLearningAction: (
    projectId: string,
    actionId: string,
    decision: 'confirm' | 'decline',
  ) => api<import('./types').LearningActionResolution>(
    `/api/projects/${projectId}/learning-actions/${encodeURIComponent(actionId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ decision }),
    },
  ),
  selectValuePoint: (id: string, snapshotId: string, selectedValuePoint: string) =>
    api<{
      project_id: string;
      snapshot_id: string;
      selected_value_point: string;
      learning_plan: import('./types').LearningPlan;
      study: import('./types').StudyState;
    }>(
      `/api/projects/${id}/study/value-point`,
      {
        method: 'PUT',
        body: JSON.stringify({
          snapshot_id: snapshotId,
          selected_value_point: selectedValuePoint,
        }),
      },
    ),

  // snapshot
  getSnapshot: (id: string, language: 'zh-CN' | 'en') => api<import('./types').Snapshot>(`/api/projects/${id}/snapshot?display_language=${language}`),

  // source
  getSource: (id: string, snapshotId: string, path: string, start: number, end: number, stableId?: string | null) =>
    api<{ snapshot_id: string; path: string; start_line: number; end_line: number; lines: string[]; truncated: boolean; redirect?: import('./types').RevisionRedirect | null }>(
      `/api/projects/${id}/source?snapshot_id=${encodeURIComponent(snapshotId)}&path=${encodeURIComponent(path)}&start=${start}&end=${end}${stableId ? `&stable_id=${encodeURIComponent(stableId)}` : ''}`,
    ),

  // settings
  getSettings: () => api<import('./types').SettingsResponse>('/api/settings'),
  addProviderConnection: (body: {
    provider: string;
    label?: string;
    base_url?: string;
    api_key: string;
    verification_token: string;
    models?: string[];
  }) => api<import('./types').SettingsResponse>('/api/settings/connections', {
    method: 'POST', body: JSON.stringify(body),
  }),
  verifyProviderConnection: (body: {
    provider?: string;
    label?: string;
    base_url?: string;
    api_key?: string;
    existing_connection_id?: string;
    model_id?: string;
    models?: string[];
    verification_token?: string;
  }) => api<{
    ok: boolean;
    models: string[];
    models_endpoint_supported: boolean;
    message: string;
    verification_token?: string;
  }>('/api/settings/connections/verify', {
    method: 'POST', body: JSON.stringify(body),
  }),
  updateProviderModels: (connectionId: string, body: { models: string[]; verification_token?: string }) =>
    api<import('./types').SettingsResponse>(`/api/settings/connections/${encodeURIComponent(connectionId)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  deleteProviderConnection: (connectionId: string) => api<import('./types').SettingsResponse>(
    `/api/settings/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' },
  ),
  selectModel: (model: string, thinkingLevel?: import('./types').ThinkingLevel) => api<import('./types').SettingsResponse>(
    '/api/settings/selection', {
      method: 'PUT', body: JSON.stringify({ model, thinking_level: thinkingLevel }),
    },
  ),
  clearKey: () => api<import('./types').SettingsResponse>('/api/settings/key', { method: 'DELETE' }),
  verifySettings: (connectionId?: string) =>
    api<{ ok: boolean; models: string[]; models_endpoint_supported: boolean; message: string }>(
      connectionId
        ? `/api/settings/connections/${encodeURIComponent(connectionId)}/verify`
        : '/api/settings/verify', { method: 'POST' },
    ),
  pauseRun: (projectId: string, runId: string) => api<{ run_id: string; status: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' },
  ),
  cancelRun: (projectId: string, runId: string) => api<{ run_id: string; status: string }>(
    `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' },
  ),
  getRunEvents: (projectId: string, runId: string, after = 0, limit = 100) => api<{
    run_id: string;
    after: number;
    events: import('./types').RuntimeProgressEvent[];
    next_sequence: number;
    completed: boolean;
    has_more?: boolean;
  }>(
    `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`,
  ),

  // profile
  getProfile: () => api<{ profile: import('./types').LearnerProfile }>('/api/profile'),
  updateProfile: (body: Partial<import('./types').LearnerProfile>) =>
    api<{ profile: import('./types').LearnerProfile }>('/api/profile', { method: 'PUT', body: JSON.stringify(body) }),
  updateInferredProfileClaim: (claimId: string, body: { claim?: string; confidence?: number }) =>
    api<{ profile: import('./types').LearnerProfile }>(
      `/api/profile/inferred/${encodeURIComponent(claimId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  deleteInferredProfileClaim: (claimId: string) =>
    api<{ profile: import('./types').LearnerProfile }>(
      `/api/profile/inferred/${encodeURIComponent(claimId)}`,
      { method: 'DELETE' },
    ),
  clearInferredProfile: () =>
    api<{ profile: import('./types').LearnerProfile }>('/api/profile/inferred', { method: 'DELETE' }),
  clearProfile: () => api<{ profile: import('./types').LearnerProfile }>('/api/profile', { method: 'DELETE' }),
  updateMemorySummary: (summary: string) => api<{ profile: import('./types').LearnerProfile }>(
    '/api/profile/summary', { method: 'PUT', body: JSON.stringify({ summary }) },
  ),
  regenerateMemorySummary: () => api<{ profile: import('./types').LearnerProfile }>(
    '/api/profile/summary/regenerate', { method: 'POST' },
  ),
};
