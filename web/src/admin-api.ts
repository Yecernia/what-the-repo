export type AdminRow = Record<string, unknown>;
export const adminErrors: Record<string, string> = {
  admin_repository_changed: '仓库版本或使用者发生变化，请重新打开清理预览再确认。',
  admin_repository_in_use: '当前有用户正在对话，或已有清理操作进行中，请在结束后再清理。',
  admin_repository_not_found: '仓库记录不存在，可能已完成清理。',
  admin_requires_postgres: '此列表需要 PostgreSQL 数据库。',
  storage_delete_incomplete: '部分资料尚未清理完成，仓库已停止复用，请刷新后重试。',
  admin_unavailable: '管理功能尚未启用。',
  admin_forbidden: '这个 GitHub 账号没有管理权限。',
  admin_github_required: '请先重新完成 GitHub 登录。',
  admin_session_required: '管理会话已过期，请重新登录。',
  admin_invalid_code: '验证码无效、已使用或已过期。',
  admin_rate_limited: '验证尝试过多，请在 15 分钟后重试。',
  admin_bootstrap_required: '首次绑定需要正确的初始化凭据。',
  admin_config_conflict: '配置已被更新，请刷新后再修改。',
  admin_invalid_config: '请检查连接地址、Key、模型及 Agent 选择。',
  admin_key_required: '新连接或新的接口地址必须填写 Key。',
  admin_snapshot_protected: '数据已被引用，或当前无需容量回收。',
  admin_snapshot_busy: '有分析任务正在排队或执行，请在结束后重新检查。',
  admin_evolution_worker_unavailable: '当前环境没有接入自进化审核 Worker。',
  admin_invalid_budget: '预算必须为非负金额或不设限。',
  admin_csrf: '请求验证失败，请刷新后重试。',
  admin_read_busy: '管理读取繁忙，请稍后重试。',
  admin_read_unavailable: '管理数据暂时不可用，请稍后重试。',
  admin_read_timeout: '管理数据读取超时，请稍后重试。',
};
export class AdminRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function isAdminAuthError(error: unknown): boolean {
  return error instanceof AdminRequestError && [401, 403].includes(error.status);
}
export const adminAuthExpiredEvent = 'admin-auth-expired';
export async function adminRequest<T = AdminRow>(
  path: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, method === 'GET' ? 30_000 : 60_000);
  try {
    const response = await fetch('/api/admin' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-admin-request': '1',
        ...(csrf ? { 'x-admin-csrf': csrf } : {}),
        ...(method === 'GET' && refresh ? { 'x-admin-refresh': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // Clear sensitive views even when an upstream 401/403 body is not valid JSON.
    if ([401, 403].includes(response.status)) window.dispatchEvent(new Event(adminAuthExpiredEvent));
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AdminRequestError('管理服务暂时不可用或正在重启，请稍后点击重试。', response.status);
    }
    if (!response.ok)
      throw new AdminRequestError(
        adminErrors[data.code] ?? '操作未完成，请检查输入或刷新后重试。',
        response.status, data.code,
      );
    return data as T;
  } catch (error) {
    if (timedOut) throw new Error(method === 'GET'
      ? '管理请求超时，请稍后重试。'
      : '操作等待超时，执行结果待确认，请刷新查看状态。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
