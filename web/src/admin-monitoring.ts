import type { AdminRow } from './admin-api';

export const serviceNames: Record<string, { name: string; purpose: string }> = {
  api: { name: '接口服务', purpose: '登录、对话与管理接口' },
  'analysis-worker': { name: '仓库分析服务', purpose: '领取任务，执行仓库分析' },
  scheduler: { name: '定期清理服务', purpose: '数据保留与过期清理' },
  evolution: { name: '自进化服务', purpose: '生成、检查与审核候选 Skill' },
};
export interface ServiceReports {
  role: string;
  name: string;
  purpose: string;
  recent: AdminRow[];
  stale: AdminRow[];
  latest: AdminRow;
}
const timestamp = (value: unknown) => {
  const n = Date.parse(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export function groupServiceReports(observations: AdminRow[]): ServiceReports[] {
  const groups = new Map<string, AdminRow[]>();
  for (const row of observations) {
    const role = String(row.role ?? 'unclassified');
    const list = groups.get(role) ?? [];
    list.push(row);
    groups.set(role, list);
  }
  const order = Object.keys(serviceNames);
  return [...groups].map(([role, rows]) => {
    const sorted = [...rows].sort((a, b) => timestamp(b.observed_at) - timestamp(a.observed_at)
      || String(a.instance_id).localeCompare(String(b.instance_id)));
    return { role, name: serviceNames[role]?.name ?? role,
      purpose: serviceNames[role]?.purpose ?? '其他已上报服务',
      recent: sorted.filter(row => row.fresh === true),
      stale: sorted.filter(row => row.fresh !== true), latest: sorted[0]! };
  }).sort((a, b) => (order.indexOf(a.role) < 0 ? order.length : order.indexOf(a.role))
    - (order.indexOf(b.role) < 0 ? order.length : order.indexOf(b.role)) || a.role.localeCompare(b.role));
}

export function reportTime(value: unknown): string {
  const n = timestamp(value);
  return n ? new Date(n).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未记录';
}
export function reportAge(value: unknown, observedAt: string): string {
  const at = timestamp(value), reference = timestamp(observedAt);
  if (!at || !reference || at > reference) return '时间待核实';
  const seconds = Math.floor((reference - at) / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** Values belong to this report only; absent/invalid gauges must never become zero. */
export function reportMetrics(payload: unknown): Array<{ label: string; value: number }> {
  if (!payload || typeof payload !== 'object') return [];
  const gauges = (payload as AdminRow).gauges;
  if (!Array.isArray(gauges)) return [];
  const definitions = [
    ['what_the_repo_analysis_runs_active', '本实例分析执行中'],
    ['what_the_repo_provider_calls_active', '本实例模型请求中'],
  ];
  return definitions.flatMap(([name, label]) => {
    const values = gauges.filter(g => g && typeof g === 'object' && g.name === name);
    if (!values.length || values.some(g => typeof g.value !== 'number' || !Number.isFinite(g.value))) return [];
    return [{ label, value: values.reduce((sum, g) => sum + g.value, 0) }];
  });
}
