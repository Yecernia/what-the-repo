import { t } from './ui-language';
import type { RuntimeProgressEvent } from './types';
import type { ActivityIconName } from './ActivityIcon';
import { detailedAnalysisStages } from './analysis-stage-catalog';

export function activityCategory(event: RuntimeProgressEvent | undefined): string {
  if (!event) return 'waiting';
  const haystack = `${event.display_stage ?? ''} ${event.stage} ${event.tool_name ?? ''} ${event.label}`.toLowerCase();
  if (/架构|组件|关系|图谱|静态证据图|cluster|interpret/.test(haystack)) return 'architecture';
  if (/证据|检索|查询|搜索|代码|symbol|evidence|query/.test(haystack)) return 'evidence';
  if (/仓库|拉取|读取|扫描|fetch|scan|clone|snapshot|文件/.test(haystack)) return 'repository';
  if (/状态|保存|更新|画像|学习|profile|memory|persist/.test(haystack)) return 'state';
  if (/回答|解释|生成|总结|message|response|answer/.test(haystack)) return 'answer';
  if (/工具|调用|tool|mcp/.test(haystack)) return 'tool';
  if (/等待|准备|连接|queued|connected|wait/.test(haystack)) return 'waiting';
  return 'analysis';
}

export type ActivityPhaseKey = 'understanding' | 'context' | 'repository' | 'evidence'
  | 'architecture' | 'planning' | 'answer' | 'state' | 'waiting' | 'analysis';

export function activityPhaseKey(event: RuntimeProgressEvent): ActivityPhaseKey {
  const stage = `${event.display_stage ?? ''} ${event.stage}`.toLowerCase();
  if (/understanding|run_started|理解|确认问题/.test(stage)) return 'understanding';
  if (/context|对话上下文|较早对话/.test(stage)) return 'context';
  if (/planning|reasoning|turn|思路|组织/.test(stage)) return 'planning';
  if (/(?:^|\s)(?:answer|answer_started)(?:\s|$)/u.test(stage)) return 'answer';
  const category = activityCategory(event);
  if (category === 'repository') return 'repository';
  if (category === 'evidence' || category === 'tool') return 'evidence';
  if (category === 'architecture') return 'architecture';
  if (category === 'answer') return 'answer';
  if (category === 'state') return 'state';
  if (category === 'waiting') return 'waiting';
  return 'analysis';
}

export function activityPhaseLabel(key: ActivityPhaseKey, status: RuntimeProgressEvent['status']): string {
  const complete = status === 'completed';
  const labels: Record<ActivityPhaseKey, [string, string]> = {
    understanding: [t("正在分析你的问题"), t("问题分析完成")],
    context: [t("正在回顾对话"), t("对话回顾完成")],
    repository: [t("正在查阅仓库文件"), t("已查阅仓库文件")],
    evidence: [t("正在查找相关代码"), t("已找到相关代码")],
    architecture: [t("正在整理代码关系"), t("已整理代码关系")],
    planning: [t("正在组织回答"), t("回答准备完成")],
    answer: [t("正在回答"), t("回答完成")],
    state: [t("正在更新学习状态"), t("已更新学习状态")],
    waiting: [t("正在准备回答"), t("已准备回答")],
    analysis: [t("正在检查相关代码"), t("相关代码检查完成")],
  };
  return labels[key][complete ? 1 : 0];
}

export function analysisActivityLabel(stage: string, jobStatus: string | null, complete = false): string {
  if (jobStatus === 'queued') return complete ? t("已开始分析") : t("正在等待分析");
  const labels: Record<string, [string, string]> = {
    idle: [t("正在准备分析"), t("准备分析")],
    fetching: [t("正在获取源码和已有分析结果"), t("已获取源码和已有分析结果")],
    scanning: [t("正在扫描仓库结构"), t("已扫描仓库结构")],
    extracting: [t("正在分析代码关系"), t("代码关系分析完成")],
    clustering: [t("正在识别项目组件"), t("已识别项目组件")],
    interpreting: [t("正在生成架构图"), t("已生成架构图")],
    done: [t("已生成架构图"), t("已生成架构图")],
    failed: [t("分析未完成"), t("分析未完成")],
  };
  return labels[stage]?.[complete ? 1 : 0] ?? (complete ? t("当前步骤已完成") : t("正在分析仓库"));
}

export const analysisProgressLabels: Record<string, [string, string]> = {
  ...Object.fromEntries(detailedAnalysisStages.map(stage => [stage.id, [stage.running, stage.completed] as [string, string]])),
  checking_existing: ['正在检查已有结果', '已检查已有结果'],
  confirming_upstream: ["正在检查仓库版本", "仓库版本检查完成"],
  reusing_snapshot: ["正在读取已有分析", "已使用已有分析"],
  fetching_source: ['正在拉取仓库源码', '已拉取仓库源码'],
  comparing_versions: ['正在比较版本差异', '已比较版本差异'],
  full_analysis: ['正在扫描全部源码', '已扫描全部源码'],
  incremental_analysis: ['正在扫描变更源码', '已扫描变更源码'],
  scanning: ['正在扫描仓库结构', '已扫描仓库结构'],
  interpreting: ['正在生成架构图', '已生成架构图'],
  completed: ["正在保存分析结果", '已完成架构图'],
  failed: ['分析未完成', '分析未完成'],
  cancelled: ['分析已取消', '分析已取消'],
};

export function analysisEventLabel(event: RuntimeProgressEvent, status = event.analysis_progress?.status ?? event.status): string {
  if (event.event_type === 'analysis_progress') {
    const key = analysisStageKey(event);
    const labels = key ? analysisProgressLabels[key] : undefined;
    if (labels) {
      const subject = t(labels[0]).replace(/^正在/u, '');
      const statusTemplates: Record<string, string> = {
        skipped: '已跳过：{0}', degraded: '部分完成：{0}', reused: '已复用：{0}',
        failed: '未完成：{0}', cancelled: '已取消：{0}',
      };
      let label = statusTemplates[status] ? t(statusTemplates[status], subject) : t(status === 'running' ? labels[0] : labels[1]);
      const progress = event.analysis_progress;
      if (progress?.completed_batches !== undefined) {
        label += ` · ${progress.total_batches === undefined
          ? t('已完成 {0} 批', progress.completed_batches)
          : t('{0}/{1} 批', progress.completed_batches, progress.total_batches)}`;
        if (progress.reused_batches) label += ` (${t('复用 {0} 批', progress.reused_batches)})`;
      }
      return label;
    }
    return t(event.label);
  }
  const match = /^analysis:([^:]+):([^:]+)$/u.exec(event.stage);
  if (!match) return event.label;
  return analysisActivityLabel(match[1], match[2] === 'queued' ? 'queued' : null, status === 'completed');
}

export function analysisStageKey(event: RuntimeProgressEvent): string | null {
  return /^analysis:([^:]+):[^:]+$/u.exec(event.stage)?.[1] ?? null;
}

export const phaseIcons: Record<ActivityPhaseKey, ActivityIconName> = {
  understanding: 'listen', context: 'recall', repository: 'files', evidence: 'search',
  architecture: 'relations', planning: 'compose', answer: 'speak', state: 'learn',
  waiting: 'wait', analysis: 'inspect',
};

export const analysisIcons: Record<string, ActivityIconName> = {
  ...Object.fromEntries(detailedAnalysisStages.map(stage => [stage.id, stage.icon])),
  checking_existing: 'archive', confirming_upstream: 'version', reusing_snapshot: 'reuse',
  fetching_source: 'download', comparing_versions: 'version', full_analysis: 'scan',
  incremental_analysis: 'edit', scanning: 'files', interpreting: 'relations',
  completed: 'save', failed: 'warning', cancelled: 'stop', idle: 'wait', fetching: 'download',
  extracting: 'inspect', clustering: 'components', done: 'done',
};

export function activityStatusLabel(event: RuntimeProgressEvent): string | null {
  if (event.stage === 'reconnecting' || event.stage === 'provider_retry') return t(event.label);
  if (event.analysis_progress && ['failed', 'cancelled', 'skipped', 'degraded', 'reused'].includes(event.analysis_progress.status)) {
    return analysisEventLabel(event);
  }
  if (event.stage === 'run_cancelling') return t('正在取消');
  if (event.status === 'cancelled') return t('已取消');
  // Legacy paused records use the remaining interruption presentation.
  if (event.status === 'paused') return t('已取消');
  if (event.status === 'failed') {
    if (event.tool_error || event.kind === 'tool') return t('查询未完成，正在调整');
    if (event.stage.startsWith('analysis:')) return t('分析未完成');
    if (event.label === '上一轮仍在处理') return t('上一轮仍在处理');
    return t(event.label || '回答失败');
  }
  return null;
}

export function activityIconName(event?: RuntimeProgressEvent, exactStages = false): ActivityIconName {
  if (!event) return 'wait';
  if (event.analysis_progress?.status === 'reused') return 'reuse';
  if (event.analysis_progress?.status === 'degraded') return 'warning';
  if (event.status === 'failed') return 'warning';
  if (event.status === 'cancelled' || event.stage === 'run_cancelling') return 'stop';
  if (event.status === 'paused') return 'stop';
  if (event.stage === 'reconnecting') return 'reconnect';
  if (event.stage === 'provider_retry') return 'retry';
  if (exactStages) {
    if (/^analysis:[^:]+:queued$/u.test(event.stage)) return 'wait';
    const key = analysisStageKey(event);
    if (key) return analysisIcons[key] ?? 'inspect';
  }
  return phaseIcons[activityPhaseKey(event)];
}
