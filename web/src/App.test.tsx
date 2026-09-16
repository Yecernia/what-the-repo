import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalysisJob,
  AnalysisStatus,
  ConversationSelection,
  GraphEvidence,
  LearnerProfile,
  LearningActionCard,
  LearningActionResolution,
  Message,
  Project,
  ProjectDetail,
  ProjectSummary,
  SettingsResponse,
  Snapshot,
} from './types';
import { clearSnapshotCache } from './snapshot-cache';
import { getUiLanguage, setUiLanguage, UI_LANGUAGE_STORAGE_KEY } from './ui-language';

describe('project chat capacity', () => {
  const lastUser: Message = { message_id: 'capacity-user', role: 'user', content: '原问题',
    created_at: '2026-09-15T00:00:00Z', evidence: [], model: null, usage: null, latency_ms: null, error: null, placeholder: false };
  const answer: Message = { ...lastUser, message_id: 'capacity-answer', role: 'assistant', content: '原回答' };

  it('shows a persistent limit notice and blocks new sends, while allowing last-turn retry', async () => {
    let saved = project({ messages: [lastUser, answer], chat_limits: { max_rounds: 1, max_content_bytes: 1000 } });
    vi.mocked(apiClient.getProject).mockImplementation(async () => detail(saved, null, true));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(async (_id, _content, _selection, _progress, _review, replaceId) => {
      expect(replaceId).toBe(lastUser.message_id);
      const updated = { ...answer, content: '重新回答' };
      saved = { ...saved, messages: [lastUser, updated] };
      return { user_message: lastUser, assistant_message: updated, teaching_phase: 'orienting', validation_errors: [], tools_used: [], state_changed: false };
    });
    const view = render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    expect(await screen.findByRole('alert')).toHaveTextContent('此项目已达到聊天上限');
    const composer = screen.getByPlaceholderText('尽情提问');
    await userEvent.type(composer, '新问题{enter}');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(apiClient.sendMessageStream).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '重新发送' }));
    expect(await screen.findByText('重新回答')).toBeVisible();
    expect(composer).toHaveValue('新问题');
    view.unmount();
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    expect(await screen.findByRole('alert')).toHaveTextContent('此项目已达到聊天上限');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });

  it.each(['site_project_chat_round_limit', 'site_project_chat_size_limit'])('restores the draft and removes unsaved bubbles after %s', async code => {
    let saved = project({ chat_limits: { max_rounds: 1, max_content_bytes: 1000 } });
    vi.mocked(apiClient.getProject).mockImplementation(async () => detail(saved, null, true));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(async () => {
      saved = { ...saved, messages: [lastUser, answer] }; // Another tab used the last slot.
      throw Object.assign(new Error('capacity'), { code });
    });
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = screen.getByPlaceholderText('尽情提问');
    await userEvent.type(composer, '未保存的问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('此项目已达到聊天上限');
    expect(composer).toHaveValue('未保存的问题');
    expect(await screen.findByText('原回答')).toBeVisible();
    expect(document.querySelectorAll('.msg.user')).toHaveLength(1);
    expect(screen.queryByText('回答失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });

  it('re-enables sending when a draft is shortened below the UTF-8 byte limit', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ chat_limits: { max_rounds: 10, max_content_bytes: 7 } }), null, true));
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = screen.getByPlaceholderText('尽情提问');
    await userEvent.type(composer, '中文啊');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('此项目已达到聊天上限');
    await userEvent.type(composer, '{backspace}');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(apiClient.sendMessageStream).not.toHaveBeenCalled();
  });

  it('restores a rejected inline edit without changing saved messages or the separate composer draft', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [lastUser, answer],
      chat_limits: { max_rounds: 1, max_content_bytes: 1000 } }), null, true));
    vi.mocked(apiClient.sendMessageStream).mockRejectedValue(Object.assign(new Error('capacity'), { code: 'site_project_chat_size_limit' }));
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.type(screen.getByPlaceholderText('尽情提问'), '独立草稿');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '编辑最后一条消息' });
    await userEvent.clear(editor);
    await userEvent.type(editor, '修改后的内容');
    await userEvent.click(screen.getByRole('button', { name: '发送编辑后的消息' }));
    await waitFor(() => expect(apiClient.sendMessageStream).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('textbox', { name: '编辑最后一条消息' })).toHaveValue('修改后的内容');
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('独立草稿');
    expect(screen.getByText('原回答')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^取消$/ }));
    expect(screen.getByText('原问题')).toBeVisible();
    expect(screen.queryByText('回答失败')).not.toBeInTheDocument();
  });

  it('keeps an oversized edit open without requesting a model, and reports an actual retry failure at capacity', async () => {
    let saved = project({ messages: [lastUser, answer], chat_limits: { max_rounds: 1, max_content_bytes: 20 } });
    vi.mocked(apiClient.getProject).mockImplementation(async () => detail(saved, null, true));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(async () => {
      const failed = { ...answer, content: '', error: 'message_failed' };
      saved = { ...saved, messages: [lastUser, failed] };
      return { user_message: lastUser, assistant_message: failed, teaching_phase: 'orienting',
        validation_errors: [], tools_used: [], state_changed: false,
        error: { code: 'provider_rate_limited', message: '上游请求过多，请稍后重试。' } };
    });
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '编辑最后一条消息' });
    await userEvent.clear(editor);
    await userEvent.type(editor, '超出容量限制的修改内容');
    await userEvent.click(screen.getByRole('button', { name: '发送编辑后的消息' }));
    expect(apiClient.sendMessageStream).not.toHaveBeenCalled();
    expect(editor).toHaveValue('超出容量限制的修改内容');
    expect(screen.getByText('原回答')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^取消$/ }));
    await userEvent.click(screen.getByRole('button', { name: '重新发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('上游请求过多，请稍后重试。');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });
});

it('replaces the last turn after failure and edit, without persisting the bottom notice', async () => {
  const user: Message = { message_id: 'last-user', role: 'user', content: '原问题',
    created_at: '2026-09-09T10:00:00Z', evidence: [], model: null, usage: null, latency_ms: null, error: null, placeholder: false };
  const failed: Message = { ...user, message_id: 'failed-answer', role: 'assistant', content: '', error: 'message_failed', latency_ms: 100,
    thinking_summary: [{ sequence: 1, kind: 'summary', stage: 'failed', label: '上游请求过多，请稍后重试。',
      status: 'failed', timestamp: user.created_at, elapsed_ms: 100 }] };
  let saved = project({ messages: [user, failed] });
  vi.mocked(apiClient.getProject).mockImplementation(async () => detail(saved, null, true));
  vi.mocked(apiClient.sendMessageStream).mockImplementation(async (_id, content, _selection, _progress, _review, replaceId) => {
    expect(replaceId).toBe(user.message_id);
    const isEdit = content === '修改后的问题';
    const answer: Message = isEdit ? { ...failed, message_id: 'new-answer', content: '新的回答', error: null, thinking_summary: [] } : failed;
    const nextUser = { ...user, content };
    saved = project({ messages: [nextUser, answer] });
    return { user_message: nextUser, assistant_message: answer, teaching_phase: 'orienting', validation_errors: [], tools_used: [], state_changed: false,
      ...(isEdit ? {} : { error: { code: 'provider_rate_limited', message: '上游请求过多，请稍后重试。' } }) };
  });
  render(<App />);
  await userEvent.click(await screen.findByText('python-edge-cases'));
  expect(await screen.findByText('回答失败')).toBeVisible();
  expect(document.querySelector('.conversation-error')).toBeNull(); // Refresh only restores the summary.
  for (const name of ['编辑', '重新发送']) {
    const button = screen.getByRole('button', { name });
    expect(button).toHaveAttribute('data-tooltip', name);
    expect(button.textContent).toBe('');
  }
  await userEvent.click(screen.getByRole('button', { name: '重新发送' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('上游请求过多');
  expect(screen.getByTestId('answer-activity')).toHaveAttribute('data-status', 'failed');
  await userEvent.click(screen.getByRole('button', { name: '编辑' }));
  const composer = screen.getByPlaceholderText('尽情提问');
  expect(composer).toHaveValue('');
  const editor = screen.getByRole('textbox', { name: '编辑最后一条消息' });
  expect(editor.closest('.msg.user')).not.toBeNull();
  expect(editor).toHaveValue('原问题');
  await userEvent.type(composer, '下一条消息的独立草稿');
  await userEvent.clear(editor);
  await userEvent.type(editor, '修改后的问题');
  expect(composer).toHaveValue('下一条消息的独立草稿');
  await userEvent.click(screen.getByRole('button', { name: '发送编辑后的消息' }));
  expect(await screen.findByText('新的回答')).toBeVisible();
  expect(composer).toHaveValue('下一条消息的独立草稿');
  expect(screen.getAllByText('修改后的问题')).toHaveLength(1);
  expect(screen.queryByText('原问题')).not.toBeInTheDocument();
  expect(screen.queryByText('回答失败')).not.toBeInTheDocument();
  expect(document.querySelector('.conversation-error')).toBeNull();
});

it('shows the actual analysis retry count and the final upstream reason', async () => {
  vi.useFakeTimers();
  const value = project({ analysis: { ...project().analysis, stage: 'interpreting', snapshot_id: null } });
  vi.mocked(apiClient.getProject)
    .mockResolvedValueOnce(detail(value, { ...job('queued'), attempt: 1,
      error_code: 'analysis_retry_scheduled', error: '上游连接中断，请稍后重试。' }, false))
    .mockResolvedValue(detail({ ...value, analysis: { ...value.analysis, stage: 'failed' } },
      { ...job('failed'), attempt: 3, error: '上游请求超时，请稍后重试。' }, false));
  render(<App />);
  await flushReact();
  fireEvent.click(screen.getByText('python-edge-cases'));
  await flushReact();
  expect(screen.getByTestId('analysis-activity')).toHaveTextContent('上游连接中断，正在重试（1/2）');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await flushReact();
  expect(screen.getByText('上游请求超时，请稍后重试。')).toBeVisible();
  expect(screen.queryByText('上游连接中断，正在重试（1/2）')).not.toBeInTheDocument();
});

it('keeps partial output and a failed summary after reconnect attempts end', async () => {
  const pending = deferred<Awaited<ReturnType<typeof apiClient.sendMessageStream>>>();
  vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
  vi.mocked(apiClient.sendMessageStream).mockImplementation((_id, _content, _selection, progress) => {
    progress({ stage: 'assistant_delta', label: '', delta: '已输出的部分内容', status: 'running', kind: 'answer', visible: false, elapsed_ms: 1 });
    progress({ stage: 'reconnecting', label: '正在重新连接（5/5）', status: 'running', kind: 'summary', visible: true, elapsed_ms: 2 });
    return pending.promise;
  });
  render(<App />);
  await userEvent.click(await screen.findByText('python-edge-cases'));
  await userEvent.type(screen.getByPlaceholderText('尽情提问'), '问题');
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
  expect(await screen.findByText('正在重新连接（5/5）')).toBeVisible();
  await act(async () => { pending.reject(Object.assign(new Error('connection lost'), { code: 'client_network_error' })); });
  expect(await screen.findByText('已输出的部分内容')).toBeVisible();
  expect(screen.getByTestId('answer-activity')).toHaveAttribute('data-status', 'failed');
  expect(screen.getByText('回答失败')).toBeVisible();
  expect(document.querySelector('.conversation-error')).not.toBeNull();
});

vi.mock('./api', () => ({
  conversationErrorMessage: (code: string) => code === 'provider_rate_limited' ? '上游请求过多，请稍后重试。' : null,
  userFacingError: (_error: unknown, fallback = '请求未能完成，请稍后重试。') => fallback,
  apiClient: {
    authConfig: vi.fn(),
    authMe: vi.fn(),
    createGuest: vi.fn(),
    logout: vi.fn(),
    githubLoginUrl: vi.fn(() => '/api/auth/github/start?return_to=%2F'),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getSettings: vi.fn(),
    getProject: vi.fn(),
    getSnapshot: vi.fn(),
    reanalyze: vi.fn(),
    setProjectModel: vi.fn(),
    selectModel: vi.fn(),
    sendMessage: vi.fn(),
    sendMessageStream: vi.fn(),
    pauseRun: vi.fn(),
    cancelRun: vi.fn(),
    getRunEvents: vi.fn(),
    recordMessageFeedback: vi.fn(),
    resolveLearningAction: vi.fn(),
    selectValuePoint: vi.fn(),
    renameProject: vi.fn(),
    deleteProject: vi.fn(),
    addProviderConnection: vi.fn(),
    verifyProviderConnection: vi.fn(),
    updateProviderModels: vi.fn(),
    deleteProviderConnection: vi.fn(),
    verifySettings: vi.fn(),
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    updateInferredProfileClaim: vi.fn(),
    deleteInferredProfileClaim: vi.fn(),
    clearInferredProfile: vi.fn(),
    clearProfile: vi.fn(),
    updateMemorySummary: vi.fn(),
    regenerateMemorySummary: vi.fn(),
    getSource: vi.fn(),
  },
}));

vi.mock('./RepositoryWorkspace', () => ({
  RepositoryThumbnail: () => <div data-testid="repository-thumbnail" />,
  RepositoryWorkspace: ({
    snapshot,
    project,
    onQueueTopic,
    onOpenEvidence,
    onSelectionChange,
  }: {
    snapshot: Snapshot;
    project: Project;
    onQueueTopic: (request: {
      kind: 'value-point';
      stableId: string;
      prompt: string;
    }) => void;
    onOpenEvidence: (evidence: GraphEvidence) => void;
    onSelectionChange: (selection: ConversationSelection) => void;
  }) => (
    <div data-testid="repository-workspace">
      <span>snapshot:{snapshot.snapshot_id}</span>
      <span>language:{snapshot.display_language ?? 'unknown'}</span>
      <span>selected:{project.study.selected_value_point ?? 'none'}</span>
      <span>step:{project.study.current_step}/{project.study.total_steps}</span>
      <button
        onClick={() => onQueueTopic({
          kind: 'value-point',
          stableId: 'value:entry',
          prompt: '学习入口职责边界',
        })}
      >选择入口职责边界</button>
      <button
        onClick={() => onSelectionChange({
          snapshot_id: snapshot.snapshot_id,
          kind: 'component',
          stable_id: 'component:domain',
          label: '领域服务',
        })}
      >选择领域服务组件</button>
      <button
        onClick={() => onOpenEvidence({
          stable_id: 'fact:source:shared',
          label: '共享源码',
          path: 'src/shared.py',
          start_line: 7,
          end_line: 7,
          kind: 'verified',
        })}
      >打开源码证据</button>
    </div>
  ),
}));

vi.mock('./SketchDoodle', () => ({
  SketchDoodle: ({ className = '' }: { className?: string }) => (
    <svg className={className} data-testid="sketch-doodle" aria-hidden="true" />
  ),
}));

import { apiClient } from './api';
import App from './App';

const settings: SettingsResponse = {
  base_url: 'https://example.invalid/v1',
  model: 'test-model',
  thinking_level: 'medium',
  api_key_management: 'interactive',
  available_models: ['free:deepseek-v4-flash', 'test-model'],
  model_options: [
    { selector: 'free:deepseek-v4-flash', connection_id: 'deployment-free', provider: 'deepseek', model_id: 'deepseek-v4-flash', label: 'deepseek-v4-flash（免费体验）', thinking_levels: ['off', 'high'] },
    { selector: 'provider:test:test-model', connection_id: 'test', provider: 'custom', model_id: 'test-model', label: '测试 / test-model', thinking_levels: ['off', 'low', 'medium', 'high'] },
  ],
  selected_model_option: null,
  providers: [{ connection_id: 'test', provider: 'custom', label: '测试', base_url: 'https://example.invalid/v1', custom_models: ['test-model'], last_verified_at: '2026-08-12T00:00:00Z', verify_error: null, has_api_key: true, api_key_masked: 'sk-***' }],
  provider_presets: [{ id: 'custom', label: '自定义 OpenAI 兼容接口', base_url: '', custom_base_url: true }],
  models_endpoint_supported: true,
  has_api_key: true,
  api_key_masked: 'sk-***',
  last_verified_at: '2026-08-12T00:00:00Z',
  verify_error: null,
  can_manage_api_key: true,
  free_experience_model: 'free:deepseek-v4-flash',
  free_experience_provider_model: 'deepseek-v4-flash',
  free_experience_configured: true,
};

const deploymentSettings: SettingsResponse = {
  ...settings,
  api_key_management: 'deployment',
  can_manage_api_key: false,
};

const learnerProfile: LearnerProfile = {
  enabled: true,
  languages: ['C', 'Go'],
  goals: ['理解调用链'],
  explanation_preference: '先讲输入输出',
  experience_level: '初学者',
  inferred: [
    {
      claim_id: 'claim:call-chain',
      claim: '能识别入口与领域服务的调用关系',
      confidence: 0.65,
      evidence: 'project-1 的教学回答给出了正确调用顺序',
      observed_at: '2026-08-12T00:00:00Z',
      source_project_id: 'project-1',
    },
  ],
  last_inferred_message_id: null,
  memory_summary: '你熟悉 C 和 Go，正在理解调用链。',
  memory_summary_mode: 'generated',
  memory_summary_updated_at: '2026-08-12T00:00:00Z',
};

const summary: ProjectSummary = {
  project_id: 'project-1',
  title: 'python-edge-cases',
  source_kind: 'fixture',
  source_value: 'python-edge-cases',
  analysis_stage: 'done',
  teaching_phase: 'orienting',
  message_count: 0,
  updated_at: '2026-08-12T00:00:00Z',
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'project-1',
    title: 'python-edge-cases',
    source: {
      kind: 'fixture',
      value: 'python-edge-cases',
      commit_sha: null,
      display_name: 'python-edge-cases',
    },
    created_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:00Z',
    messages: [],
    analysis: {
      stage: 'done',
      snapshot_id: 'snapshot-1',
      file_count: 3,
      symbol_count: 8,
      call_count: 5,
      languages: ['python'],
      error: null,
      canonical_snapshot_key: null,
    },
    study: {
      phase: 'orienting',
      selected_value_point: null,
      current_step: 0,
      total_steps: 0,
      mastered: [],
      misconceptions: [],
      open_questions: [],
      used_evidence: [],
    },
    model_override: null,
    ...overrides,
  };
}

function learningAction(overrides: Partial<LearningActionCard> = {}): LearningActionCard {
  return {
    action_id: 'learning-action-1',
    action: 'start_learning_route',
    target: {
      kind: 'value_point',
      stable_id: 'value:entry',
      label: '入口职责边界',
    },
    title: '开始学习入口职责边界',
    description: '为入口职责边界制定学习路线并开始学习。',
    request: '我想学习入口职责边界',
    snapshot_id: 'snapshot-1',
    status: 'pending',
    progress: null,
    created_at: '2026-08-19T00:00:00Z',
    resolved_at: null,
    executed_at: null,
    error: null,
    ...overrides,
  };
}

function job(status: AnalysisJob['status']): AnalysisJob {
  return {
    job_id: 'job-1',
    project_id: 'project-1',
    idempotency_key: 'fixture',
    status,
    attempt: status === 'queued' ? 0 : 1,
    max_attempts: 3,
    lease_owner: status === 'running' ? 'worker-1' : null,
    lease_expires_at: null,
    heartbeat_at: status === 'running' ? '2026-08-12T00:00:01Z' : null,
    created_at: '2026-08-12T00:00:00Z',
    updated_at: '2026-08-12T00:00:01Z',
    available_at: '2026-08-12T00:00:00Z',
    completed_at: status === 'succeeded' ? '2026-08-12T00:00:02Z' : null,
    error: null,
  };
}

function detail(value: Project, analysisJob: AnalysisJob | null, snapshotAvailable: boolean): ProjectDetail {
  return {
    project: value,
    snapshot_available: snapshotAvailable,
    analysis_job: analysisJob,
  };
}

const snapshot: Snapshot = {
  snapshot_id: 'snapshot-1',
  summary: {
    file_count: 3,
    symbol_count: 8,
    call_count: 5,
    import_count: 2,
    inherit_count: 0,
    component_count: 1,
  },
  graph: {
    semantic_mode: 'empty',
    nodes: [],
    edges: [],
    layers: [],
    unassigned_component_ids: [],
  },
  value_points: [
    {
      stable_id: 'value:entry',
      kind: 'value_point',
      title: '入口职责边界',
      claim: '入口只负责编排。',
      problem: null,
      implementation: null,
      tradeoffs: null,
      transfer_conditions: null,
      certainty: 'supported',
      evidence: [],
      connectivity: 1,
    },
  ],
  languages: [],
  learning_plan: {
    snapshot_id: 'snapshot-1',
    selected_value_point: 'value:entry',
    steps: [],
  },
};

const reanalysisQueued: AnalysisStatus = {
  stage: 'failed',
  snapshot_id: null,
  file_count: 0,
  symbol_count: 0,
  call_count: 0,
  languages: [],
  error: null,
  canonical_snapshot_key: null,
  job_id: 'job-1',
  job_status: 'queued',
  job_attempt: 0,
  job_max_attempts: 3,
  lease_owner: null,
  heartbeat_at: null,
  retryable: true,
};

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openRepositoryPanel() {
  const toggle = await screen.findByRole('button', { name: '展开项目视图' });
  await userEvent.click(toggle);
}

beforeEach(() => {
  vi.mocked(apiClient.getProject).mockReset().mockResolvedValue(detail(project(), null, true));
  clearSnapshotCache();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  vi.mocked(apiClient.authConfig).mockResolvedValue({
    auth_mode: 'github',
    guest_enabled: true,
  });
  vi.mocked(apiClient.authMe).mockResolvedValue({
    owner_id: 'github:1',
    login: 'octocat',
    display_name: 'The Octocat',
    avatar_url: null,
    kind: 'github',
    auth_mode: 'github',
  });
  vi.mocked(apiClient.logout).mockResolvedValue(undefined);
  vi.mocked(apiClient.listProjects).mockResolvedValue([summary]);
  vi.mocked(apiClient.getSettings).mockResolvedValue(settings);
  vi.mocked(apiClient.getSnapshot).mockResolvedValue(snapshot);
  vi.mocked(apiClient.renameProject).mockResolvedValue(summary);
  vi.mocked(apiClient.deleteProject).mockResolvedValue(undefined);
  vi.mocked(apiClient.setProjectModel).mockResolvedValue(summary);
  vi.mocked(apiClient.selectModel).mockResolvedValue(settings);
  vi.mocked(apiClient.addProviderConnection).mockResolvedValue(settings);
  vi.mocked(apiClient.updateProviderModels).mockResolvedValue(settings);
  vi.mocked(apiClient.verifyProviderConnection).mockResolvedValue({
    ok: true,
    models: ['test-model', 'test-model-pro'],
    models_endpoint_supported: true,
    message: '验证成功，已拉取模型列表',
    verification_token: 'test-verification-token',
  });
  vi.mocked(apiClient.deleteProviderConnection).mockResolvedValue(settings);
  vi.mocked(apiClient.pauseRun).mockResolvedValue({ run_id: 'run-test', status: 'pausing' });
  vi.mocked(apiClient.cancelRun).mockResolvedValue({ run_id: 'run-test', status: 'cancelling' });
  vi.mocked(apiClient.getRunEvents).mockResolvedValue({
    run_id: 'run-test', after: 0, events: [], next_sequence: 0, completed: true,
  });
  vi.mocked(apiClient.verifySettings).mockResolvedValue({
    ok: true,
    models: ['test-model', 'test-model-pro'],
    models_endpoint_supported: true,
    message: '验证成功，已拉取模型列表',
  });
  vi.mocked(apiClient.getProfile).mockResolvedValue({ profile: learnerProfile });
  vi.mocked(apiClient.updateProfile).mockResolvedValue({ profile: learnerProfile });
  vi.mocked(apiClient.updateInferredProfileClaim).mockResolvedValue({ profile: learnerProfile });
  vi.mocked(apiClient.deleteInferredProfileClaim).mockResolvedValue({
    profile: { ...learnerProfile, inferred: [] },
  });
  vi.mocked(apiClient.clearInferredProfile).mockResolvedValue({
    profile: { ...learnerProfile, inferred: [] },
  });
  vi.mocked(apiClient.clearProfile).mockResolvedValue({
    profile: {
      enabled: true,
      languages: [],
      goals: [],
      explanation_preference: '',
      experience_level: '',
      inferred: [],
      last_inferred_message_id: null,
      memory_summary: '',
      memory_summary_mode: 'generated',
      memory_summary_updated_at: null,
    },
  });
  vi.mocked(apiClient.updateMemorySummary).mockResolvedValue({ profile: learnerProfile });
  vi.mocked(apiClient.regenerateMemorySummary).mockResolvedValue({ profile: learnerProfile });
  vi.mocked(apiClient.sendMessageStream).mockImplementation(
    (id, content, uiContext, _onProgress, reviewEvidence) => (
      apiClient.sendMessage(id, content, uiContext, reviewEvidence)
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('public compliance', () => {
  it('omits the filing footer when no record is configured', async () => {
    vi.stubEnv('VITE_ICP_RECORD', '');
    render(<App />);
    await screen.findByRole('button', { name: '设置' });
    expect(screen.queryByLabelText('网站备案信息')).not.toBeInTheDocument();
  });
  it('links the configured ICP record to the MIIT filing site', async () => {
    vi.stubEnv('VITE_ICP_RECORD', '蜀ICP备2000000000号-1');
    render(<App />);

    const record = await screen.findByRole('link', { name: '蜀ICP备2000000000号-1' });
    expect(record).toHaveAttribute('href', 'https://beian.miit.gov.cn/');
  });
});

describe('App project state synchronization', () => {
  it('shows a visible error when project deletion fails', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    vi.mocked(apiClient.deleteProject).mockRejectedValue(new Error('删除暂时失败'));

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '打开 python-edge-cases 项目菜单' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('项目删除暂时未完成，请稍后重试。');
    expect(screen.getByText('python-edge-cases')).toBeInTheDocument();
  });

  it('records one-click answer feedback without opening a reason dialog', async () => {
    const assistant: Message = {
      message_id: 'assistant-feedback',
      role: 'assistant',
      content: '这是一条可以评价的回答。',
      created_at: '2026-08-18T00:00:00Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 12,
      error: null,
      placeholder: false,
      feedback: null,
    };
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [assistant] }), null, true));
    vi.mocked(apiClient.recordMessageFeedback).mockResolvedValue({
      message_id: assistant.message_id,
      feedback: {
        vote: 'up',
        updated_at: '2026-08-18T00:00:01Z',
        signal: null,
      },
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const useful = await screen.findByRole('button', { name: '回答有帮助' });
    expect(useful).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(useful);

    await waitFor(() => expect(apiClient.recordMessageFeedback).toHaveBeenCalledWith(
      'project-1',
      assistant.message_id,
      'up',
    ));
    expect(useful).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms a pending learning action through the structured action API', async () => {
    const pendingAction = learningAction();
    const assistant: Message = {
      message_id: 'assistant-learning-confirm',
      role: 'assistant',
      content: '我可以先为这个价值点制定一条学习路线。',
      created_at: '2026-08-19T00:00:00Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 12,
      error: null,
      placeholder: false,
      learning_action: pendingAction,
    };
    const executedAction = learningAction({
      status: 'executed',
      resolved_at: '2026-08-19T00:00:01Z',
      executed_at: '2026-08-19T00:00:01Z',
    });
    const resolvedProject = project({
      messages: [{ ...assistant, learning_action: executedAction }],
      study: {
        ...project().study,
        phase: 'explaining',
        selected_value_point: 'value:entry',
        total_steps: 2,
      },
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [assistant] }), null, true));
    vi.mocked(apiClient.resolveLearningAction).mockResolvedValue({
      project: resolvedProject,
      action: executedAction,
      state_changed: true,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    expect(await screen.findByText('需要你的确认')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => expect(apiClient.resolveLearningAction).toHaveBeenCalledWith(
      'project-1',
      pendingAction.action_id,
      'confirm',
    ));
    const actionCard = screen.getByText(executedAction.title).closest('.learning-action-card');
    expect(actionCard).not.toBeNull();
    expect(within(actionCard as HTMLElement).getByText('已完成')).toBeVisible();
    expect(screen.queryByRole('button', { name: '确认' })).not.toBeInTheDocument();
  });

  it('shows route generation progress while a confirmed route action is still running', async () => {
    const pendingAction = learningAction();
    const assistant: Message = {
      message_id: 'assistant-learning-progress',
      role: 'assistant',
      content: '确认后再生成路线。',
      created_at: '2026-08-22T00:00:00Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 12,
      error: null,
      placeholder: false,
      learning_action: pendingAction,
    };
    const executedAction = learningAction({
      status: 'executed',
      resolved_at: '2026-08-22T00:02:00Z',
      executed_at: '2026-08-22T00:02:00Z',
    });
    const resolvedProject = project({
      messages: [{ ...assistant, learning_action: executedAction }],
      study: {
        ...project().study,
        phase: 'explaining',
        total_steps: 2,
      },
    });
    let finishAction!: (value: LearningActionResolution) => void;
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [assistant] }), null, true));
    vi.mocked(apiClient.resolveLearningAction).mockReturnValue(new Promise(resolve => {
      finishAction = resolve;
    }));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.click(await screen.findByRole('button', { name: '确认' }));

    expect(await screen.findByText('正在生成路线')).toBeVisible();
    expect(screen.getByRole('button', { name: '正在生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '暂不' })).toBeDisabled();

    await act(async () => {
      finishAction({ project: resolvedProject, action: executedAction, state_changed: true });
    });
    const actionCard = screen.getByText(executedAction.title).closest('.learning-action-card');
    expect(actionCard).not.toBeNull();
    await waitFor(() => expect(within(actionCard as HTMLElement).getByText('已完成')).toBeVisible());
    expect(screen.queryByText('正在生成路线')).not.toBeInTheDocument();
  });

  it('declines a pending learning action without changing the learning state', async () => {
    const pendingAction = learningAction({ action_id: 'learning-action-decline' });
    const assistant: Message = {
      message_id: 'assistant-learning-decline',
      role: 'assistant',
      content: '是否要进入引导学习？',
      created_at: '2026-08-19T00:00:00Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 12,
      error: null,
      placeholder: false,
      learning_action: pendingAction,
    };
    const declinedAction = learningAction({
      action_id: pendingAction.action_id,
      status: 'declined',
      resolved_at: '2026-08-19T00:00:01Z',
    });
    const unchangedProject = project({
      messages: [{ ...assistant, learning_action: declinedAction }],
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [assistant] }), null, true));
    vi.mocked(apiClient.resolveLearningAction).mockResolvedValue({
      project: unchangedProject,
      action: declinedAction,
      state_changed: false,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.click(await screen.findByRole('button', { name: '暂不' }));

    await waitFor(() => expect(apiClient.resolveLearningAction).toHaveBeenCalledWith(
      'project-1',
      pendingAction.action_id,
      'decline',
    ));
    expect(await screen.findByText("已跳过")).toBeVisible();
    expect(unchangedProject.study).toEqual(project().study);
  });

  it('follows the system theme by default and switches from the sidebar', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));

    render(<App />);

    await waitFor(() => {
      expect(document.documentElement.dataset.themePreference).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    });
    const toggle = screen.getByRole('button', { name: '切换到深色主题' });
    await userEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(screen.getByRole('button', { name: '切换到浅色主题' })).toBeInTheDocument();
    expect(window.localStorage.getItem('what-the-repo-theme')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(screen.queryByRole('radiogroup', { name: '颜色主题' })).not.toBeInTheDocument();
  });

  it('preserves rendered code nodes while appending streamed answer chunks', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    let emit!: Parameters<typeof apiClient.sendMessageStream>[3];
    vi.mocked(apiClient.sendMessageStream).mockImplementation((_id, _text, _selection, onProgress) => {
      emit = onProgress;
      return new Promise(() => {});
    });
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.type(await screen.findByPlaceholderText('尽情提问'), '检查流式显示');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    const chunk = async (delta: string) => act(async () => emit({ stage: 'assistant_delta', label: '正在生成回答', status: 'running', elapsed_ms: 100, delta }));
    await chunk('函数 `run()` 的作用');
    await screen.findByText('run()');
    const code = document.querySelector('.msg.assistant .msg-bubble code')!;
    expect(code).not.toBeNull();
    await chunk('，第一部分。');
    await chunk('\n\n第二部分。');
    await chunk('\n\n第三部分。');
    expect(code.isConnected).toBe(true);
    expect(document.querySelector('.msg.assistant .msg-bubble code')).toBe(code);
    expect(await screen.findByText('第三部分。')).toBeInTheDocument();
  });

  it('moves logout into the account-name menu and removes the product icon there', async () => {
    render(<App />);

    const account = await screen.findByRole('button', { name: /The Octocat/ });
    expect(account.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument();

    await userEvent.click(account);
    expect(screen.getByRole('menuitemradio', { name: '简体中文' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'English' })).toBeInTheDocument();
    fireEvent.blur(document.activeElement!, { relatedTarget: null });
    await userEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));

    expect(apiClient.logout).toHaveBeenCalledTimes(1);
  });

  it('offers guest sign-in and language inside the account menu', async () => {
    vi.mocked(apiClient.authMe).mockResolvedValue({ owner_id: 'guest:test', login: 'guest', display_name: '访客', avatar_url: null, kind: 'guest', auth_mode: 'github' });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /访客/ }));
    expect(screen.getByRole('menuitem', { name: '使用 GitHub 登录' })).toBeInTheDocument();
    expect(apiClient.githubLoginUrl).not.toHaveBeenCalled();
    fireEvent.blur(document.activeElement!, { relatedTarget: null });
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(document.documentElement.lang).toBe('en');
    await userEvent.click(screen.getByRole('button', { name: /Guest/ }));
    expect(screen.getByRole('menuitem', { name: 'Sign in with GitHub' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    setUiLanguage('zh-CN');
  });

  it('uses the shared sidebar as a mobile drawer and keeps project view in the top bar', async () => {
    const original = window.matchMedia;
    const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...original(query), matches: query === '(max-width: 680px)' }));
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    try {
      render(<App />);
      const trigger = await screen.findByRole('button', { name: '展开项目栏' });
      const sidebar = document.querySelector('.sidebar')!;
      expect(sidebar).toHaveAttribute('inert');
      expect(document.querySelector('.mobile-topbar .mobile-project-toggle')).toBeNull();
      await userEvent.click(trigger);
      expect(sidebar).not.toHaveAttribute('inert');
      expect(document.querySelector('.main')).toHaveAttribute('inert');
      await userEvent.click(screen.getByText('python-edge-cases'));
      await waitFor(() => expect(document.querySelector('.mobile-topbar .mobile-project-toggle')).not.toBeNull());
      expect(sidebar).toHaveAttribute('inert');
      expect(document.querySelector('.main')).not.toHaveAttribute('inert');
      expect(document.querySelector('.chat-toolbar')).toBeNull();
      expect(screen.queryByTestId('repository-workspace')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '展开项目视图' }));
      expect(document.querySelector('.repository-pane')).toHaveClass('open');
      expect(document.querySelector('.teaching-pane')).toHaveAttribute('inert');
      expect(await screen.findByTestId('repository-workspace')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '返回聊天' }));
      expect(screen.queryByTestId('repository-workspace')).not.toBeInTheDocument();
      expect(document.querySelector('.teaching-pane')).not.toHaveAttribute('inert');
      const input = screen.getByPlaceholderText('尽情提问');
      fireEvent.focus(input);
      fireEvent.blur(input, { relatedTarget: null });
      await userEvent.click(screen.getByRole('combobox', { name: '本项目模型' }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      fireEvent.pointerDown(document.body);
      expect(screen.getByRole('combobox', { name: '本项目模型' })).toBeInTheDocument();
    } finally { media.mockRestore(); }
  });

  it('pauses at minimum sidebar width and only collapses after continued leftward dragging', async () => {
    render(<App />);
    const handle = await screen.findByRole('separator', { name: '调整项目栏宽度' });
    const sidebar = document.querySelector('.sidebar')!;
    const minimum = Number(handle.getAttribute('aria-valuemin'));
    const pointer = (target: Element | Window, type: string, x: number) => fireEvent(target, new MouseEvent(type, { bubbles: true, clientX: x, button: 0 }));
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      pointer(handle, 'pointerdown', 260);
      pointer(window, 'pointermove', 190);
      expect(sidebar).toHaveStyle({ width: `${minimum}px` });
      pointer(window, 'pointermove', 155);
      expect(sidebar).not.toHaveClass('collapsed');
      clock.mockReturnValue(200);
      pointer(window, 'pointermove', 155); // Holding still is not an instruction to collapse.
      expect(sidebar).not.toHaveClass('collapsed');
      pointer(window, 'pointermove', 150);
      expect(sidebar).toHaveClass('collapsed');
      expect(document.body).not.toHaveClass('col-resizing');
      await userEvent.click(screen.getByRole('button', { name: '展开项目栏' }));
      expect(sidebar).toHaveStyle({ width: `${minimum}px` });
      pointer(handle, 'pointerdown', 190);
      pointer(window, 'pointermove', 180);
      pointer(window, 'pointercancel', 180);
      pointer(window, 'pointermove', 100);
      expect(sidebar).not.toHaveClass('collapsed');
      expect(document.body).not.toHaveClass('col-resizing');
    } finally { clock.mockRestore(); }
  });

  it('derives minimum sidebar width from the full product name and header controls', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('sidebar-product-name') ? 300 : 0;
    });
    try {
      render(<App />);
      const handle = await screen.findByRole('separator', { name: '调整项目栏宽度' });
      // Even without layout in jsdom, the full title alone must increase the default minimum.
      expect(Number(handle.getAttribute('aria-valuemin'))).toBeGreaterThanOrEqual(300);
      expect(document.querySelector('.sidebar')).toHaveStyle({ width: `${handle.getAttribute('aria-valuemin')}px` });
    } finally { width.mockRestore(); }
  });

  it('keeps chat primary and reveals resizable navigation panels on demand', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({
      messages: [{
        message_id: 'assistant-layout',
        role: 'assistant',
        content: '先从对话开始。',
        created_at: '2026-08-15T00:00:00Z',
        evidence: [],
        model: 'test-model',
        usage: null,
        latency_ms: 10,
        error: null,
        placeholder: false,
      }],
    }), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    const projectView = await screen.findByRole('button', { name: '展开项目视图' });
    expect(screen.getByTestId('repository-workspace').closest('.repository-pane'))
      .toHaveClass('collapsed');
    expect(document.querySelector('.msg-avatar')).not.toBeInTheDocument();
    await userEvent.click(projectView);
    const repositoryPane = screen.getByTestId('repository-workspace').closest('.repository-pane');
    expect(repositoryPane).toHaveClass('open');
    expect(repositoryPane).toHaveStyle({
      width: '760px',
      maxWidth: 'calc(100% - 435px)',
    });
    expect(screen.getByRole('separator', { name: '调整对话与项目视图宽度' }))
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起项目栏' }));
    expect(screen.getByRole('button', { name: '展开项目栏' })).toBeInTheDocument();
  });

  it('renames projects from the three-dot menu and keeps the sidebar title-only', async () => {
    const renamed = { ...summary, title: '我的 React 研学' };
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    vi.mocked(apiClient.renameProject).mockResolvedValue(renamed);

    render(<App />);
    await userEvent.click(await screen.findByRole('button', {
      name: '打开 python-edge-cases 项目菜单',
    }));
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const input = screen.getByRole('textbox', { name: '项目标题' });
    await userEvent.clear(input);
    await userEvent.type(input, '我的 React 研学{Enter}');

    await waitFor(() => {
      expect(apiClient.renameProject).toHaveBeenCalledWith('project-1', '我的 React 研学');
    });
    expect(await screen.findByText('我的 React 研学')).toBeInTheDocument();
    expect(screen.queryByText('已分析')).not.toBeInTheDocument();
    expect(screen.queryByText('0条')).not.toBeInTheDocument();
  });

  it('shows one jump line per user message and scrolls to the selected message', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({
      messages: [
        {
          message_id: 'user-one', role: 'user', content: '第一个问题',
          created_at: '2026-08-16T00:00:00Z', evidence: [], model: null,
          usage: null, latency_ms: null, error: null, placeholder: false,
        },
        {
          message_id: 'assistant-one', role: 'assistant', content: '第一个回答',
          created_at: '2026-08-16T00:00:01Z', evidence: [], model: 'test-model',
          usage: null, latency_ms: 10, error: null, placeholder: false,
        },
        {
          message_id: 'user-two', role: 'user', content: '第二个问题，讲讲调用关系',
          created_at: '2026-08-16T00:00:02Z', evidence: [], model: null,
          usage: null, latency_ms: null, error: null, placeholder: false,
        },
      ],
    }), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const jumps = await screen.findAllByRole('button', { name: /跳转到你的消息/ });
    expect(jumps).toHaveLength(2);
    await userEvent.click(jumps[1]);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('shows one live activity line, expands real steps, and counts time in the browser', async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<typeof apiClient.sendMessageStream>>>();
    const finalUser: Message = {
      message_id: 'user-live-activity',
      role: 'user',
      content: '入口做了什么？',
      created_at: '2026-08-16T00:00:00Z',
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    const finalAssistant: Message = {
      message_id: 'assistant-live-activity',
      role: 'assistant',
      content: '入口负责编排。',
      created_at: '2026-08-16T00:00:02Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 2_100,
      error: null,
      placeholder: false,
    };
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(project(), null, true))
      .mockResolvedValue(detail(project({ messages: [finalUser, finalAssistant] }), null, true));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(
      (_id, _content, _uiContext, onProgress) => {
        onProgress({
          stage: 'model_completed',
          label: '正在理解问题并规划下一步',
          status: 'completed',
          elapsed_ms: 120,
          sequence: 1,
          kind: 'summary',
          display_stage: 'planning',
          text: '我先整理问题目标和已有上下文，再决定下一步。',
          visible: true,
        });
        onProgress({
          stage: 'tool_started',
          label: '正在检索代码证据',
          status: 'running',
          elapsed_ms: 180,
          tool_name: 'query_code_evidence',
          sequence: 2,
          kind: 'tool',
          display_stage: 'tool',
          text: '准备调用“代码证据查询”，获取与问题相关的只读证据。',
          visible: true,
        });
        onProgress({
          stage: 'assistant_delta',
          label: '正在生成回答',
          status: 'running',
          elapsed_ms: 200,
          delta: '先看入口组件。',
          sequence: 3,
          kind: 'answer',
          display_stage: 'answer',
          visible: false,
        });
        return pending.promise;
      },
    );

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    fireEvent.change(screen.getByPlaceholderText('尽情提问'), {
      target: { value: '入口做了什么？' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await flushReact();

    await act(async () => { await vi.advanceTimersByTimeAsync(16); });
    const activity = screen.getByTestId('answer-activity');
    const toggle = within(activity).getByRole('button', { name: "正在查找相关代码" });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('已完成')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(activity).toHaveTextContent('2s');

    fireEvent.click(toggle);
    expect(within(activity).getByText("回答准备完成")).toBeVisible();
    expect(within(activity).getAllByText("正在查找相关代码")).toHaveLength(2);
    expect(within(activity).queryByText('已理解问题并规划下一步')).not.toBeInTheDocument();
    expect(within(activity).queryByText('正在检索代码证据')).not.toBeInTheDocument();
    expect(within(activity).queryByText('我先整理问题目标和已有上下文，再决定下一步。')).not.toBeInTheDocument();
    expect(within(activity).queryByText('准备调用“代码证据查询”，获取与问题相关的只读证据。')).not.toBeInTheDocument();
    expect(within(activity).queryByText('工具')).not.toBeInTheDocument();
    expect(within(activity).queryByText('query_code_evidence')).not.toBeInTheDocument();
    expect(screen.queryByText('正在生成回答')).not.toBeInTheDocument();
    expect(screen.queryByText('耗时')).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        user_message: {
          message_id: 'user-live-activity',
          role: 'user',
          content: '入口做了什么？',
          created_at: '2026-08-16T00:00:00Z',
          evidence: [],
          model: null,
          usage: null,
          latency_ms: null,
          error: null,
          placeholder: false,
        },
        assistant_message: {
          message_id: 'assistant-live-activity',
          role: 'assistant',
          content: '入口负责编排。',
          created_at: '2026-08-16T00:00:02Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 2_100,
          error: null,
          placeholder: false,
        },
        teaching_phase: 'orienting',
        validation_errors: [],
        tools_used: ['query_code_evidence'],
        state_changed: false,
      });
      await pending.promise;
    });

    await flushReact();
    const completedActivity = screen.getByTestId('answer-activity');
    expect(completedActivity).toHaveTextContent('耗时 3s');
    expect(within(completedActivity).queryByText('我先整理问题目标和已有上下文，再决定下一步。')).not.toBeInTheDocument();
    expect(within(completedActivity).getByText("回答完成")).toBeVisible();
    expect(within(completedActivity).queryByRole('button', { name: "回答完成" })).toBeNull();
    expect(completedActivity.querySelector('.activity-history')).toBeNull();
  });

  it('keeps completion summary and duration for historical answers without replay events', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({
      messages: [{
        message_id: 'assistant-history',
        role: 'assistant',
        content: '这是历史回答。',
        created_at: '2026-08-16T00:00:02Z',
        evidence: [],
        model: 'test-model',
        usage: null,
        latency_ms: 1_000,
        error: null,
        placeholder: false,
      }],
    }), null, true));

    render(<App />);
    await flushReact();
    await userEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();

    const activity = screen.getByTestId('answer-activity');
    expect(activity).toHaveTextContent('耗时 1s');
    expect(within(activity).getByText('已完成')).toBeVisible();
    expect(within(activity).queryByRole('button', { name: '已完成' })).toBeNull();
  });

  it('restores historical thinking summary from the assistant message without replaying traces', async () => {
    const assistant: Message = {
      message_id: 'assistant-persisted-summary',
      role: 'assistant',
      content: '这是已经完成的回答。',
      created_at: '2026-08-16T00:00:02Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 860,
      error: null,
      placeholder: false,
      trace_id: 'run-persisted-summary',
      thinking_summary: [
        {
          sequence: 1,
          timestamp: '2026-08-16T00:00:00Z',
          kind: 'summary',
          stage: 'understanding',
          label: '正在理解问题',
          status: 'completed',
          elapsed_ms: 20,
        },
        {
          sequence: 2,
          timestamp: '2026-08-16T00:00:01Z',
          kind: 'summary',
          stage: 'planning',
          label: '正在组织回答',
          status: 'completed',
          elapsed_ms: 540,
        },
      ],
    };
    vi.mocked(apiClient.getProject).mockResolvedValue(
      detail(project({ messages: [assistant] }), null, true),
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const activity = await screen.findByTestId('answer-activity');
    expect(apiClient.getRunEvents).not.toHaveBeenCalled();
    expect(within(activity).getByText('已完成')).toBeVisible();
    expect(within(activity).queryByRole('button', { name: '已完成' })).toBeNull();
    expect(activity.querySelector('.activity-history')).toBeNull();
  });

  it('groups repeated evidence events and keeps a useful file count after refresh', async () => {
    const assistant: Message = {
      message_id: 'assistant-grouped-summary',
      role: 'assistant',
      content: '这是使用代码证据的回答。',
      created_at: '2026-08-16T00:00:02Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 860,
      error: null,
      placeholder: false,
      trace_id: 'run-grouped-summary',
      thinking_summary: [
        {
          sequence: 1,
          timestamp: '2026-08-16T00:00:00Z',
          kind: 'summary',
          stage: 'understanding',
          label: '正在理解问题',
          status: 'completed',
          elapsed_ms: 20,
        },
        {
          sequence: 2,
          timestamp: '2026-08-16T00:00:01Z',
          kind: 'summary',
          stage: 'evidence_lookup',
          label: '已定位 3 个相关文件',
          status: 'completed',
          elapsed_ms: 40,
        },
        {
          sequence: 3,
          timestamp: '2026-08-16T00:00:01Z',
          kind: 'summary',
          stage: 'evidence_lookup',
          label: '已找到 3 个相关文件',
          status: 'completed',
          elapsed_ms: 60,
        },
      ],
    };
    vi.mocked(apiClient.getProject).mockResolvedValue(
      detail(project({ messages: [assistant] }), null, true),
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const activity = await screen.findByTestId('answer-activity');
    expect(within(activity).getByText('回答完成 · 参考 3 个文件')).toBeVisible();
    expect(within(activity).queryByRole('button', { name: '回答完成 · 参考 3 个文件' })).toBeNull();
    expect(activity.querySelector('.activity-history')).toBeNull();
  });

  it('passes the optional evidence review choice with each message', async () => {
    const userMessage: Message = {
      message_id: 'user-review', role: 'user', content: '核对入口职责',
      created_at: '2026-08-16T00:00:00Z', evidence: [], model: null,
      usage: null, latency_ms: null, error: null, placeholder: false,
    };
    const assistantMessage: Message = {
      message_id: 'assistant-review', role: 'assistant', content: '已经核对。',
      created_at: '2026-08-16T00:00:01Z', evidence: [], model: 'test-model',
      usage: null, latency_ms: 700, error: null, placeholder: false,
    };
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    vi.mocked(apiClient.sendMessage).mockResolvedValue({
      user_message: userMessage,
      assistant_message: assistantMessage,
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: [],
      state_changed: false,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const review = screen.getByRole('switch', { name: "核对代码" });
    expect(review).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(review);
    expect(review).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByPlaceholderText('尽情提问'), userMessage.content);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalledWith(
      'project-1',
      userMessage.content,
      null,
      true,
    ));
  });

  it.each(['zh-CN', 'en'] as const)('keeps model and effort menus concise and selected in %s', async (language) => {
    setUiLanguage(language);
    const projectModel = 'provider:test:test-model';
    const selectedOption = { ...settings.model_options[1], thinking_mode: 'pi' as const };
    const modelSettings: SettingsResponse = {
      ...settings,
      model: projectModel,
      available_models: [projectModel],
      model_options: [selectedOption],
      selected_model_option: selectedOption,
    };
    vi.mocked(apiClient.getSettings).mockResolvedValue(modelSettings);
    vi.mocked(apiClient.selectModel).mockResolvedValue({ ...modelSettings, thinking_level: 'high' });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ model_override: projectModel }), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const english = language === 'en';
    const model = screen.getByRole('combobox', { name: english ? 'Project model' : '本项目模型' });
    expect(model).toHaveTextContent(/^test-model$/);
    await userEvent.click(model);
    const group = screen.getByRole('option', { selected: true });
    await userEvent.click(group);
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent(/^test-model$/);
    await userEvent.keyboard('{Escape}');
    const thinking = await screen.findByRole('combobox', { name: english ? 'Reasoning effort' : '思考程度' });
    await userEvent.click(thinking);
    expect(screen.getByText(english ? 'Reasoning effort' : '思考程度')).toHaveClass('sketch-select-menu-title');
    await userEvent.click(screen.getByRole('option', { name: english ? 'High' : '高' }));

    await waitFor(() => expect(apiClient.selectModel).toHaveBeenCalledWith(projectModel, 'high'));
    setUiLanguage('zh-CN');
  });

  it('does not expose or send an analysis model when creating a project', async () => {
    const modelSettings: SettingsResponse = {
      ...settings,
      model: 'deepseek-v4-flash',
      available_models: [
        'free:deepseek-v4-flash',
        'deepseek-v4-flash',
        'deepseek-v4-pro',
      ],
    };
    vi.mocked(apiClient.getSettings).mockResolvedValue(modelSettings);
    vi.mocked(apiClient.listProjects).mockResolvedValue([]);
    vi.mocked(apiClient.createProject).mockResolvedValue(
      detail(project({ model_override: null }), job('queued'), false),
    );

    render(<App />);
    await userEvent.click((await screen.findAllByRole('button', { name: '新建项目' }))[0]);
    expect(screen.queryByRole('combobox', { name: '分析与对话模型' })).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByPlaceholderText('https://github.com/owner/repo'),
      'https://github.com/octocat/Hello-World',
    );
    await userEvent.click(screen.getByRole('button', { name: '开始分析' }));

    await waitFor(() => expect(apiClient.createProject).toHaveBeenCalledWith({
      kind: 'github',
      value: 'https://github.com/octocat/Hello-World',
      title: '',
      display_language: 'zh-CN',
    }));
  });

  it('clears the previous project while another project is loading', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const firstProject = project({
      messages: [
        {
          message_id: 'assistant-a',
          role: 'assistant',
          content: '这是项目 A 的消息',
          created_at: '2026-08-14T00:00:00Z',
          evidence: [],
          model: null,
          usage: null,
          latency_ms: null,
          error: null,
          placeholder: false,
        },
      ],
    });
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    let resolveSecond: ((value: ProjectDetail) => void) | undefined;
    const secondLoad = new Promise<ProjectDetail>(resolve => {
      resolveSecond = resolve;
    });
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => (
      id === 'project-1'
        ? Promise.resolve(detail(firstProject, null, true))
        : secondLoad
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    expect(await screen.findByText('这是项目 A 的消息')).toBeVisible();
    await userEvent.click(screen.getByText('second-project'));

    expect(screen.queryByText('这是项目 A 的消息')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '发送消息' })).not.toBeInTheDocument();
    expect(apiClient.sendMessage).not.toHaveBeenCalled();

    resolveSecond?.(detail(secondProject, null, true));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );
  });

  it('ignores a late message failure after the user switches projects', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const pendingSend = deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => Promise.resolve(
      detail(id === 'project-1' ? project() : secondProject, null, true),
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.sendMessage).mockReturnValue(pendingSend.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, '项目 A 的问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );

    await act(async () => {
      pendingSend.reject(new Error('late project A failure'));
      await Promise.resolve();
    });

    expect(screen.queryByText('这次消息没有发送成功，请稍后重试。')).not.toBeInTheDocument();
    expect(vi.mocked(apiClient.getProject).mock.calls.filter(([id]) => id === 'project-1'))
      .toHaveLength(1);
  });

  it('reconciles a late message success after returning to the original project', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const persistedUser: Message = {
      message_id: 'user-persisted-after-return',
      role: 'user',
      content: '项目 A 的问题',
      created_at: '2026-08-14T00:00:00Z',
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    const persistedAssistant: Message = {
      message_id: 'assistant-persisted-after-return',
      role: 'assistant',
      content: '返回项目 A 后同步到的回答',
      created_at: '2026-08-14T00:00:01Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 10,
      error: null,
      placeholder: false,
    };
    const updatedFirstProject = project({
      messages: [persistedUser, persistedAssistant],
    });
    const pendingSend = deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    let firstProjectLoads = 0;
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => {
      if (id === 'project-2') return Promise.resolve(detail(secondProject, null, true));
      firstProjectLoads += 1;
      return Promise.resolve(detail(
        firstProjectLoads >= 3 ? updatedFirstProject : project(),
        null,
        true,
      ));
    });
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.sendMessage).mockReturnValue(pendingSend.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, persistedUser.content);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );
    await userEvent.click(screen.getByText('python-edge-cases'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-1',
    );
    expect(screen.queryByText(persistedAssistant.content)).not.toBeInTheDocument();

    await act(async () => {
      pendingSend.resolve({
        user_message: persistedUser,
        assistant_message: persistedAssistant,
        teaching_phase: 'orienting',
        validation_errors: [],
        tools_used: [],
        state_changed: false,
      });
      await pendingSend.promise;
    });

    expect(await screen.findByText(persistedAssistant.content)).toBeVisible();
    expect(firstProjectLoads).toBeGreaterThanOrEqual(3);
  });

  it('keeps a pending turn locked when switching projects and unlocks after it settles', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const older = deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    const olderUser: Message = {
      message_id: 'older-user',
      role: 'user',
      content: '较早请求',
      created_at: '2026-08-14T00:00:00Z',
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    const olderAssistant: Message = {
      message_id: 'older-assistant',
      role: 'assistant',
      content: '较早请求的回答',
      created_at: '2026-08-14T00:00:01Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 10,
      error: null,
      placeholder: false,
    };
    let firstProjectLoads = 0;
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => {
      if (id === 'project-2') return Promise.resolve(detail(secondProject, null, true));
      firstProjectLoads += 1;
      return Promise.resolve(detail(
        firstProjectLoads >= 3
          ? project({ messages: [olderUser, olderAssistant] })
          : project(),
        null,
        true,
      ));
    });
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.sendMessage).mockReturnValueOnce(older.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    let composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, olderUser.content);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await userEvent.click(screen.getByText('second-project'));
    await screen.findByText('snapshot:snapshot-2');
    await userEvent.click(screen.getByText('python-edge-cases'));
    await screen.findByText('snapshot:snapshot-1');

    composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, '较新请求');
    expect(screen.queryByRole('button', { name: '发送消息' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消本轮回答' })).toBeVisible();
    expect(apiClient.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      older.resolve({
        user_message: olderUser,
        assistant_message: olderAssistant,
        teaching_phase: 'orienting',
        validation_errors: [],
        tools_used: [],
        state_changed: false,
      });
      await older.promise;
    });
    expect(await screen.findByText(olderAssistant.content)).toBeVisible();
    const sendButton = await screen.findByRole('button', { name: '发送消息' });
    expect(sendButton).toBeEnabled();
  });

  it('closes a source request when the active project changes', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const source = deferred<Awaited<ReturnType<typeof apiClient.getSource>>>();
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => Promise.resolve(
      detail(id === 'project-1' ? project() : secondProject, null, true),
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.getSource).mockReturnValue(source.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '打开源码证据' }));
    expect(await screen.findByText('src/shared.py:7')).toBeVisible();
    expect(apiClient.getSource).toHaveBeenCalledWith(
      'project-1',
      'snapshot-1',
      'src/shared.py',
      1,
      167,
      'fact:source:shared',
    );

    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByText('snapshot:snapshot-2')).toBeVisible();
    expect(screen.queryByText('src/shared.py:7')).not.toBeInTheDocument();
    expect(apiClient.getSource).toHaveBeenCalledTimes(1);

    await act(async () => {
      source.resolve({
        snapshot_id: 'snapshot-1',
        path: 'src/shared.py',
        start_line: 1,
        end_line: 37,
        lines: ['old project source'],
        truncated: false,
      });
      await source.promise;
    });
    expect(screen.queryByText('old project source')).not.toBeInTheDocument();
  });

  it('keeps a queued value-point learning intent local when the user switches projects', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => Promise.resolve(
      detail(id === 'project-1' ? project() : secondProject, null, true),
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '选择入口职责边界' }));
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('学习入口职责边界');
    expect(apiClient.selectValuePoint).not.toHaveBeenCalled();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('selected:none');

    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('');
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('selected:none');
    expect(vi.mocked(apiClient.getProject).mock.calls.filter(([id]) => id === 'project-1'))
      .toHaveLength(1);
  });

  it('does not persist a queued value-point intent when returning to the original project', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    let firstProjectLoads = 0;
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => {
      if (id === 'project-2') return Promise.resolve(detail(secondProject, null, true));
      firstProjectLoads += 1;
      return Promise.resolve(detail(project(), null, true));
    });
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '选择入口职责边界' }));
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('学习入口职责边界');
    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );
    await userEvent.click(screen.getByText('python-edge-cases'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'selected:none',
    );
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('');
    expect(apiClient.selectValuePoint).not.toHaveBeenCalled();
    expect(firstProjectLoads).toBe(2);
  });

  it('ignores a late reanalysis response after the user switches projects', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const failedProject = project({
      analysis: {
        ...project().analysis,
        stage: 'failed',
        snapshot_id: null,
        error: 'previous analysis failed',
      },
    });
    const pendingReanalysis = deferred<Awaited<ReturnType<typeof apiClient.reanalyze>>>();
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => Promise.resolve(
      detail(
        id === 'project-1' ? failedProject : secondProject,
        null,
        id !== 'project-1',
      ),
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.reanalyze).mockReturnValue(pendingReanalysis.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await userEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    await waitFor(() => expect(apiClient.reanalyze).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );

    await act(async () => {
      pendingReanalysis.resolve(reanalysisQueued);
      await Promise.resolve();
    });

    expect(screen.queryByText('分析任务已排队')).not.toBeInTheDocument();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-2');
    expect(vi.mocked(apiClient.getProject).mock.calls.filter(([id]) => id === 'project-1'))
      .toHaveLength(1);
  });

  it('retries a failed project load with a new request', async () => {
    vi.mocked(apiClient.getProject)
      .mockRejectedValueOnce(new Error('temporary load failure'))
      .mockResolvedValueOnce(detail(project(), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    expect(await screen.findByText('项目内容暂时无法加载，请稍后重试。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-1');
    expect(apiClient.getProject).toHaveBeenCalledTimes(2);
    expect(apiClient.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps polling a queued and running reanalysis until the snapshot is ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
    const failed = project({
      analysis: {
        stage: 'failed',
        snapshot_id: null,
        file_count: 0,
        symbol_count: 0,
        call_count: 0,
        languages: [],
        error: 'previous analysis failed',
        canonical_snapshot_key: null,
      },
    });
    const queued = project({
      analysis: {
        ...failed.analysis,
        started_at: '2026-08-16T00:00:00Z',
      },
    });
    const running = project({
      analysis: {
        ...failed.analysis,
        stage: 'scanning',
        error: null,
        started_at: '2026-08-16T00:00:02Z',
        progress_events: [
          { sequence: 1, kind: 'checking_existing', status: 'completed', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 2, kind: 'confirming_upstream', status: 'completed', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 3, kind: 'comparing_versions', status: 'completed', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 4, kind: 'incremental_analysis', status: 'running', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 5, kind: 'explaining_components', status: 'completed', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0, completed_batches: 3, total_batches: 3 },
          { sequence: 6, kind: 'planning_architecture', status: 'running', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 7, kind: 'discovering_values', status: 'running', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
          { sequence: 8, kind: 'preparing_source', status: 'completed', timestamp: '2026-08-16T00:00:02Z', elapsed_ms: 0 },
        ],
      },
    });
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(failed, null, false))
      .mockResolvedValueOnce(detail(queued, job('queued'), false))
      .mockResolvedValueOnce(detail(running, job('running'), false))
      .mockResolvedValueOnce(detail(project(), job('succeeded'), true));
    vi.mocked(apiClient.reanalyze).mockResolvedValue(reanalysisQueued);

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    fireEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    await flushReact();
    expect(screen.getByText('正在等待分析')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushReact();
    expect(apiClient.getProject).toHaveBeenCalledTimes(3);
    const analysisActivity = screen.getByTestId('analysis-activity');
    expect(analysisActivity).toHaveTextContent('正在归纳架构层与分组');
    expect(analysisActivity).toHaveTextContent('正在挖掘值得学习的设计');
    expect(analysisActivity).toHaveAttribute('data-status', 'running');
    expect(analysisActivity).toHaveTextContent('2s');
    fireEvent.click(within(analysisActivity).getByRole('button', { name: /正在归纳架构层与分组/ }));
    expect(analysisActivity).toHaveTextContent('已检查已有结果');
    expect(analysisActivity).toHaveTextContent("仓库版本检查完成");
    expect(analysisActivity).toHaveTextContent('已比较版本差异');
    expect(analysisActivity).not.toHaveTextContent('正在查阅仓库文件');
    expect(analysisActivity).toHaveTextContent('3/3 批');
    expect(analysisActivity.querySelectorAll('.activity-step.running')).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushReact();
    expect(apiClient.getProject).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-1');
    expect(apiClient.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('does not show completed and running rows for the same analysis stage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
    const failed = project({
      analysis: {
        stage: 'failed',
        snapshot_id: null,
        file_count: 0,
        symbol_count: 0,
        call_count: 0,
        languages: [],
        error: 'previous analysis failed',
        canonical_snapshot_key: null,
      },
    });
    const queued = project({
      analysis: { ...failed.analysis, started_at: '2026-08-16T00:00:00Z' },
    });
    const interpreting = project({
      analysis: {
        ...failed.analysis,
        stage: 'interpreting',
        error: null,
        started_at: '2026-08-16T00:00:02Z',
      },
    });
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(failed, null, false))
      .mockResolvedValueOnce(detail(queued, job('queued'), false))
      .mockResolvedValueOnce(detail(interpreting, null, false))
      .mockResolvedValueOnce(detail(interpreting, job('running'), false))
      .mockResolvedValueOnce(detail(project(), job('succeeded'), true));
    vi.mocked(apiClient.reanalyze).mockResolvedValue(reanalysisQueued);

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    fireEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    await flushReact();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    await flushReact();

    const analysisActivity = screen.getByTestId('analysis-activity');
    expect(analysisActivity).toHaveTextContent('正在生成架构图');
    fireEvent.click(within(analysisActivity).getByRole('button', { name: /正在生成架构图/ }));
    expect(analysisActivity).toHaveTextContent('正在生成架构图');
    expect(analysisActivity).not.toHaveTextContent('已生成架构图');
  });

  it('shows reanalysis after a cancelled job even when the project stage is stale', async () => {
    const cancelledProject = project({
      analysis: {
        ...project().analysis,
        stage: 'scanning',
        snapshot_id: null,
        error: null,
      },
    });
    const cancelledJob: AnalysisJob = {
      ...job('cancelled'),
      completed_at: '2026-08-16T00:00:03Z',
      error: '分析已停止，可重新分析。',
      error_code: 'analysis_cancelled',
    };
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(cancelledProject, cancelledJob, false));
    vi.mocked(apiClient.reanalyze).mockResolvedValue(reanalysisQueued);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    expect(await screen.findByText('分析已停止，可重新分析。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    expect(apiClient.reanalyze).toHaveBeenCalledWith('project-1');
  });

  it('treats a succeeded analysis job as terminal even if the project stage is stale', async () => {
    vi.useFakeTimers();
    const staleProject = project({
      analysis: {
        ...project().analysis,
        stage: 'interpreting',
      },
    });
    vi.mocked(apiClient.getProject).mockResolvedValueOnce(detail(staleProject, job('succeeded'), true));

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();

    expect(screen.queryByTestId('analysis-activity')).not.toBeInTheDocument();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(apiClient.getProject).toHaveBeenCalledTimes(1);
  });

  it('keeps an optimistic message when an analysis poll refreshes the project', async () => {
    vi.useFakeTimers();
    const runningProject = project({
      analysis: {
        ...project().analysis,
        stage: 'scanning',
        snapshot_id: null,
      },
    });
    const pendingSend = deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    vi.mocked(apiClient.getProject).mockResolvedValue(
      detail(runningProject, job('running'), false),
    );
    vi.mocked(apiClient.sendMessage).mockReturnValue(pendingSend.promise);

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    const composer = screen.getByPlaceholderText('尽情提问');
    fireEvent.change(composer, { target: { value: '轮询期间的消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await flushReact();
    expect(screen.getByText('轮询期间的消息')).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushReact();
    expect(apiClient.getProject).toHaveBeenCalledTimes(2);
    expect(screen.getByText('轮询期间的消息')).toBeVisible();

    pendingSend.reject(new Error('message failed after poll'));
    await flushReact();
    expect(screen.getByText('轮询期间的消息')).toBeVisible();
    expect(screen.getByText('服务端错误，请稍后重试。')).toBeVisible();
  });

  it('applies a slow analysis poll before scheduling the next request', async () => {
    vi.useFakeTimers();
    const runningProject = project({
      analysis: {
        ...project().analysis,
        stage: 'scanning',
        snapshot_id: null,
      },
      study: { ...project().study, total_steps: 3 },
    });
    const slowPoll = deferred<ProjectDetail>();
    const nextPoll = deferred<ProjectDetail>();
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(runningProject, job('running'), false))
      .mockReturnValueOnce(slowPoll.promise)
      .mockReturnValueOnce(nextPoll.promise);

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(apiClient.getProject).toHaveBeenCalledTimes(2);

    slowPoll.resolve(detail(project({
      analysis: { ...runningProject.analysis, stage: 'extracting' },
      study: { ...runningProject.study, current_step: 1 },
    }), job('running'), false));
    await flushReact();
    expect(screen.getByText("正在分析代码关系")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(apiClient.getProject).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiClient.getProject).toHaveBeenCalledTimes(3);
  });

  it('installs a delayed terminal snapshot while the project stays active', async () => {
    vi.useFakeTimers();
    const runningProject = project({
      analysis: {
        ...project().analysis,
        stage: 'scanning',
        snapshot_id: null,
      },
    });
    const delayedSnapshot = deferred<Snapshot>();
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(runningProject, job('running'), false))
      .mockResolvedValueOnce(detail(project(), job('succeeded'), true));
    vi.mocked(apiClient.getSnapshot).mockReturnValue(delayedSnapshot.promise);

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushReact();
    expect(apiClient.getSnapshot).toHaveBeenCalledWith('project-1', 'zh-CN');
    expect(screen.queryByTestId('repository-workspace')).not.toBeInTheDocument();

    delayedSnapshot.resolve(snapshot);
    await flushReact();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-1',
    );
  });

  it('does not install a late polled snapshot after switching projects', async () => {
    vi.useFakeTimers();
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const runningProject = project({
      analysis: {
        ...project().analysis,
        stage: 'scanning',
        snapshot_id: null,
      },
    });
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const pendingFirstSnapshot = deferred<Snapshot>();
    let firstProjectLoads = 0;
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => {
      if (id === 'project-2') return Promise.resolve(detail(secondProject, null, true));
      firstProjectLoads += 1;
      return Promise.resolve(
        firstProjectLoads === 1
          ? detail(runningProject, job('running'), false)
          : detail(project(), job('succeeded'), true),
      );
    });
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => (
      id === 'project-1'
        ? pendingFirstSnapshot.promise
        : Promise.resolve({
            ...snapshot,
            snapshot_id: 'snapshot-2',
            learning_plan: { ...snapshot.learning_plan, snapshot_id: 'snapshot-2' },
          })
    ));

    render(<App />);
    await flushReact();
    fireEvent.click(screen.getByText('python-edge-cases'));
    await flushReact();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushReact();
    expect(apiClient.getSnapshot).toHaveBeenCalledWith('project-1', 'zh-CN');

    fireEvent.click(screen.getByText('second-project'));
    await flushReact();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );

    pendingFirstSnapshot.resolve(snapshot);
    await flushReact();

    expect(screen.getByTestId('repository-workspace')).toHaveTextContent(
      'snapshot:snapshot-2',
    );
  });

  it('queues a ValuePoint learning prompt without mutating the StudyState', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '选择入口职责边界' }));

    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('selected:none');
    expect(apiClient.selectValuePoint).not.toHaveBeenCalled();
    expect(apiClient.getProject).toHaveBeenCalledTimes(1);
    expect(apiClient.getSnapshot).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('学习入口职责边界');
    expect(apiClient.sendMessage).not.toHaveBeenCalled();
  });

  it('reloads the complete StudyState after a teaching message', async () => {
    const updated = project({
      messages: [
        {
          message_id: 'user-1',
          role: 'user',
          content: '我理解入口只负责编排。',
          created_at: '2026-08-12T00:00:01Z',
          evidence: [],
          model: null,
          usage: null,
          latency_ms: null,
          error: null,
          placeholder: false,
        },
        {
          message_id: 'assistant-1',
          role: 'assistant',
          content: '继续核对领域服务的职责。',
          created_at: '2026-08-12T00:00:02Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 12,
          error: null,
          placeholder: false,
        },
      ],
      study: {
        phase: 'remediating',
        selected_value_point: 'value:entry',
        current_step: 1,
        total_steps: 3,
        mastered: ['能找到入口'],
        misconceptions: ['把入口当成业务实现'],
        open_questions: ['领域服务如何返回结果'],
        used_evidence: ['fact:symbol:main.py:main'],
      },
    });
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(project(), null, true))
      .mockResolvedValueOnce(detail(updated, null, true));
    vi.mocked(apiClient.sendMessage).mockResolvedValue({
      user_message: updated.messages[0],
      assistant_message: updated.messages[1],
      teaching_phase: 'remediating',
      validation_errors: [],
      tools_used: ['assess_understanding'],
      state_changed: true,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(screen.getByRole('button', { name: '选择领域服务组件' }));
    const composer = await screen.findByPlaceholderText('尽情提问');
    fireEvent.change(composer, { target: { value: '我理解入口只负责编排。' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(await screen.findByText('继续核对领域服务的职责。')).toBeInTheDocument();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('selected:value:entry');
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('step:1/3');
    expect(apiClient.sendMessage).toHaveBeenCalledWith(
      'project-1',
      '我理解入口只负责编排。',
      {
        snapshot_id: 'snapshot-1',
        kind: 'component',
        stable_id: 'component:domain',
        label: '领域服务',
      },
      false,
    );
    expect(apiClient.getProject).toHaveBeenCalledTimes(2);
  });

  it('keeps the same validated selection across consecutive questions', async () => {
    const firstReply = project({
      messages: [
        {
          message_id: 'assistant-1',
          role: 'assistant',
          content: '第一次回答',
          created_at: '2026-08-14T00:00:00Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 10,
          error: null,
          placeholder: false,
        },
      ],
    });
    const secondReply = project({
      messages: [
        ...firstReply.messages,
        {
          message_id: 'assistant-2',
          role: 'assistant',
          content: '第二次回答',
          created_at: '2026-08-14T00:00:01Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 10,
          error: null,
          placeholder: false,
        },
      ],
    });
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(project(), null, true))
      .mockResolvedValueOnce(detail(firstReply, null, true))
      .mockResolvedValueOnce(detail(secondReply, null, true));
    vi.mocked(apiClient.sendMessage).mockResolvedValue({
      user_message: {
        message_id: 'user',
        role: 'user',
        content: 'question',
        created_at: '2026-08-14T00:00:00Z',
        evidence: [],
        model: null,
        usage: null,
        latency_ms: null,
        error: null,
        placeholder: false,
      },
      assistant_message: firstReply.messages[0],
      teaching_phase: 'orienting',
      validation_errors: [],
      tools_used: ['get_component_context'],
      state_changed: false,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '选择领域服务组件' }));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, '第一个问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText('第一次回答')).toBeVisible();
    await userEvent.type(composer, '第二个问题');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText('第二次回答')).toBeVisible();

    const expectedSelection = {
      snapshot_id: 'snapshot-1',
      kind: 'component' as const,
      stable_id: 'component:domain',
      label: '领域服务',
    };
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(
      1,
      'project-1',
      '第一个问题',
      expectedSelection,
      false,
    );
    expect(apiClient.sendMessage).toHaveBeenNthCalledWith(
      2,
      'project-1',
      '第二个问题',
      expectedSelection,
      false,
    );
  });

  it('shows the reply and unlocks the composer before refresh finishes', async () => {
    const userMessage: Message = {
      message_id: 'user-persisted',
      role: 'user',
      content: '这条消息应该立刻出现',
      created_at: '2026-08-14T00:00:00Z',
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    const assistantMessage: Message = {
      message_id: 'assistant-persisted',
      role: 'assistant',
      content: '这是已经生成完成的回答',
      created_at: '2026-08-14T00:00:01Z',
      evidence: [],
      model: 'test-model',
      usage: null,
      latency_ms: 20,
      error: null,
      placeholder: false,
    };
    const send = deferred<Awaited<ReturnType<typeof apiClient.sendMessage>>>();
    const refresh = deferred<ProjectDetail>();
    vi.mocked(apiClient.getProject)
      .mockResolvedValueOnce(detail(project(), null, true))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValue(detail(project({
        messages: [userMessage, assistantMessage],
      }), null, true));
    vi.mocked(apiClient.sendMessage).mockReturnValue(send.promise);
    vi.mocked(apiClient.sendMessageStream).mockImplementation(
      (id, content, uiContext, onProgress) => {
        onProgress({
          stage: 'tool_started',
          label: '正在检索代码证据',
          status: 'running',
          elapsed_ms: 12,
          tool_name: 'query_code_evidence',
        });
        return apiClient.sendMessage(id, content, uiContext);
      },
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, userMessage.content);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(await screen.findByText(userMessage.content)).toBeVisible();
    expect(screen.getByTestId('conversation-activity')).toBeVisible();
    expect(composer).toBeEnabled();
    await userEvent.type(composer, '下一条可以先写');
    expect(composer).toHaveValue('下一条可以先写');

    await act(async () => {
      send.resolve({
        user_message: userMessage,
        assistant_message: assistantMessage,
        teaching_phase: 'orienting',
        validation_errors: [],
        tools_used: [],
        state_changed: false,
      });
      await send.promise;
    });

    expect(await screen.findByText(assistantMessage.content)).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId('conversation-activity')).not.toBeInTheDocument();
    });
    expect(screen.getAllByText(userMessage.content)).toHaveLength(1);
    expect(composer).toBeEnabled();
    await userEvent.clear(composer);
    await userEvent.type(composer, '刷新期间继续提问');
    const sendButton = screen.getByRole('button', { name: '发送消息' });
    expect(sendButton).toBeEnabled();
    await userEvent.click(sendButton);
    await waitFor(() => expect(apiClient.sendMessage).toHaveBeenCalledTimes(2));

    await act(async () => {
      refresh.resolve(detail(project({
        messages: [userMessage, assistantMessage],
      }), null, true));
      await refresh.promise;
    });
  });

  it('does not show a generation bubble while only queueing a study prompt', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    await userEvent.click(await screen.findByRole('button', { name: '选择入口职责边界' }));

    expect(apiClient.selectValuePoint).not.toHaveBeenCalled();
    expect(screen.queryByTestId('conversation-activity')).not.toBeInTheDocument();
    expect(screen.getByTestId('repository-workspace')).toHaveTextContent('selected:none');
    expect(screen.getByPlaceholderText('尽情提问')).toHaveValue('学习入口职责边界');
  });

  it('shows a natural fallback without exposing an internal error code', async () => {
    const failedMessageProject = project({
      messages: [
        {
          message_id: 'assistant-error',
          role: 'assistant',
          content: '这次没有完成回答，请稍后重试。',
          created_at: '2026-08-14T00:00:00Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 15,
          error: 'structured_output_invalid: raw provider payload',
          placeholder: false,
        },
      ],
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(
      detail(failedMessageProject, null, true),
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    expect(await screen.findByText('这次没有完成回答，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByText(/structured_output_invalid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/raw provider payload/)).not.toBeInTheDocument();
  });

  it('shows an explicit cancellation result instead of a send failure', async () => {
    const pending = deferred<Awaited<ReturnType<typeof apiClient.sendMessageStream>>>();
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(
      (_id, _content, _selection, onProgress) => {
        onProgress({
          run_id: 'run-cancel-ui',
          stage: 'run_connected',
          label: '正在准备回答',
          status: 'running',
          elapsed_ms: 0,
        });
        return pending.promise;
      },
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, '取消这轮回答');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await userEvent.click(await screen.findByRole('button', { name: '取消本轮回答' }));

    expect(apiClient.cancelRun).toHaveBeenCalledWith('project-1', 'run-cancel-ui');
    expect(await screen.findByText('正在取消')).toBeVisible();
    const cancellation = Object.assign(new Error('本轮回答已取消。'), { code: 'cancelled' });
    await act(async () => {
      pending.reject(cancellation);
      await pending.promise.catch(() => undefined);
    });

    expect(await screen.findByText('已取消')).toBeVisible();
    expect(screen.queryByText('这次消息没有发送成功，请稍后重试。')).not.toBeInTheDocument();
  });

  it('does not pin a cancelled turn to the end after switching projects and returning', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const persistedCancelledUser: Message = {
      message_id: 'cancelled-user-persisted',
      role: 'user',
      content: '取消后的问题',
      created_at: '2026-08-14T00:00:02Z',
      evidence: [],
      model: null,
      usage: null,
      latency_ms: null,
      error: null,
      placeholder: false,
    };
    const firstProjectAfterReturn = project({
      messages: [
        {
          message_id: 'earlier-user', role: 'user', content: '之前的问题',
          created_at: '2026-08-14T00:00:00Z', evidence: [], model: null,
          usage: null, latency_ms: null, error: null, placeholder: false,
        },
        {
          message_id: 'earlier-assistant', role: 'assistant', content: '之前的回答',
          created_at: '2026-08-14T00:00:01Z', evidence: [], model: 'test-model',
          usage: null, latency_ms: 10, error: null, placeholder: false,
        },
        persistedCancelledUser,
      ],
    });
    const pending = deferred<Awaited<ReturnType<typeof apiClient.sendMessageStream>>>();
    let firstProjectLoads = 0;
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => {
      if (id === 'project-2') return Promise.resolve(detail(secondProject, null, true));
      firstProjectLoads += 1;
      return Promise.resolve(detail(
        firstProjectLoads >= 2 ? firstProjectAfterReturn : project(),
        null,
        true,
      ));
    });
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(
      (_id, _content, _selection, onProgress) => {
        onProgress({
          run_id: 'run-cancel-switch',
          stage: 'run_connected',
          label: '正在准备回答',
          status: 'running',
          elapsed_ms: 0,
        });
        return pending.promise;
      },
    );

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, persistedCancelledUser.content);
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await userEvent.click(await screen.findByRole('button', { name: '取消本轮回答' }));
    await waitFor(() => expect(apiClient.cancelRun).toHaveBeenCalledWith('project-1', 'run-cancel-switch'));

    await act(async () => {
      pending.reject(Object.assign(new Error('本轮回答已取消。'), { code: 'cancelled' }));
      await pending.promise.catch(() => undefined);
    });
    expect(await screen.findByText('已取消')).toBeVisible();

    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-2');
    await userEvent.click(screen.getByText('python-edge-cases'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-1');

    expect(screen.getAllByText(persistedCancelledUser.content)).toHaveLength(1);
    expect(screen.queryByText('本轮回答已取消。')).not.toBeInTheDocument();
    expect(screen.getAllByText('之前的问题')).toHaveLength(1);
    expect(firstProjectLoads).toBeGreaterThanOrEqual(2);
  });

  it('does not apply a late cancel response to the project currently on screen', async () => {
    const otherSummary: ProjectSummary = {
      ...summary,
      project_id: 'project-2',
      title: 'second-project',
      source_value: 'second-project',
    };
    const secondProject = project({
      project_id: 'project-2',
      title: 'second-project',
      source: {
        kind: 'fixture',
        value: 'second-project',
        commit_sha: null,
        display_name: 'second-project',
      },
      analysis: { ...project().analysis, snapshot_id: 'snapshot-2' },
    });
    const pendingStream = deferred<Awaited<ReturnType<typeof apiClient.sendMessageStream>>>();
    const pendingCancel = deferred<Awaited<ReturnType<typeof apiClient.cancelRun>>>();
    vi.mocked(apiClient.listProjects).mockResolvedValue([summary, otherSummary]);
    vi.mocked(apiClient.getProject).mockImplementation(id => Promise.resolve(
      detail(id === 'project-1' ? project() : secondProject, null, true),
    ));
    vi.mocked(apiClient.getSnapshot).mockImplementation(id => Promise.resolve({
      ...snapshot,
      snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      learning_plan: {
        ...snapshot.learning_plan,
        snapshot_id: id === 'project-1' ? 'snapshot-1' : 'snapshot-2',
      },
    }));
    vi.mocked(apiClient.sendMessageStream).mockImplementation(
      (_id, _content, _selection, onProgress) => {
        onProgress({
          run_id: 'run-late-cancel',
          stage: 'run_connected',
          label: '正在准备回答',
          status: 'running',
          elapsed_ms: 0,
        });
        return pendingStream.promise;
      },
    );
    vi.mocked(apiClient.cancelRun).mockReturnValue(pendingCancel.promise);

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const composer = await screen.findByPlaceholderText('尽情提问');
    await userEvent.type(composer, '切换时取消');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    await userEvent.click(await screen.findByRole('button', { name: '取消本轮回答' }));
    await waitFor(() => expect(apiClient.cancelRun).toHaveBeenCalledWith('project-1', 'run-late-cancel'));

    await userEvent.click(screen.getByText('second-project'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-2');
    await act(async () => {
      pendingCancel.resolve({ run_id: 'run-late-cancel', status: 'cancelling' });
      await pendingCancel.promise;
    });
    expect(screen.queryByText('正在取消')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('python-edge-cases'));
    expect(await screen.findByTestId('repository-workspace')).toHaveTextContent('snapshot:snapshot-1');
    expect(await screen.findByTestId('conversation-activity')).toBeVisible();

    await act(async () => {
      pendingStream.reject(Object.assign(new Error('本轮回答已取消。'), { code: 'cancelled' }));
      await pendingStream.promise.catch(() => undefined);
    });
  });

  it('renders assistant markdown without external images or links', async () => {
    const markdownProject = project({
      messages: [
        {
          message_id: 'assistant-markdown',
          role: 'assistant',
          content: '![跟踪图](https://tracker.example/pixel.png) [外部说明](https://example.com)',
          created_at: '2026-08-14T00:00:00Z',
          evidence: [],
          model: 'test-model',
          usage: null,
          latency_ms: 15,
          error: null,
          placeholder: false,
        },
      ],
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(
      detail(markdownProject, null, true),
    );

    const { container } = render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    await waitFor(() => expect(screen.getByText('[图片：跟踪图]')).toBeVisible());
    expect(screen.getByText('外部说明')).toBeVisible();
    expect(container.querySelector('img[src="https://tracker.example/pixel.png"]')).toBeNull();
    expect(container.querySelector('a[href="https://example.com"]')).toBeNull();
  });

  it('syntax-highlights fenced code in assistant answers', async () => {
    const markdownProject = project({
      messages: [{
        message_id: 'assistant-code-highlight',
        role: 'assistant',
        content: '```json\n{"name":"API","enabled":true,"count":2}\n```',
        created_at: '2026-08-14T00:00:00Z',
        evidence: [],
        model: 'test-model',
        usage: null,
        latency_ms: 15,
        error: null,
        placeholder: false,
      }],
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(markdownProject, null, true));

    const { container } = render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    expect(container.querySelector('.msg-bubble pre code.hljs.language-json')).not.toBeNull();
    expect(container.querySelector('.msg-bubble pre .hljs-attr')).not.toBeNull();
    expect(container.querySelector('.msg-bubble pre .hljs-string')).not.toBeNull();
    expect(container.querySelector('.msg-bubble pre .hljs-number')).not.toBeNull();
  });

  it('shows short source labels while preserving targets and leaving ambiguous names unlinked', async () => {
    const refs = ['src/task_queue/common.ts', 'src/common.ts', 'src/entry.ts'].map((path, index) => ({
      stable_id: `ref-${index}`, label: path, path, start_line: 1, end_line: 4, kind: 'file', snapshot_id: 'snapshot-1',
    }));
    refs.push({ ...refs[2], start_line: 2 }); // Another excerpt does not add a duplicate file chip.
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project({ messages: [{
      message_id: 'compact-references', role: 'assistant',
      content: '看 `src/task_queue/common.ts:1`、`src/common.ts:1`、`src/entry.ts:2`；单独的 `common.ts:1` 无法确定位置，`missing.ts:7` 尚未核实。',
      created_at: '2026-08-14T00:00:00Z', evidence: refs, model: 'test-model', usage: null,
      latency_ms: 10, error: null, placeholder: false, analysis_snapshot_id: 'snapshot-1',
    }] }), null, true));
    vi.mocked(apiClient.getSource).mockResolvedValue({ snapshot_id: 'snapshot-1', path: 'src/entry.ts',
      start_line: 1, end_line: 4, lines: ['line 1', 'line 2', 'line 3', 'line 4'], truncated: false });
    const { container } = render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const entry = await screen.findByRole('button', { name: '打开源码 src/entry.ts:2' });
    expect(container.querySelectorAll('.evidence-chips button')).toHaveLength(3);
    expect(entry).toHaveTextContent('entry.ts:2');
    expect(entry).toHaveAttribute('title', 'src/entry.ts:2');
    expect(screen.getByRole('button', { name: '打开源码 src/task_queue/common.ts:1' })).toHaveTextContent('task_queue/common.ts:1');
    expect(screen.queryByRole('button', { name: '打开源码 common.ts:1' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开源码 missing.ts:7' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开源码 src/entry.ts:2' }));
    await waitFor(() => expect(apiClient.getSource).toHaveBeenCalledWith('project-1', 'snapshot-1', 'src/entry.ts', 1, 162, 'ref-2'));
  });

  it('opens only line-numbered file references without mistaking code members for files', async () => {
    const markdownProject = project({
      messages: [{
        message_id: 'assistant-inline-files',
        role: 'assistant',
        content: '看 `ShapeMagic.jsx:75-77`、`liquid.js`、`composer.lock`、`Cargo.toml.orig`、`.secrets.baseline` 和 `mvnw`，但 `Field.eval`、`Math.min` 只是代码成员。',
        created_at: '2026-08-14T00:00:00Z',
        evidence: [
          {
            stable_id: 'shape-magic', label: 'ShapeMagic', path: 'ShapeMagic.jsx',
            start_line: 75, end_line: 77, kind: 'verified', snapshot_id: 'snapshot-1',
          },
          {
            stable_id: 'liquid', label: 'liquid', path: 'liquid.js',
            start_line: null, end_line: null, kind: 'verified', snapshot_id: 'snapshot-1',
          },
        ],
        model: 'test-model',
        usage: null,
        latency_ms: 15,
        error: null,
        placeholder: false,
        analysis_snapshot_id: 'snapshot-1',
      }],
    });
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(markdownProject, null, true));
    vi.mocked(apiClient.getSource).mockResolvedValue({
      snapshot_id: 'snapshot-1', path: 'ShapeMagic.jsx', start_line: 35, end_line: 75,
      lines: ['source'], truncated: false,
    });

    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));

    const rangeReference = await screen.findByRole('button', { name: '打开源码 ShapeMagic.jsx:75-77' });
    expect(rangeReference.querySelector('.devicon-react-original')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '打开源码 liquid.js' })).toBeNull();
    const markdownLabel = (text: string) => screen.getAllByText(text)
      .map(element => element.closest('.markdown-file-reference-label'))
      .find(Boolean) as HTMLElement | undefined;
    const liquid = markdownLabel('liquid.js');
    const composerLock = markdownLabel('composer.lock');
    const cargoOrig = markdownLabel('Cargo.toml.orig');
    const secretsBaseline = markdownLabel('.secrets.baseline');
    const mavenWrapper = markdownLabel('mvnw');
    expect(liquid).not.toBeNull();
    expect(composerLock?.querySelector('.iconpark-code-file-one')).not.toBeNull();
    expect(cargoOrig?.querySelector('.iconpark-code-file-one')).not.toBeNull();
    expect(secretsBaseline?.querySelector('.iconpark-code-file-one')).not.toBeNull();
    expect(mavenWrapper?.querySelector('.iconpark-code-file-one')).not.toBeNull();
    expect(screen.getByText('Field.eval').closest('button')).toBeNull();
    expect(screen.getByText('Math.min').closest('button')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '打开源码 ShapeMagic.jsx:75-77' }));
    await waitFor(() => expect(apiClient.getSource).toHaveBeenCalledWith(
      'project-1', 'snapshot-1', 'ShapeMagic.jsx', 35, 235, 'shape-magic',
    ));

    await userEvent.click(screen.getByRole('button', { name: '关闭源码预览' }));
    expect(apiClient.getSource).toHaveBeenCalledTimes(1);
  });
});

describe('learner profile settings', () => {
  it('shows, saves, and regenerates the user-facing memory summary', async () => {
    const editedProfile: LearnerProfile = {
      ...learnerProfile,
      memory_summary: '你熟悉 C 和 Go，偏好先理清输入输出。',
      memory_summary_mode: 'edited',
      memory_summary_updated_at: '2026-09-01T09:30:00Z',
    };
    const regeneratedProfile: LearnerProfile = {
      ...learnerProfile,
      memory_summary: '你正在练习沿代码证据还原调用链。',
      memory_summary_mode: 'generated',
      memory_summary_updated_at: '2026-09-01T09:31:00Z',
    };
    vi.mocked(apiClient.updateMemorySummary).mockResolvedValue({ profile: editedProfile });
    vi.mocked(apiClient.regenerateMemorySummary).mockResolvedValue({ profile: regeneratedProfile });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));

    await userEvent.click(await screen.findByRole('button', { name: '记忆摘要' }));
    const summaryInput = await screen.findByRole('textbox', { name: '记忆摘要' });
    expect(summaryInput).toHaveValue(learnerProfile.memory_summary);
    await userEvent.clear(summaryInput);
    await userEvent.type(summaryInput, editedProfile.memory_summary ?? '');
    await userEvent.click(screen.getByRole('button', { name: '保存摘要' }));

    expect(apiClient.updateMemorySummary).toHaveBeenCalledWith(editedProfile.memory_summary);
    expect(await within(screen.getByRole('dialog', { name: '记忆摘要' })).findByText('记忆摘要已保存')).toBeInTheDocument();
    expect(summaryInput).toHaveValue(editedProfile.memory_summary);

    await userEvent.click(screen.getByRole('button', { name: '重新整理记忆摘要' }));

    expect(apiClient.regenerateMemorySummary).toHaveBeenCalledTimes(1);
    expect(await within(screen.getByRole('dialog', { name: '记忆摘要' })).findByText('记忆摘要已重新整理')).toBeInTheDocument();
    expect(summaryInput).toHaveValue(regeneratedProfile.memory_summary);
  });

  it('presents memory settings without exposing internal inferred-claim editors', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(await screen.findByRole('button', { name: '记忆摘要' })).toBeInTheDocument();
    expect(screen.queryByLabelText('推断内容：claim:call-chain')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存推断画像|删除推断画像/ })).not.toBeInTheDocument();
    expect(apiClient.updateInferredProfileClaim).not.toHaveBeenCalled();
    expect(apiClient.deleteInferredProfileClaim).not.toHaveBeenCalled();
  });
});

describe('interface and project language', () => {
  it('switches existing language variants without clearing the draft and ignores a late language response', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    const english = deferred<Snapshot>();
    vi.mocked(apiClient.getSnapshot).mockImplementation(async (_id, language) => language === 'en'
      ? english.promise : { ...snapshot, display_language: 'zh-CN' });
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    await openRepositoryPanel();
    expect(await screen.findByText('language:zh-CN')).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('尽情提问'), '我的草稿');
    await userEvent.click(screen.getByRole('button', { name: /The Octocat/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    await waitFor(() => expect(apiClient.getSnapshot).toHaveBeenCalledWith('project-1', 'en'));
    await userEvent.click(screen.getByRole('button', { name: /The Octocat/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: '简体中文' }));
    await act(async () => { english.resolve({ ...snapshot, display_language: 'en' }); });
    expect(screen.getByText('language:zh-CN')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /The Octocat/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByText('language:en')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask anything')).toHaveValue('我的草稿');
    expect(apiClient.reanalyze).not.toHaveBeenCalled();
  });

  it('switches interface labels, persists the choice, and leaves the current project intact', async () => {
    vi.mocked(apiClient.getProject).mockResolvedValue(detail(project(), null, true));
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const reads = vi.mocked(apiClient.getProject).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: /The Octocat/ }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(screen.getByText('python-edge-cases')).toBeInTheDocument();
    expect(apiClient.getProject).toHaveBeenCalledTimes(reads);
    expect(apiClient.reanalyze).not.toHaveBeenCalled();
    const toggle = screen.getByRole('button', { name: 'Settings' });
    expect(toggle?.nextElementSibling).toHaveAccessibleName('Switch to dark theme');
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New learning project' });
    expect(within(dialog).getByRole('combobox', { name: 'Project language' })).toHaveValue('en');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
    expect(apiClient.createProject).not.toHaveBeenCalled();
  });

  it('lets a project use English independently without losing the draft or changing the interface', async () => {
    vi.mocked(apiClient.listProjects).mockResolvedValue([]);
    vi.mocked(apiClient.createProject).mockResolvedValue(detail(project(), job('queued'), false));
    render(<App />);
    await userEvent.click((await screen.findAllByRole('button', { name: '新建项目' }))[0]);
    const dialog = screen.getByRole('dialog', { name: "新的学习项目" });
    await userEvent.type(within(dialog).getByLabelText('公开 GitHub 仓库地址'), 'https://github.com/example/repo');
    await userEvent.type(within(dialog).getByLabelText('项目名称（可选）'), '保留我的名称');
    await userEvent.click(within(dialog).getByRole('combobox', { name: '项目语言' }));
    await userEvent.click(screen.getByRole('option', { name: 'English' }));
    expect(within(dialog).getByLabelText('Public GitHub repository URL')).toHaveValue('https://github.com/example/repo');
    expect(within(dialog).getByLabelText('Project name (optional)')).toHaveValue('保留我的名称');
    expect(getUiLanguage()).toBe('zh-CN');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start analysis' }));
    await waitFor(() => expect(apiClient.createProject).toHaveBeenCalledWith({
      kind: 'github', value: 'https://github.com/example/repo', title: '保留我的名称', display_language: 'en',
    }));
  });
});

describe('provider settings', () => {
  it('shows domestic provider families, hides foreign providers, and offers plan variants', async () => {
    vi.mocked(apiClient.getSettings).mockResolvedValue({
      ...settings,
      provider_presets: [
        { id: 'deepseek', label: 'DeepSeek', base_url: 'https://api.deepseek.com', custom_base_url: false },
        { id: 'zai-api-cn', label: '智谱 GLM · 中国大陆', family: 'glm', family_label: '智谱 GLM', variant_label: '开放平台 API · 中国大陆', base_url: 'https://open.bigmodel.cn/api/paas/v4', custom_base_url: false },
        { id: 'zai-coding-cn', label: '智谱 GLM Coding · 中国大陆', family: 'glm', family_label: '智谱 GLM', variant_label: 'Coding Plan · 中国大陆', base_url: 'https://open.bigmodel.cn/api/coding/paas/v4', custom_base_url: false },
        { id: 'moonshotai-cn', label: 'Kimi · 中国大陆', family: 'kimi', family_label: 'Kimi', variant_label: 'API · 中国大陆', base_url: 'https://api.moonshot.cn/v1', custom_base_url: false },
        { id: 'qwen-token-plan-cn', label: '通义千问 · 中国大陆', family: 'qwen', family_label: '通义千问', variant_label: 'Token Plan · 中国大陆', base_url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', custom_base_url: false },
        { id: 'qwen-api-cn', label: '通义千问 · 中国大陆', family: 'qwen', family_label: '通义千问', variant_label: '百炼兼容 API · 中国大陆', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', custom_base_url: false },
        { id: 'minimax-cn', label: 'MiniMax · 中国大陆', family: 'minimax', family_label: 'MiniMax', variant_label: 'API · 中国大陆', base_url: 'https://api.minimaxi.com/anthropic', custom_base_url: false },
        { id: 'xiaomi', label: '小米 MiMo', family: 'mimo', family_label: '小米 MiMo', variant_label: '官方 API', base_url: 'https://api.xiaomimimo.com/v1', custom_base_url: false },
        { id: 'xiaomi-token-plan-cn', label: '小米 MiMo · 中国大陆', family: 'mimo', family_label: '小米 MiMo', variant_label: 'Token Plan · 中国大陆', base_url: 'https://token-plan-cn.xiaomimimo.com/v1', custom_base_url: false },
        { id: 'doubao', label: '豆包', family: 'doubao', family_label: '豆包', variant_label: '火山方舟兼容 API', base_url: 'https://ark.cn-beijing.volces.com/api/v3', custom_base_url: false },
        { id: 'hunyuan', label: '腾讯混元', family: 'hunyuan', family_label: '腾讯混元', variant_label: 'OpenAI 兼容 API', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', custom_base_url: false },
        { id: 'custom', label: '自定义 OpenAI 兼容接口', family: 'custom', family_label: '自定义接口', variant_label: 'OpenAI 兼容', base_url: '', custom_base_url: true },
      ],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: "添加 API 配置" }));

    for (const name of ['DeepSeek', 'GLM', 'Kimi', '千问', 'MiniMax', 'MiMo', '豆包', '混元', '自定义接口']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('radio', { name: 'GPT' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Claude' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Gemini' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Grok' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'GLM' }).querySelector('img'))
      .toHaveAttribute('src', '/providers/zai-user.svg');
    await userEvent.click(screen.getByRole('radio', { name: '千问' }));
    const planSelect = await screen.findByRole('combobox', { name: "套餐与地区" });
    await userEvent.click(planSelect);
    expect(screen.getByRole('option', { name: 'Token Plan · 中国大陆' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '百炼兼容 API · 中国大陆' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /国际|新加坡|欧洲/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/兼容名称/)).not.toBeInTheDocument();
  });

  it('refreshes an existing connection without exposing an edit action', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: '管理 测试' }));
    expect(screen.queryByRole('menuitem', { name: '编辑' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: '刷新模型列表' }));

    expect(apiClient.verifySettings).toHaveBeenCalledWith('test');
    expect(await screen.findByText('验证成功')).toBeInTheDocument();
    expect(screen.getByText('test-model-pro')).toBeInTheDocument();
  });

  it('requires a verified nonempty model list before adding a connection', async () => {
    vi.mocked(apiClient.addProviderConnection).mockRejectedValue(new Error('验证失败'));
    vi.mocked(apiClient.verifyProviderConnection).mockResolvedValue({
      ok: true,
      models: ['provider-model'],
      models_endpoint_supported: true,
      message: '验证成功，已拉取模型列表',
      verification_token: 'token-for-test',
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: "添加 API 配置" }));

    expect(screen.queryByLabelText(/模型 ID/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从上游获取' })).toBeDisabled();
    expect(within(screen.getByRole('dialog', { name: "添加 API 配置" })).getByRole('button', { name: "添加 API 配置" })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: '自定义接口' }));
    await userEvent.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'https://provider.example/v1');
    await userEvent.type(screen.getByPlaceholderText('填入 API Key'), 'key-for-test');
    await userEvent.click(screen.getByRole('button', { name: '从上游获取' }));
    expect(apiClient.verifyProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      api_key: 'key-for-test',
    }));
    expect(within(screen.getByRole('dialog', { name: "添加 API 配置" })).getByRole('button', { name: "添加 API 配置" })).not.toBeDisabled();
    await userEvent.click(within(screen.getByRole('dialog', { name: "添加 API 配置" })).getByRole('button', { name: "添加 API 配置" }));
    expect(apiClient.addProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      api_key: 'key-for-test',
      verification_token: 'token-for-test',
    }));
    const dialog = await screen.findByRole('dialog', { name: "添加 API 配置" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('验证失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeInTheDocument();
  });

  it('keeps the add dialog open and shows fetched models after successful verification', async () => {
    vi.mocked(apiClient.verifyProviderConnection).mockResolvedValue({
      ok: true,
      models: ['provider-model'],
      models_endpoint_supported: true,
      message: '验证成功，已读取 1 个可对话模型',
      verification_token: 'token-for-success',
    });
    vi.mocked(apiClient.addProviderConnection).mockResolvedValue({
      ...settings,
      providers: [
        ...settings.providers,
        {
          ...settings.providers[0],
          connection_id: 'new-connection',
          label: '新连接',
          custom_models: ['provider-model'],
          models_source: 'provider',
          last_verified_at: '2026-09-01T00:00:00Z',
          verify_error: null,
        },
      ],
    });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: "添加 API 配置" }));
    await userEvent.type(screen.getByPlaceholderText('https://api.example.com/v1'), 'https://provider.example/v1');
    await userEvent.type(screen.getByPlaceholderText('填入 API Key'), 'key-for-success');
    await userEvent.click(screen.getByRole('button', { name: '从上游获取' }));

    const dialog = await screen.findByRole('dialog', { name: "添加 API 配置" });
    expect(within(dialog).getByText('验证成功')).toBeInTheDocument();
    expect(within(dialog).getByText('provider-model')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: "添加 API 配置" })).not.toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: "添加 API 配置" }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "添加 API 配置" })).not.toBeInTheDocument());
    expect(apiClient.addProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      verification_token: 'token-for-success',
      models: ['provider-model'],
    }));
  });

  it('only adds a manual model after success, keeps prior models after failure, and saves deletions', async () => {
    vi.mocked(apiClient.verifyProviderConnection)
      .mockResolvedValueOnce({ ok: true, models: ['test-model', 'manual-preview'], models_endpoint_supported: false, message: '模型验证成功，已收到对话回复', verification_token: 'manual-proof' })
      .mockResolvedValueOnce({ ok: false, models: [], models_endpoint_supported: false, message: '模型验证失败，请检查名称、模型权限、额度或网络后重试' });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: '管理 测试' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '管理模型' }));
    const dialog = within(screen.getByRole('dialog', { name: '管理模型' }));
    await userEvent.click(dialog.getByRole('button', { name: '添加模型' }));
    await userEvent.type(dialog.getByLabelText('模型名称'), 'manual-preview');
    expect(dialog.queryByRole('button', { name: '删除模型 manual-preview' })).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: '验证并添加' }));
    expect(apiClient.verifyProviderConnection).toHaveBeenCalledWith(expect.objectContaining({ existing_connection_id: 'test', model_id: 'manual-preview', models: ['test-model'] }));
    expect(await dialog.findByRole('button', { name: '删除模型 manual-preview' })).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: '添加模型' }));
    await userEvent.type(dialog.getByLabelText('模型名称'), 'missing-model');
    await userEvent.click(dialog.getByRole('button', { name: '验证并添加' }));
    expect(await dialog.findByText(/模型验证失败/)).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: '删除模型 missing-model' })).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: '删除模型 test-model' }));
    await userEvent.click(dialog.getByRole('button', { name: '保存模型列表' }));
    expect(apiClient.updateProviderModels).toHaveBeenCalledWith('test', { models: ['manual-preview'], verification_token: 'manual-proof' });
  });

  it('disables saving when the last model is removed', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    await userEvent.click(await screen.findByRole('button', { name: '管理 测试' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '管理模型' }));
    const dialog = within(screen.getByRole('dialog', { name: '管理模型' }));
    await userEvent.click(dialog.getByRole('button', { name: '删除模型 test-model' }));
    expect(dialog.getByRole('button', { name: '保存模型列表' })).toBeDisabled();
    expect(apiClient.updateProviderModels).not.toHaveBeenCalled();
  });

  it('shows provider-default thinking for an unlisted model and keeps it disabled', async () => {
    vi.mocked(apiClient.getSettings).mockResolvedValue({
      ...settings,
      model: 'provider:test:provider-model',
      model_options: [{
        selector: 'provider:test:provider-model',
        connection_id: 'test',
        provider: 'custom',
        model_id: 'provider-model',
        label: '测试 / provider-model',
        thinking_levels: ['off'],
      }],
      available_models: ['provider:test:provider-model'],
      selected_model_option: null,
    });
    render(<App />);
    await userEvent.click(await screen.findByText('python-edge-cases'));
    const thinking = await screen.findByRole('combobox', { name: '思考程度' });
    expect(thinking).toBeDisabled();
    expect(within(thinking).getByText('默认')).toBeInTheDocument();
    expect(within(thinking).queryByText('关闭')).not.toBeInTheDocument();
  });

  it('shows deployment-managed credentials without an editable key field', async () => {
    vi.mocked(apiClient.getSettings).mockResolvedValue(deploymentSettings);

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByText("由网站管理员提供")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('重新输入以替换')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('填入 API Key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '清除' })).not.toBeInTheDocument();
  });
});

describe('identity and onboarding controls', () => {
  it('places the concise guest notice below guest login and keeps personal API keys unavailable', async () => {
    const guestSettings: SettingsResponse = {
      ...settings,
      model: 'free:deepseek-v4-flash',
      available_models: ['free:deepseek-v4-flash'],
      has_api_key: false,
      api_key_masked: null,
      can_manage_api_key: false,
    };
    vi.mocked(apiClient.authConfig).mockResolvedValue({
      auth_mode: 'github',
      guest_enabled: true,
    });
    vi.mocked(apiClient.authMe).mockRejectedValue({ status: 401 });
    vi.mocked(apiClient.createGuest).mockResolvedValue({
      owner_id: 'guest:test',
      login: 'guest',
      display_name: '访客',
      avatar_url: null,
      kind: 'guest',
      auth_mode: 'github',
    });
    vi.mocked(apiClient.listProjects).mockResolvedValue([]);
    vi.mocked(apiClient.getSettings).mockResolvedValue(guestSettings);

    render(<App />);

    const guestNotice = await screen.findByText("访客记录仅在当前浏览器可用。更换设备、清除 Cookie 或登录凭据过期后，可能无法找回；登录 GitHub 可保存到账号。");
    expect(guestNotice).toBeVisible();
    const guestButton = screen.getByRole('button', { name: '以访客身份体验' });
    expect(guestButton.compareDocumentPosition(guestNotice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await userEvent.click(guestButton);
    await waitFor(() => expect(apiClient.createGuest).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    expect(await screen.findByText(/访客使用免费体验模型/)).toBeVisible();
    expect(screen.queryByRole('combobox', { name: '当前模型' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('填入 API Key')).not.toBeInTheDocument();
  });

  it('turns profile personalization off without clearing saved profile data', async () => {
    const disabledProfile: LearnerProfile = { ...learnerProfile, enabled: false };
    vi.mocked(apiClient.updateProfile).mockResolvedValue({ profile: disabledProfile });

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '设置' }));
    const toggle = await screen.findByRole('switch', { name: "按我的情况讲解" });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('学习目标')).not.toBeInTheDocument();
    expect(screen.queryByText('编程经验')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '熟悉语言' })).toHaveValue('C, Go');
    expect(screen.getByRole('textbox', { name: '希望怎么讲' })).toHaveValue('先讲输入输出');

    await userEvent.click(toggle);

    expect(apiClient.updateProfile).toHaveBeenCalledWith({
      enabled: false,
      languages: ['C', 'Go'],
      explanation_preference: '先讲输入输出',
    });
    expect(await screen.findByText(/已暂停使用和自动更新学习信息/))
      .toBeVisible();
  });

  it('offers only a public GitHub repository source when creating a project', async () => {
    vi.mocked(apiClient.listProjects).mockResolvedValue([]);
    vi.mocked(apiClient.createProject).mockResolvedValue(
      detail(project({
        title: 'Hello-World',
        source: {
          kind: 'github',
          value: 'https://github.com/octocat/Hello-World',
          commit_sha: null,
          display_name: 'Hello-World',
        },
      }), job('queued'), false),
    );
    render(<App />);
    await userEvent.click((await screen.findAllByRole('button', { name: '新建项目' }))[0]);
    expect(screen.queryByText('本地来源')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('选择样本')).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByPlaceholderText('https://github.com/owner/repo'),
      'https://github.com/octocat/Hello-World',
    );
    await userEvent.click(screen.getByRole('button', { name: '开始分析' }));

    await waitFor(() => expect(apiClient.createProject).toHaveBeenCalledWith({
      kind: 'github',
      value: 'https://github.com/octocat/Hello-World',
      title: '',
      display_language: 'zh-CN',
    }));
  });
});
