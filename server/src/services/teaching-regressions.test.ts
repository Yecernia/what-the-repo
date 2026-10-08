import { assessmentTestReviewContext } from '../agent/assessment-test-context.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessage, createProject, type Project } from '../domain/conversation.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import type { ServerConfig } from '../config.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import { createLearningActionProposal, applyCompletedLearningRoute } from '../agent/learning-actions.js';
import type { PiAgentRunOptions, PiRunFinalization, PiRunResult } from '../agent/types.js';
import { runUnderstandingAssessment, type generateLearningRoute } from '../agent/teaching-workers.js';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { ConversationService, type ConversationResult } from './conversation-service.js';
import { RepositoryService } from './repository-service.js';
import type { TeachingTurnPart } from '../agent/conversation-reply.js';
import type { reviewReplyContent } from '../agent/reply-content-review.js';
import { reviewAnswerEvidence, unavailableEvidenceReview } from '../agent/citation-review.js';
import { createWorkerDiagnostics } from '../agent/worker-diagnostics.js';
import type { TeachingTargetResult, TeachingQuestionResult } from '../agent/teaching-question.js';
import { normalizeTargetCoverage, assessmentFeedbackScope, priorTargetCoverageForAssessment } from '../agent/target-coverage.js';

const realRuntimeRun = PiConversationRuntime.prototype.run;
const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const snapshot: EvidenceSnapshot = {
  snapshot_id: 'snapshot:regression', summary: { file_count: 0, symbol_count: 0, call_count: 0, component_count: 0 },
  graph: { semantic_mode: 'provider_supported', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
  languages: [], value_points: [], learning_plan: { snapshot_id: 'snapshot:regression', selected_value_point: null, steps: [] },
};
const steps = [1, 2, 3].map(i => ({ step_id: `step:${i}`, order: i, title: `Step ${i}`, objective: 'Explain input',
  component_ids: [], evidence_refs: [], completion_check: 'What is the input?' }));
const routeResult = (): Awaited<ReturnType<typeof generateLearningRoute>> => ({ completed: true, steps,
  trace: { worker_run_id: 'route:mock', skill_id: 'learning-route', skill_version: 'test', stop_reason: 'completed',
    completed: true, usage, evidence_ids: [], state_candidate: true } });

async function fixture(t: TestContext, generateRoute: typeof generateLearningRoute = async () => routeResult(), assess?: typeof runUnderstandingAssessment,
  reviewEvidence?: typeof reviewAnswerEvidence, replyReview?: typeof reviewReplyContent) {
  const root = await mkdtemp(join(tmpdir(), 'wtr-teaching-regression-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new FileStore(root); await store.init();
  const project = createProject('guest:teaching', 'https://github.com/example/teaching', 'Teaching', 'free:deepseek-chat');
  project.analysis.snapshot_id = snapshot.snapshot_id; project.analysis.stage = 'done';
  project.study = { ...project.study, snapshot_id: snapshot.snapshot_id, phase: 'explaining', current_step: 0,
    total_steps: 3, route_revision: 0, dynamic_learning_plan: structuredClone(steps) };
  await store.saveProject(project); await store.saveSnapshot(project.project_id, snapshot);
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => {});
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => {});
  const config = { root, dataDir: root, nodeEnv: 'test', sessionSecret: 'test-only',
    keyEncryptionSecret: 'test-only', freeProviderBaseUrl: 'https://api.deepseek.com',
    freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used' } as ServerConfig;
  const service = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')),
    new PiMemoryStore(join(root, 'memory')), undefined, undefined, undefined, undefined, { generateRoute,
      reviewEvidence: reviewEvidence ?? (async input => ({ ...unavailableEvidenceReview(), completed: true, summary: '回答没有可复查的仓库证据。',
        issues: [{ claim: input.text, reason: '回答没有可复查的仓库证据。', kind: 'insufficient_evidence' }] })),
      assess, reviewReplyContent: replyReview ?? (async () => ({ completed: true, findings: [], trace: { ...routeResult().trace, skill_id: 'reply-content-review', state_candidate: false } })),
    });
  const secondService = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')),
    new PiMemoryStore(join(root, 'memory')), undefined, undefined, undefined, undefined, { generateRoute });
  const base = { owner: { owner_id: project.owner_id, kind: 'guest' as const }, projectId: project.project_id };
  const load = async () => (await store.loadProject(project.project_id, project.owner_id))!;
  return { root, store, project, service, secondService, base, load, config };
}

function mockTurn(t: TestContext, propose: boolean, text = '收到。') {
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    await options.beforePrompt?.(options.signal);
    await interpret(options, 'control');
    let hasAction = false;
    if (propose) {
      try { await proposeSkip(options); hasAction = true; }
      catch (error) { assert.equal((error as { code?: string }).code, 'tool_request_rejected'); }
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply',
          { kind: hasAction ? 'action' : 'answer', text: hasAction ? '' : text });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'reply_evidence_repair_required' || attempt >= 2) throw error;
      }
    }
    return (await finalize({ runId: options.runId!, text, stopReason: 'completed', usage, events: [] })).value;
  });
}

test('UJ-01 receipt-only route proposals survive broad exploration and remain pending until confirmation', async t => {
  for (const reviewEvidence of [false, true]) await t.test(String(reviewEvidence), async t => {
    const f = await fixture(t, undefined, undefined, async () => { assert.fail('no prose to review'); });
    const bound = structuredClone(snapshot);
    bound.graph.layers.push({ id: 'layer:entry', name: 'Entry', responsibility: 'Input', component_ids: [], certainty: 'verified', evidence: [
      { stable_id: 'source:all', label: 'source', path: 'src/entry.ts', start_line: 1, end_line: 29, kind: 'symbol' },
    ] });
    await f.store.saveSnapshot(f.project.project_id, bound);
    f.project.study.dynamic_learning_plan![0]!.evidence_refs = ['source:all'];
    normalizeTargetCoverage(f.project);
    f.project.study.teaching_question = null;
    await f.store.saveProject(f.project);
    t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
    t.mock.method(f.store, 'readSourceLines', async (_p: string, _s: string, path: string, start: number, end: number) => ({ path, start_line: start, end_line: end, total_lines: 29, lines: Array.from({ length: end - start + 1 }, () => 'source'), truncated: false }));
    const before = structuredClone((await f.load()).study);
    scriptedTurn(t, async runtime => {
      await interpret(runtime, 'control');
      await runtime.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
      for (let i = 1; i <= 14; i++) await runtime.tools.find(tool => tool.name === 'read_source_excerpt')!.execute(`read:${i}`, { path: 'src/entry.ts', offset: i, limit: 1 });
      await runtime.tools.find(tool => tool.name === 'propose_learning_action')!.execute('route', { action: 'start_learning_route', target_kind: 'repository' });
      await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '' });
    }, '', 'completed', false);
    const result = (await f.service.run({ ...f.base, content: '请生成学习路线。', reviewEvidence }))!;
    assert.equal(result.assistant_message.learning_action?.status, 'pending');
    assert.equal(result.assistant_message.learning_action.execution_policy, 'confirm');
    assert.deepEqual(result.validation_errors, []);
    assert.deepEqual(result.assistant_message.content_parts?.evidence_blocks, []);
    assert.deepEqual((await f.load()).study, before);
    assert.equal(result.state_changed, false);
  });
});

test('UJ-02 rejected receipt-only actions explain the failed operation in the conversation language', async t => {
  for (const failure of ['budget_exhausted', 'unavailable']) for (const language of ['zh-CN', 'en']) for (const reviewEvidence of [false, true]) await t.test(`${failure}:${language}:${reviewEvidence}`, async t => {
    const f = await fixture(t);
    await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.display_language = language; normalizeTargetCoverage(row); row.study.teaching_question = null; });
    const before = structuredClone((await f.load()).study);
    scriptedTurn(t, async runtime => {
      await interpret(runtime, 'control');
      await runtime.tools.find(tool => tool.name === 'propose_learning_action')!.execute('route', { action: 'start_learning_route', target_kind: 'repository' });
      await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: failure === 'unavailable' ? 'unavailable' : 'action', text: '' });
    }, '', failure === 'unavailable' ? 'completed' : failure, false);
    const result = (await f.service.run({ ...f.base, content: '```js\nroute()\n```', reviewEvidence }))!;
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal(result.assistant_message.content_parts?.action_receipt, null);
    assert.equal(result.state_changed, false);
    assert.deepEqual((await f.load()).study, before);
    const text = result.assistant_message.content;
    if (language === 'en') {
      assert.match(text, /learning route.*not/i);
      assert.match(text, /unchanged.*retry/is);
      assert.doesNotMatch(text, /[\u3400-\u9fff]/u);
    } else {
      assert.match(text, /学习路线.*未/);
      assert.match(text, /没有改变.*重试/s);
    }
    assert.doesNotMatch(text, /Some claims|部分说明尚未通过证据核对/);
    assert.equal((await f.load()).messages.at(-1)?.content, text);
  });
});

async function proposeSkip(options: PiAgentRunOptions) {
  return options.tools.find(tool => tool.name === 'propose_learning_action')!.execute('skip',
    { action: 'advance_learning_step', advance_mode: 'skip' });
}
async function confirmSkip(f: Awaited<ReturnType<typeof fixture>>, turn: ConversationResult) {
  const action = turn.assistant_message.learning_action!;
  assert.equal(action.status, 'pending');
  assert.equal(action.execution_policy, 'confirm');
  assert.equal(action.skip_understanding_check, true);
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'executed');
  const saved = await f.load();
  turn.assistant_message = saved.messages.find(message => message.message_id === turn.assistant_message.message_id)!;
  turn.user_message = saved.messages.find(message => message.message_id === turn.user_message.message_id)!;
  return result;
}

test('TA16 controlled model choices cannot advance without confirmation; intent semantics require real model acceptance', async t => {
  // The fixture supplies the model decision; this does not test Chinese/English intent understanding.
  for (const content of ['不要进入下一步，我还没懂。', '你刚才说“直接进入下一步”是什么意思？', '如果我跳过理解检查会怎样？', 'Do not go to the next step.']) {
    for (const proposes of [false, true]) await t.test(content + ':' + proposes, async t => {
      const f = await fixture(t); mockTurn(t, proposes);
      const result = (await f.service.run({ ...f.base, content }))!;
      assert.equal((await f.load()).study.current_step, 0);
      assert.deepEqual((await f.load()).study.skipped_steps, []);
      assert.equal(result.user_message.learning_action_result, undefined);
      assert.equal(result.assistant_message.learning_action?.status ?? null, proposes ? 'pending' : null);
      if (proposes) assert.equal(result.assistant_message.learning_action!.execution_policy, 'confirm');
    });
  }
});

function scriptedTurn(t: TestContext, body: (options: PiAgentRunOptions) => Promise<void>, text = '模型草稿', stopReason = 'completed', retryUnchangedEvidence = true) {
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    await options.beforePrompt?.(options.signal);
    if (retryUnchangedEvidence) {
      const submit = options.tools.find(tool => tool.name === 'submit_conversation_reply')!;
      const execute = submit.execute.bind(submit);
      submit.execute = async (...args) => {
        for (let attempt = 0; ; attempt++) {
          try { return await execute(...args); }
          catch (error) {
            if ((error as { code?: string }).code !== 'reply_evidence_repair_required' || attempt >= 2) throw error;
          }
        }
      };
    }
    await body(options);
    return (await finalize({ runId: options.runId, text, stopReason, usage, events: [] })).value;
  });
}

async function interpret(options: PiAgentRunOptions, parts: TeachingTurnPart[] | TeachingTurnPart['kind'] = 'answer') {
  await options.tools.find(tool => tool.name === 'interpret_teaching_turn')!.execute('interpret', { parts: typeof parts === 'string' ? [{ kind: parts, text: options.userMessage }] : parts });
}

const toolPayload = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);
function fixtureQuestionResult(input: Parameters<typeof runUnderstandingAssessment>[0]): TeachingQuestionResult {
  return { complete: true, requirements: [{ prompt_span: input.question.prompt, target_ids: input.question.target_ids!,
    outcome: 'satisfied', answer_spans: [input.answerParts?.[0] ?? input.answer], prior_answer_message_ids: [],
    evidence_ids: input.question.evidence.map(row => row.stable_id), reason: 'Controlled answer satisfies this fixture prompt.' }] };
}
function fixtureFeedbackScope(input: Parameters<typeof runUnderstandingAssessment>[0], results: TeachingTargetResult[], questionResult?: TeachingQuestionResult) {
  const step = input.project.study.dynamic_learning_plan!.find(row => row.step_id === input.question.step_id)!;
  return assessmentFeedbackScope(priorTargetCoverageForAssessment(input.project, input.question, step, input.sourceMessageId), input.question, results, questionResult);
}
const mastered: typeof runUnderstandingAssessment = async input => { const result: Omit<Awaited<ReturnType<typeof runUnderstandingAssessment>>, 'reviewContext'> = { completed: true, feedbackScope: fixtureFeedbackScope(input,
  input.question.target_ids!.map(target_id => ({ target_id, outcome: 'proven', reason: 'Controlled fixture answer proves its registered target.',
    answer_spans: [input.answerParts?.[0] ?? input.answer], evidence_ids: input.question.evidence.map(row => row.stable_id) })), fixtureQuestionResult(input)),
  questionResult: fixtureQuestionResult(input), feedback: '回答正确：input 是输入参数。',
  verdict: 'mastered', masteredItems: ['input'], misconceptions: [], acceptedEvidenceIds: ['evidence:input'],
  targetResults: input.question.target_ids!.map(target_id => ({ target_id, outcome: 'proven', reason: 'Controlled fixture answer proves its registered target.',
    answer_spans: [input.answerParts?.[0] ?? input.answer], evidence_ids: input.question.evidence.map(row => row.stable_id) })),
  trace: { worker_run_id: 'assessment:mock', skill_id: 'understanding-assessment', skill_version: 'test',
    stop_reason: 'completed', completed: true, usage, evidence_ids: ['evidence:input'], state_candidate: true } }; return { ...result, reviewContext: assessmentTestReviewContext(input, result) }; };

test('lossless teaching interpretation handles the rereview request and compound-answer cases', async t => {
  const cases: TeachingTurnPart[][] = [
    [{ kind: 'replace', text: '我不会这道题，能不能换成选择题？' }],
    [{ kind: 'explain', text: '给个提示' }],
    [{ kind: 'answer', text: '这道题我选 B，' }, { kind: 'replace', text: '请再出一道题，确认一下我是否真的理解了。' }],
    [{ kind: 'answer', text: '我的答案是 input，' }, { kind: 'replace', text: '请换一题' }],
    [{ kind: 'answer', text: '这道题我的答案是 input，' }, { kind: 'replace', text: '请再出一道题' }],
    [{ kind: 'answer', text: 'My answer is input. ' }, { kind: 'replace', text: 'Please ask another question.' }],
  ];
  for (const parts of cases) await t.test(parts.map(part => part.text).join(''), async t => {
    const calls: Parameters<typeof runUnderstandingAssessment>[0][] = [];
    const f = await fixture(t, undefined, async input => { calls.push(input); return mastered(input); });
    const original = await prepareLesson(t, f);
    await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
      row.study.dynamic_learning_plan![0]!.learning_targets = [steps[0]!.completion_check];
    });
    const hasAnswer = parts.some(part => part.kind === 'answer');
    const replace = parts.some(part => part.kind === 'replace');
    scriptedTurn(t, async options => {
      const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
      await assert.rejects(tool('interpret_teaching_turn').execute('omitted-answer', { parts: [{ kind: 'replace', text: '换题' }] }), /entire original/);
      await interpret(options, parts);
      await tool('get_learning_context').execute('context', {});
      if (hasAnswer) {
        await assert.rejects(tool('submit_conversation_reply').execute('ungraded', { kind: 'answer', text: '继续' }), /Assess the answer/);
        await assert.rejects(tool('register_teaching_question').execute('too-early', { prompt: 'Next?', target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] }), /Assess the original/);
        await tool('assess_understanding').execute('grade', { question_id: original.assistant_message.teaching_question!.question_id });
      } else {
        await assert.rejects(tool('assess_understanding').execute('not-answer', { question_id: original.assistant_message.teaching_question!.question_id }), /not a learner answer/);
      }
      await tool('submit_conversation_reply').execute('reply', replace
        ? { kind: 'lesson', text: '先看参数。', question: { prompt: '输入来自哪里？ A. 参数 B. 全局变量', target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] } }
        : { kind: 'answer', text: '提示：观察函数形参。' });
    });
    const content = parts.map(part => part.text).join('');
    const result = (await f.service.run({ ...f.base, content }))!;
    const saved = await f.load();
    assert.equal(calls.length, hasAnswer ? 1 : 0);
    if (hasAnswer) {
      assert.equal(calls[0]!.answer, parts.filter(part => part.kind === 'answer').map(part => part.text).join('\n'));
      assert.equal(calls[0]!.originalMessage, content);
      assert.equal(calls[0]!.question.question_id, original.assistant_message.teaching_question!.question_id);
      assert.match(result.assistant_message.content, /回答正确/);
    }
    const old = saved.messages.find(message => message.message_id === original.assistant_message.message_id)!.teaching_question!;
    assert.deepEqual(old.answer_attempts?.map(attempt => attempt.answer_parts) ?? [], hasAnswer ? [parts.filter(part => part.kind === 'answer').map(part => part.text)] : []);
    assert.equal(old.assessment_sequence, hasAnswer ? 1 : 0);
    assert.equal(saved.study.current_step, 0);
    assert.equal(saved.study.teaching_question!.question_id === old.question_id, !replace);
    if (replace) assert.equal(result.assistant_message.content.split('输入来自哪里？').length, 2);
  });
});

test('free-chat example requests need neither interpretation nor a formal lesson', async t => {
  const f = await fixture(t, undefined, async () => { assert.fail('ordinary chat cannot grade'); });
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.dynamic_learning_plan = []; row.study.phase = 'orienting'; row.study.total_steps = 0;
  });
  scriptedTurn(t, async options => {
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'answer', text: 'on 像订阅通知，emit 像发送通知。' });
  });
  const result = (await f.service.run({ ...f.base, content: '换个例子讲讲这个问题。' }))!;
  assert.equal(result.assistant_message.error, null);
  assert.match(result.assistant_message.content, /订阅通知/);
  assert.equal((await f.load()).study.teaching_question ?? null, null);
});

test('an assessor rejecting a mislabeled request cannot add proof or be resampled, and allows its actual request', async t => {
  const f = await fixture(t, undefined, async input => ({ ...await mastered(input), answerRelevant: false, verdict: 'unclear' }));
  const original = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    await interpret(options);
    await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('wrong-intent', {
      question_id: original.assistant_message.teaching_question!.question_id,
    }), /No assessment or progress was saved/);
    await assert.rejects(interpret(options, 'explain'), /cannot change/);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'answer', text: '先看函数参数。' });
  });
  await f.service.run({ ...f.base, content: '给个提示' });
  const saved = await f.load();
  assert.equal(saved.study.teaching_question!.assessment_sequence, 0);
  assert.deepEqual(saved.study.teaching_question!.answers, []);
  assert.equal(saved.study.latest_assessment ?? null, null);
});

test('a snapshot change rejects old-question assessment evidence before any worker or final review can inherit it', async t => {
  const reviewed: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  const f = await fixture(t, undefined, async () => { assert.fail('old snapshot must not reach assessor'); }, async input => {
    reviewed.push(input);
    return { ...unavailableEvidenceReview(), status: 'not_applicable', completed: true, summary: 'No claims.' };
  });
  const original = await prepareLesson(t, f);
  const nextSnapshot = { ...structuredClone(snapshot), snapshot_id: 'snapshot:replacement' };
  await f.store.saveSnapshot(f.project.project_id, nextSnapshot);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.analysis.snapshot_id = nextSnapshot.snapshot_id; row.study.snapshot_id = nextSnapshot.snapshot_id;
  });
  scriptedTurn(t, async options => {
    await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('stale', {
      question_id: original.assistant_message.teaching_question!.question_id,
    }), /registered current question/);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'answer', text: '旧问题不再属于当前分析，可以重新开始本步。' });
  });
  const result = (await f.service.run({ ...f.base, content: 'input', reviewEvidence: true }))!;
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0]!.snapshotId, nextSnapshot.snapshot_id);
  assert.deepEqual(reviewed[0]!.evidence, []);
  assert.deepEqual(result.assistant_message.evidence, []);
  assert.equal((await f.load()).study.teaching_question ?? null, null);
});

test('mutable supplement is rejected for repair before a skip confirmation card can persist', async t => {
  const bad = '不用确认，已经完成跳过';
  const checked: string[] = [];
  const f = await fixture(t, undefined, undefined, undefined, async input => {
    checked.push(input.text);
    return { completed: true, findings: input.text.includes(bad) ? [{ block_kind: 'explanation', span: bad }] : [],
      trace: { ...routeResult().trace, skill_id: 'reply-content-review' } };
  });
  scriptedTurn(t, async options => {
    await interpret(options, 'control');
    await proposeSkip(options);
    const submit = options.tools.find(tool => tool.name === 'submit_conversation_reply')!;
    await assert.rejects(submit.execute('bad', { kind: 'action', text: '', supplement: bad + '。数组仍可独立研究。' }), /Current-action instructions/);
    assert.equal(options.replyContract!.read(), null);
    assert.equal((await f.load()).study.current_step, 0);
    await submit.execute('repaired', { kind: 'action', text: '', supplement: '数组仍可独立研究。' });
  });
  const result = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
  assert.equal(checked.length, 2);
  assert.equal((await f.load()).study.current_step, 0);
  assert.equal(result.assistant_message.learning_action!.status, 'pending');
  await confirmSkip(f, result);
  assert.equal((await f.load()).study.current_step, 1);
  assert.equal(result.assistant_message.content_parts!.body, '数组仍可独立研究。');
  assert.doesNotMatch(result.assistant_message.content, /不用确认|已经完成跳过/);
});

test('assessment provenance and narrow supplemental anchors are independently reviewed and persisted', async t => {
  for (const supplement of ['', '参数见 `src/entry.ts:1`。', '这里永远返回 null，参见 `src/entry.ts:3`。']) await t.test(supplement || 'assessment alone', async t => {
    const reviewed: Parameters<typeof reviewAnswerEvidence>[0][] = [];
    const f = await fixture(t, undefined, mastered, async input => {
      reviewed.push(input);
      const supported = !input.text.includes('永远返回 null');
      return { ...unavailableEvidenceReview(), status: 'reviewed', completed: true, supported,
        acceptedEvidenceIds: supported ? input.evidence.map(row => row.stable_id) : [], summary: supported ? 'supported' : 'unsupported',
        issues: supported ? [] : [{ claim: input.text, reason: 'return input contradicts null', kind: 'contradicted' }] };
    });
    const original = await prepareLesson(t, f);
    t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
    scriptedTurn(t, async options => {
      await interpret(options, supplement ? [{ kind: 'answer', text: 'input 是参数。' }, { kind: 'other', text: '另外请解释实现。' }] : 'answer');
      await options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: original.assistant_message.teaching_question!.question_id });
      await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'assessment', text: '', supplement });
    });
    const result = (await f.service.run({ ...f.base, content: supplement ? 'input 是参数。另外请解释实现。' : 'input 是参数。', reviewEvidence: true }))!;
    assert.equal(reviewed.length, supplement ? 2 : 1);
    const assessmentReview = reviewed.find(row => row.purpose === 'assessment')!;
    const supplementReview = reviewed.find(row => row.purpose === 'answer');
    assert.equal(assessmentReview.text, '回答正确：input 是输入参数。');
    assert.match(result.assistant_message.content, /本题已回答完整/);
    assert.deepEqual(assessmentReview.evidence.map(row => [row.start_line, row.end_line, row.snapshot_id]), [[1, 3, snapshot.snapshot_id]]);
    if (supplement) assert.deepEqual(supplementReview!.evidence.map(row => [row.start_line, row.end_line]), [[supplement.includes('null') ? 3 : 1, supplement.includes('null') ? 3 : 1]]);
    assert.ok(result.assistant_message.evidence.some(row => row.start_line === 1 && row.end_line === 3));
    for (const row of result.assistant_message.evidence) assert.ok(reviewed.some(block => block.evidence.some(packet =>
      packet.stable_id === row.stable_id && packet.start_line === row.start_line && packet.end_line === row.end_line)), 'saved evidence must match an actual reviewed packet ID and range');
    if (supplement.includes('null')) {
      assert.equal(result.assistant_message.evidence_review!.supported, false);
      assert.equal(result.assistant_message.evidence.length, 1, 'unsupported supplement cannot clear valid feedback evidence or inherit it');
    }
    const persisted = (await f.load()).messages.at(-1)!;
    assert.deepEqual(persisted.content_parts!.evidence_blocks, result.assistant_message.content_parts!.evidence_blocks);
    assert.deepEqual(persisted.content_parts!.evidence_blocks![0]!.evidence, assessmentReview.evidence);
  });
});

test('unshown and citation-rejected candidates never replace a displayed question or reach the assessor', async t => {
  let grades = 0;
  const f = await fixture(t, undefined, async input => { grades++; return mastered(input); });
  const original = await prepareLesson(t, f);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.dynamic_learning_plan![0]!.learning_targets = [steps[0]!.completion_check];
    row.study.teaching_question = null;
    row.messages = [];
  });
  for (const invalidCitation of [false, true]) {
    let candidate = '';
    scriptedTurn(t, async options => {
      const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
      await tool('get_learning_context').execute('context', {});
      const question = { prompt: invalidCitation ? 'Explain `missing.ts:99`.' : 'What is the input?',
        target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] };
      candidate = toolPayload(await tool('register_teaching_question').execute('candidate', question)).question.question_id;
      if (invalidCitation) await assert.rejects(tool('submit_conversation_reply').execute('rejected', {
        kind: 'lesson', text: '解释', question_id: candidate,
      }), /unverified file references/);
      await tool('submit_conversation_reply').execute('fallback', { kind: 'answer', text: '先解释输入参数。' });
    });
    const answer = (await f.service.run({ ...f.base, content: '讲讲输入参数' }))!;
    assert.equal(answer.assistant_message.teaching_question, undefined);
    assert.equal((await f.load()).study.teaching_question ?? null, null);
    scriptedTurn(t, async options => {
      await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('hidden', { question_id: candidate }), /registered current question/);
      await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('answer', { kind: 'answer', text: '这轮没有可评分的已展示问题。' });
    });
    await f.service.run({ ...f.base, content: 'input' });
  }
  assert.equal(grades, 0);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.messages.push(original.user_message, original.assistant_message);
    row.study.teaching_question = original.assistant_message.teaching_question;
  });
  scriptedTurn(t, async options => {
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    await interpret(options, 'replace');
    await options.tools.find(tool => tool.name === 'register_teaching_question')!.execute('candidate', {
      prompt: 'Replacement?', target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'],
    });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('unavailable', { kind: 'unavailable', text: '' });
  });
  await f.service.run({ ...f.base, content: '请换一个选择题' });
  assert.equal((await f.load()).study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
});

test('replacement and hints do not grade; replacement atomically displays the new question once', async t => {
  const f = await fixture(t, undefined, async () => { assert.fail('teaching requests must not grade'); });
  const original = await prepareLesson(t, f);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.dynamic_learning_plan![0]!.learning_targets = [steps[0]!.completion_check];
  });
  for (const content of ['给个提示', '请换个例子']) {
    scriptedTurn(t, async options => {
      await interpret(options, 'explain');
      await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: original.assistant_message.teaching_question!.question_id }), /not a learner answer/);
      await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('hint', { kind: 'answer', text: '从函数参数开始观察。' });
    });
    await f.service.run({ ...f.base, content });
    assert.equal((await f.load()).study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
  }
  scriptedTurn(t, async options => {
    const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
    await tool('get_learning_context').execute('context', {});
    await interpret(options, 'replace');
    await assert.rejects(tool('assess_understanding').execute('grade', { question_id: original.assistant_message.teaching_question!.question_id }), /not a learner answer/);
    const question = { prompt: '输入来自哪里？\n\nA. 参数\nB. 全局变量', target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] };
    await assert.rejects(tool('submit_conversation_reply').execute('echo', { kind: 'lesson', text: '**输入来自哪里？**\n\nA. 参数\nB. 全局变量', question }), /repeats/);
    await tool('submit_conversation_reply').execute('lesson', { kind: 'lesson', text: '我们把问题拆小，先看数据来自哪里。', question });
  });
  const result = (await f.service.run({ ...f.base, content: '刚才的问题太抽象，请换一个选择题，不要评价这句话的对错。' }))!;
  const saved = await f.load();
  assert.notEqual(saved.study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
  assert.equal(result.assistant_message.content.split('输入来自哪里？').length, 2);
  assert.deepEqual(saved.messages.find(message => message.message_id === original.assistant_message.message_id)!.teaching_question, original.assistant_message.teaching_question);
  assert.equal(saved.study.latest_assessment ?? null, null);
  assert.equal(saved.study.current_step, 0);
});

test('assessment and independent explanation survive confirmation, decline, expiry and replay', async t => {
  for (const decision of ['confirm', 'decline', 'expire'] as const) await t.test(decision, async t => {
    const f = await fixture(t, undefined, mastered, async () => ({ ...unavailableEvidenceReview(), completed: true,
      status: 'reviewed', supported: true, acceptedEvidenceIds: ['evidence:input'], summary: 'supported' }));
    const original = await prepareLesson(t, f);
    scriptedTurn(t, async options => {
      const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
      await interpret(options);
    await tool('assess_understanding').execute('grade', { question_id: original.assistant_message.teaching_question!.question_id });
      await tool('propose_learning_action').execute('advance', { action: 'advance_learning_step', advance_mode: 'complete' });
      await assert.rejects(tool('submit_conversation_reply').execute('wrong-slot', { kind: 'action', text: '模型替代评分' }), /Leave text empty/);
      await tool('submit_conversation_reply').execute('reply', { kind: 'action', text: '', supplement: '追问：重新赋值对象属性不会重绑定闭包变量。' });
    });
    const result = (await f.service.run({ ...f.base, content: 'input 是输入参数。另外，修改属性会改写闭包变量吗？', reviewEvidence: true }))!;
    const before = result.assistant_message;
    assert.match(before.content_parts!.body, /回答正确.*input/s);
    assert.match(before.content_parts!.body, /追问：重新赋值/);
    if (decision === 'expire') await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.route_revision = 1; });
    const resolved = await f.service.resolveLearningAction({ ...f.base, actionId: before.learning_action!.action_id, decision: decision === 'decline' ? 'decline' : 'confirm' });
    const saved = (await f.load()).messages.find(message => message.message_id === before.message_id)!;
    assert.equal(saved.content_parts!.body, before.content_parts!.body);
    assert.deepEqual(saved.evidence_review, before.evidence_review);
    assert.deepEqual(saved.content_parts!.evidence_blocks, before.content_parts!.evidence_blocks);
    assert.equal(resolved.action.status, decision === 'expire' ? 'expired' : decision === 'decline' ? 'declined' : 'executed');
    assert.doesNotMatch(saved.content_parts!.action_receipt!, /确认后/);
    if (decision === 'confirm') {
      mockTurn(t, false, '新的普通草稿');
      const replay = (await f.service.run({ ...f.base, content: result.user_message.content, replaceMessageId: result.user_message.message_id }))!;
      assert.equal(replay.assistant_message.content_parts!.body, before.content_parts!.body);
      assert.deepEqual(replay.assistant_message.content_parts!.evidence_blocks, before.content_parts!.evidence_blocks);
      assert.deepEqual(replay.assistant_message.evidence_review, before.evidence_review);
      assert.equal((await f.load()).study.current_step, 1);
    }
  });
});

test('a valid assessment keeps the follow-up and respects a request to stay on the step', async t => {
  const f = await fixture(t, undefined, mastered);
  const lesson = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    await interpret(options);
    await options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
    // Controlled model honors stay intent by not proposing; semantic interpretation is tested with real LLM separately.
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'assessment', text: '', supplement: '闭包引用的变量没有被重新绑定。' });
  });
  const answer = (await f.service.run({ ...f.base, content: 'input 是输入参数。解释一下闭包，不要开始第2步。' }))!;
  assert.match(answer.assistant_message.content, /回答正确.*闭包引用/s);
  assert.equal(answer.assistant_message.learning_action ?? null, null);
  assert.equal((await f.load()).study.current_step, 0);
});

test('failed lesson persistence leaves the original displayed question intact', async t => {
  const f = await fixture(t);
  const original = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    await interpret(options, 'replace');
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('lesson', {
      kind: 'lesson', text: '换一种讲法。', question: { prompt: steps[0]!.completion_check,
        target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] },
    });
  });
  const originalUpdate = f.store.updateProject.bind(f.store);
  let calls = 0;
  t.mock.method(f.store, 'updateProject', async (...args: Parameters<typeof originalUpdate>) => {
    if (++calls === 2) throw new Error('lesson persistence failed');
    return originalUpdate(...args);
  });
  await assert.rejects(f.service.run({ ...f.base, content: '请重新讲解当前步骤并换一道题。' }), /lesson persistence failed/);
  const saved = await f.load();
  assert.equal(saved.study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
  assert.equal(saved.messages.filter(message => message.teaching_question).length, 1);
});

test('an answer followed by a new question request grades the old question and retains its answers', async t => {
  const graded: string[] = [];
  const f = await fixture(t, undefined, async input => { graded.push(input.question.question_id); return mastered(input); });
  const original = await prepareLesson(t, f);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.dynamic_learning_plan![0]!.learning_targets = [steps[0]!.completion_check];
  });
  scriptedTurn(t, async options => {
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    await interpret(options);
    await options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: original.assistant_message.teaching_question!.question_id });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('lesson', {
      kind: 'lesson', text: '再从另一个角度看输入。', question: { prompt: '参数是 input 还是 output？',
        target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] },
    });
  });
  const content = 'input 是输入参数，请再出一道题。';
  const result = (await f.service.run({ ...f.base, content }))!;
  assert.deepEqual(graded, [original.assistant_message.teaching_question!.question_id]);
  assert.match(result.assistant_message.content, /回答正确.*再从另一个.*参数是/s);
  const saved = await f.load();
  assert.deepEqual(saved.messages.find(message => message.message_id === original.assistant_message.message_id)!.teaching_question!.answer_attempts!.map(attempt => attempt.answer_parts), [[content]]);
  assert.deepEqual(saved.study.teaching_question!.answers, []);
});

test('failed route generation and its retry only update the receipt', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => {
    if (++attempts === 1) throw new Error('provider unavailable');
    return routeResult();
  });
  const action = createLearningActionProposal(f.project, snapshot, { action: 'start_learning_route', targetKind: 'repository', request: 'Teach me' });
  const body = '追问回答：可以先阅读入口，再学习依赖。';
  f.project.messages.push(createMessage('assistant', body + '\n\n' + action.description, {
    learning_action: action, content_parts: { body, action_receipt: action.description },
  }));
  await f.store.saveProject(f.project);
  const failed = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  assert.equal(failed.action.status, 'failed');
  assert.equal(failed.project.messages.at(-1)!.content_parts!.body, body);
  assert.match(failed.project.messages.at(-1)!.content, /可以重试/);
  const retry = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  assert.equal(retry.action.status, 'executed');
  assert.equal(retry.project.messages.at(-1)!.content_parts!.body, body);
  assert.doesNotMatch(retry.project.messages.at(-1)!.content, /可以重试/);
});

test('an explicit model skip proposal awaits confirmation even with a pass already qualified', async t => {
  const f = await fixture(t);
  f.project.study.step_passed = { step_id: 'step:1', snapshot_id: snapshot.snapshot_id, route_revision: 0,
    mastered_items: ['understood'], evidence_ids: [] };
  await f.store.saveProject(f.project);
  scriptedTurn(t, async options => {
    await interpret(options, 'control');
    const payload = toolPayload(await proposeSkip(options));
    assert.equal(payload.confirmation_required, true);
    assert.equal(payload.proposal.skipped_understanding_check, true);
    await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('unrequested-grade', { question_id: 'any' }), /not a learner answer/);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '' });
  });
  const result = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
  assert.equal((await f.load()).study.current_step, 0);
  assert.deepEqual((await f.load()).study.skipped_steps, []);
  assert.equal(result.user_message.learning_action_result, undefined);
  await confirmSkip(f, result);
  const saved = await f.load();
  assert.equal(saved.study.current_step, 1);
  assert.deepEqual(saved.study.skipped_steps, ['step:1']);
  assert.deepEqual(saved.study.mastered, []);
  assert.doesNotMatch(result.assistant_message.content, /确认后/);
  const outcome = result.assistant_message.learning_action!.outcome!;
  assert.match(outcome.lesson_run_id!, /^[a-f0-9-]{36}$/);
  assert.deepEqual(outcome, { route_revision: 1, next_step_id: 'step:2', next_step_title: 'Step 2', lesson_run_id: outcome.lesson_run_id });
  assert.ok(saved.messages[0]!.learning_action_result);
  const duplicate = await f.service.resolveLearningAction({ ...f.base, actionId: result.assistant_message.learning_action!.action_id, decision: 'confirm' });
  assert.equal(duplicate.state_changed, false);
  assert.equal(duplicate.project.study.current_step, 1);
});

test('new confirmed skips are separate actions and the final receipt ends the route', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const result = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
    assert.equal((await f.load()).study.current_step, i);
    ids.push(result.assistant_message.learning_action!.action_id);
    await confirmSkip(f, result);
    assert.equal((await f.load()).study.current_step, i + 1);
    if (i === 2) {
      assert.match(result.assistant_message.content, /路线已结束/);
      assert.doesNotMatch(result.assistant_message.content, /进入下一步/);
      assert.equal(result.assistant_message.learning_action!.outcome?.next_step_id, null);
    }
  }
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual((await f.load()).study.skipped_steps, ['step:1', 'step:2', 'step:3']);
  assert.deepEqual((await f.load()).study.mastered, []);
  assert.equal((await f.load()).study.phase, 'completed');
});

test('cancelled or failed skip turns never publish a success receipt', async t => {
  const f = await fixture(t);
  for (const reason of ['cancelled', 'paused', 'provider_request_failed']) {
    scriptedTurn(t, async options => {
      await interpret(options, 'control');
    await proposeSkip(options);
      await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '' });
    }, '已完成跳过。', reason);
    const result = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
    assert.equal((await f.load()).study.current_step, 0);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.doesNotMatch(result.assistant_message.content, /已完成跳过|已记录为主动跳过/);
    assert.equal(result.user_message.learning_action_result, undefined);
  }
  const controller = new AbortController();
  scriptedTurn(t, async options => {
    await interpret(options, 'control');
    await proposeSkip(options);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '' });
    controller.abort('cancelled');
  });
  const raced = (await f.service.run({ ...f.base, content: '跳过这一步', signal: controller.signal }))!;
  assert.equal(raced.assistant_message.error, 'cancelled');
  assert.equal(raced.assistant_message.learning_action ?? null, null);
  assert.equal((await f.load()).study.current_step, 0);
});

test('confirmed advances update the saved receipt text and scope to the actual next step', async t => {
  const f = await fixture(t, undefined, mastered);
  await prepareLesson(t, f);
  const turn = await gradeTurn(t, f, 'input 是参数。', { card: true });
  const action = turn.assistant_message.learning_action!;
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  const receipt = result.project.messages.at(-1)!;
  assert.equal(result.action.status, 'executed');
  assert.doesNotMatch(receipt.content, /确认后/);
  assert.equal(receipt.teaching_context?.step_id, 'step:2');
  assert.equal(receipt.teaching_context?.route_revision, 1);
});

test('failed persistence cannot expose or save a promised action card', async t => {
  const f = await fixture(t);
  scriptedTurn(t, async options => {
    await interpret(options, 'control');
    await options.tools.find(tool => tool.name === 'propose_learning_action')!.execute('route', {
      action: 'start_learning_route', target_kind: 'repository',
    });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '' });
  });
  const originalUpdate = f.store.updateProject.bind(f.store);
  let writes = 0;
  t.mock.method(f.store, 'updateProject', async (...args: Parameters<typeof originalUpdate>) => {
    if (++writes === 2) throw new Error('persistence unavailable');
    return originalUpdate(...args);
  });
  await assert.rejects(f.service.run({ ...f.base, content: '请制定学习路线' }), /persistence unavailable/);
  const saved = await f.load();
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0]!.role, 'user');
  assert.equal(saved.study.current_step, 0);
  assert.equal(saved.messages.some(message => message.learning_action), false);
});

test('unsubmitted prose cannot display an unregistered check or promise a missing card', async t => {
  const f = await fixture(t);
  for (const [content, text] of [
    ['开始当前步骤', '我的理解检查题：What is the input?'],
    ['请帮我制定学习路线', '我已提供确认卡，确认即可开始。'],
  ]) {
    scriptedTurn(t, async () => {}, text);
    const result = (await f.service.run({ ...f.base, content }))!;
    assert.equal(result.assistant_message.error, 'conversation_reply_invalid');
    assert.match(result.assistant_message.content, /暂未完成|未通过内容检查/);
    assert.doesNotMatch(result.assistant_message.content, /理解检查题|已提供确认卡/);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal((await f.load()).study.teaching_question ?? null, null);
  }
});

async function prepareLesson(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, questionInput?: { prompt: string; targets: string[] }) {
  const evidence = { stable_id: 'evidence:input', label: 'src/entry.ts', path: 'src/entry.ts', start_line: 1, end_line: 3, kind: 'symbol' };
  const bound = structuredClone(snapshot);
  bound.graph.layers.push({ id: 'layer:entry', name: 'Entry', responsibility: 'Input', component_ids: [], certainty: 'verified', evidence: [evidence] });
  await f.store.saveSnapshot(f.project.project_id, bound);
  f.project.study.dynamic_learning_plan![0]!.evidence_refs = [evidence.stable_id];
  await f.store.saveProject(f.project);
  t.mock.method(f.store, 'readSourceLines', async () => ({ lines: ['export function entry(input) {', '  return input;', '}'], truncated: false }));
  scriptedTurn(t, async options => {
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    // Omission of the standalone registration tool is safe: submission registers the exact displayed question.
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', {
      kind: 'lesson', text: '入口接收 input，再返回 input。', question: {
        prompt: questionInput?.prompt ?? steps[0]!.completion_check, target_items: questionInput?.targets ?? [steps[0]!.completion_check], evidence_ids: [evidence.stable_id],
      },
    });
  });
  const lesson = (await f.service.run({ ...f.base, content: '开始当前步骤' }))!;
  assert.ok(lesson.assistant_message.teaching_question);
  assert.ok(lesson.assistant_message.content.includes(questionInput?.prompt ?? steps[0]!.completion_check));
  assert.equal(lesson.assistant_message.teaching_question!.created_message_id, lesson.user_message.message_id);
  assert.equal((await f.load()).study.teaching_question?.question_id, lesson.assistant_message.teaching_question!.question_id);
  return lesson;
}

test('displayed questions restore from provenance and assess the existing answer, including same-ID retries', async t => {
  const answers: string[] = [];
  const faux = fauxProvider({ provider: 'question-recovery-assessment' });
  const models = createModels(); models.setProvider(faux.provider);
  const f = await fixture(t, undefined, async input => {
    answers.push(input.answer);
    const controlled = await mastered(input);
    // Controlled semantic decisions exercise restoration and source binding, not model accuracy.
    faux.setResponses([fauxAssistantMessage(fauxToolCall('submit_result', {
      answer_relevant: true, feedback: '回答正确。', misconceptions: [],
      target_results: controlled.targetResults,
      question_requirements: fixtureQuestionResult(input).requirements,
    })), fauxAssistantMessage(fauxToolCall('submit_result', { targets: controlled.targetResults.map(target => ({
      target_id: target.target_id, supported: true, missing_target_spans: [],
      supporting_answer_refs: [{ message_id: input.sourceMessageId!, answer_span: input.answerParts![0]! }],
      reason: 'The controlled learner answer identifies the function input.',
    })) }))]);
    return runUnderstandingAssessment({ ...input, modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  });
  const lesson = await prepareLesson(t, f);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.teaching_question = null; });
  const questionId = lesson.assistant_message.teaching_question!.question_id;
  scriptedTurn(t, async options => {
    const context = await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    const payload = JSON.parse((context.content[0] as { text: string }).text);
    assert.equal(payload.study.teaching_question.question_id, questionId);
    await interpret(options);
    await assert.rejects(options.tools.find(tool => tool.name === 'register_teaching_question')!.execute('retroactive', {
      prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'],
    }), /previously displayed question/);
    await options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: questionId });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'assessment', text: '' });
  });
  const answer = '输入是函数参数 input。';
  const first = (await f.service.run({ ...f.base, content: answer }))!;
  assert.ok((await f.load()).study.step_passed);
  assert.equal(first.assistant_message.content, '本题已回答完整。\n本步所有学习目标已有有效证明。\n\n回答正确。');
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    // Simulate an older answer-turn registration. Retry must restore the earlier display, not grade its own new question.
    row.study.teaching_question!.created_message_id = first.user_message.message_id;
  });
  await f.service.run({ ...f.base, content: answer, replaceMessageId: first.user_message.message_id });
  assert.deepEqual(answers, [answer, answer]);
  assert.equal((await f.load()).study.teaching_question?.answer_attempts!.length, 1);
  await f.service.run({ ...f.base, content: answer });
  assert.deepEqual(answers, [answer, answer, answer]);
  assert.equal((await f.load()).study.current_step, 0);
});

test('registration errors, cancelled lessons and stale display records cannot become assessable questions', async t => {
  const f = await fixture(t);
  scriptedTurn(t, async options => {
    const submit = options.tools.find(tool => tool.name === 'submit_conversation_reply')!;
    await assert.rejects(submit.execute('invalid-question', { kind: 'lesson', text: '检查题：What is the input?',
      question: { prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['unread'] } }), /Read every/);
    await submit.execute('unfinished', { kind: 'unavailable', text: '请重发答案。' });
  });
  const failed = (await f.service.run({ ...f.base, content: '开始当前步骤' }))!;
  assert.equal((await f.load()).study.teaching_question ?? null, null);
  assert.doesNotMatch(failed.assistant_message.content, /检查题|重发答案/);
  const lesson = await prepareLesson(t, f);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    row.study.route_revision = 1; row.study.teaching_question = null;
  });
  scriptedTurn(t, async options => {
    await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('stale', {
      question_id: lesson.assistant_message.teaching_question!.question_id,
    }), /registered current question/);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('unfinished', { kind: 'unavailable', text: '' });
  });
  await f.service.run({ ...f.base, content: '输入是 input。' });
  assert.equal((await f.load()).study.teaching_question ?? null, null);
  assert.equal((await f.load()).study.step_passed ?? null, null);
});

test('a cancelled question is not displayed or saved, and regenerating its turn still cannot grade itself', async t => {
  const f = await fixture(t);
  const original = await prepareLesson(t, f);
  let cancelledQuestionId = '';
  scriptedTurn(t, async options => {
    await interpret(options, 'replace');
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    const registered = await options.tools.find(tool => tool.name === 'register_teaching_question')!.execute('new', {
      prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'],
    });
    cancelledQuestionId = JSON.parse((registered.content[0] as { text: string }).text).question.question_id;
  }, '未提交的新检查题', 'cancelled');
  const cancelled = (await f.service.run({ ...f.base, content: '请重新讲解当前步骤并换一道题。' }))!;
  assert.equal(cancelled.assistant_message.teaching_question, undefined);
  assert.doesNotMatch(cancelled.assistant_message.content, /新检查题/);
  assert.equal((await f.load()).study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
  scriptedTurn(t, async options => {
    await interpret(options, 'replace');
    await options.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
    const registered = await options.tools.find(tool => tool.name === 'register_teaching_question')!.execute('retry-question', {
      prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'],
    });
    const questionId = JSON.parse((registered.content[0] as { text: string }).text).question.question_id;
    assert.notEqual(questionId, cancelledQuestionId);
    await assert.rejects(options.tools.find(tool => tool.name === 'assess_understanding')!.execute('self-grade', { question_id: questionId }), /not a learner answer/);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('lesson', { kind: 'lesson', text: '入口接收 input。', question_id: questionId });
  });
  const retry = (await f.service.run({ ...f.base, content: cancelled.user_message.content, replaceMessageId: cancelled.user_message.message_id }))!;
  assert.equal(retry.assistant_message.teaching_question!.created_message_id, cancelled.user_message.message_id);
  assert.equal((await f.load()).study.step_passed ?? null, null);
});

test('ordinary encouragement passes through the real review pipeline as not applicable without reading source', async t => {
  const faux = fauxProvider({ provider: 'encouragement-service-review' });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('submit_result', {
    sections: [{ section_id: 0, outcome: 'no_repository_claim', basis: 'Ordinary encouragement.', evidence_ids: [], issues: [] }],
  }))]);
  const f = await fixture(t, undefined, undefined, input => reviewAnswerEvidence({ ...input,
    modelRuntime: { models, model: faux.getModel() as Model<Api> } }));
  t.mock.method(f.store, 'readSourceLines', async () => { assert.fail('encouragement must not retrieve source'); });
  const text = '今天已经认真学了一段，休息一下，明天再来就好。';
  mockTurn(t, false, text);
  const result = (await f.service.run({ ...f.base, content: '只用一句话鼓励我，不谈代码或推进学习。', reviewEvidence: true }))!;
  assert.equal(result.assistant_message.evidence_review?.status, 'not_applicable');
  assert.equal(result.assistant_message.content, text);
  assert.deepEqual(result.validation_errors, []);
  assert.equal((await f.load()).study.current_step, 0);
});

test('text does not manufacture a card; the explicit model proposal binds its original step until confirmation', async t => {
  const f = await fixture(t); mockTurn(t, false);
  const ordinary = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  assert.equal(ordinary.assistant_message.learning_action ?? null, null);
  assert.equal((await f.load()).study.current_step, 0);
  mockTurn(t, true);
  const pending = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
  assert.equal(pending.assistant_message.learning_action!.expected_step_id, 'step:1');
  assert.equal((await f.load()).study.current_step, 0);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.route_revision = 1; });
  const expired = await f.service.resolveLearningAction({ ...f.base, actionId: pending.assistant_message.learning_action!.action_id, decision: 'confirm' });
  assert.equal(expired.action.status, 'expired');
  assert.equal(expired.project.study.current_step, 0);
});

test('retry, network replay and editing an applied message cannot authorize another advance', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  await confirmSkip(f, first);
  assert.equal((await f.load()).study.current_step, 1);
  assert.ok(first.user_message.learning_action_result);
  await f.service.run({ ...f.base, content: '直接进入下一步', replaceMessageId: first.user_message.message_id });
  const current = await f.load();
  await f.service.run({ ...f.base, content: '请直接进入下一步', retryRunId: current.messages[0]!.trace_id! });
  await f.service.run({ ...f.base, content: '直接进入下一步', retryRunId: first.user_message.trace_id! });
  const saved = await f.load();
  assert.equal(saved.study.current_step, 1);
  assert.equal(saved.study.route_revision, 1);
  assert.equal(saved.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(saved.messages.at(-1)!.content_parts!.body, '收到。', 'edited messages receive the new explanation, not a forced replay receipt');
});

test('code review cannot silently skip a repository claim without tools, and details survive in history', async t => {
  const f = await fixture(t); mockTurn(t, false, '这个仓库保证绝对不会生成重复 ID。');
  const result = (await f.service.run({ ...f.base, content: '核对 ID 是否重复', reviewEvidence: true }))!;
  assert.equal(result.assistant_message.context_eligible, false);
  assert.equal(result.assistant_message.evidence_review?.status, 'unverified');
  assert.ok(result.validation_errors.includes('citation_review_unavailable'));
  assert.match(result.assistant_message.content, /没有可复查/);
  assert.match((await f.load()).messages.at(-1)!.content, /绝对不会生成重复 ID/);
});

test('a pending normal advance expires when the later understanding check revoked mastery', async t => {
  const f = await fixture(t);
  f.project.study.step_passed = { step_id: 'step:1', snapshot_id: snapshot.snapshot_id, route_revision: 0,
    mastered_items: ['Input'], evidence_ids: ['evidence:input'] };
  const action = createLearningActionProposal(f.project, snapshot, { action: 'advance_learning_step', request: 'Continue' });
  f.project.messages.push(createMessage('assistant', 'Continue?', { learning_action: action }));
  f.project.study.step_passed = null;
  f.project.study.misconceptions = ['Confused input and output'];
  await f.store.saveProject(f.project);
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: action.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'expired');
  assert.equal(result.state_changed, false);
  assert.equal(result.project.study.current_step, 0);
});

test('selecting a new value point invalidates pending actions even on the same snapshot', async t => {
  const f = await fixture(t);
  const old = createLearningActionProposal(f.project, snapshot, { action: 'stop_guided_learning', request: 'Stop' });
  f.project.messages.push(createMessage('assistant', 'Stop?', { learning_action: old }));
  await f.store.saveProject(f.project);
  const repository = new RepositoryService(f.store);
  t.mock.method(repository, 'boundSnapshot', async () => ({ project: await f.load(),
    snapshot: { ...snapshot, value_points: [{ stable_id: 'value:new' }] } as unknown as EvidenceSnapshot }));
  await repository.getLearningPlan(f.project.owner_id, f.project.project_id, snapshot.snapshot_id, 'value:new');
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: old.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'expired');
  assert.equal(result.project.study.selected_value_point, 'value:new');
  assert.equal(result.project.study.route_revision, 1);
});

async function addRoute(store: FileStore, project: Project) {
  const source = createMessage('user', 'Teach me');
  const card = createLearningActionProposal(project, snapshot, { action: 'start_learning_route', targetKind: 'repository', request: 'Teach me' });
  card.source_message_id = source.message_id;
  project.messages.push(source, createMessage('assistant', 'Confirm goal', { learning_action: card }));
  await store.saveProject(project);
  return card;
}

test('configuration and trace failures leave route cards retryable; duplicate confirmation returns original result', async t => {
  const f = await fixture(t); const card = await addRoute(f.store, f.project);
  const input = { ...f.base, actionId: card.action_id, decision: 'confirm' as const };
  const settings = t.mock.method(f.store, 'loadSettings', async () => { throw new Error('database unavailable'); });
  assert.equal((await f.service.resolveLearningAction(input)).action.status, 'failed');
  settings.mock.restore();
  const trace = t.mock.method(f.store, 'saveTrace', async () => { throw new Error('trace unavailable'); });
  assert.equal((await f.service.resolveLearningAction(input)).action.status, 'failed');
  assert.equal((await f.load()).study.route_revision, 0);
  trace.mock.restore();
  const completed = await f.service.resolveLearningAction(input);
  assert.equal(completed.action.status, 'executed');
  assert.equal(completed.project.study.route_revision, 1);
  assert.ok(completed.project.messages[0]!.learning_action_result);
  assert.equal((await f.service.resolveLearningAction(input)).state_changed, false);
  assert.equal((await f.load()).study.route_revision, 1);
});

test('expired confirmed route can recover and late generation cannot replace a newer route', async t => {
  let replace = false;
  const f = await fixture(t, async () => {
    if (replace) await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
      const newer = createLearningActionProposal(row, snapshot, { action: 'switch_learning_target', targetKind: 'repository', request: 'New goal' });
      applyCompletedLearningRoute(row, newer, [{ ...steps[0]!, step_id: 'new:step' }]);
    });
    return routeResult();
  });
  const card = await addRoute(f.store, f.project);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
    const action = row.messages[1]!.learning_action!; action.status = 'confirmed'; action.run_expires_at = new Date(0).toISOString();
  });
  replace = true;
  const result = await f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' });
  assert.equal(result.action.status, 'failed');
  assert.equal((await f.load()).study.dynamic_learning_plan?.[0]?.step_id, 'new:step');
  assert.equal((await f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' })).action.status, 'expired');
});

test('route generation shares project exclusion with chat and cancellation releases the project', async t => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, async input => {
    entered();
    await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }));
    return routeResult();
  });
  const card = await addRoute(f.store, f.project);
  const running = f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' });
  await started;
  await assert.rejects(f.service.run({ ...f.base, content: 'Another turn' }), { code: 'session_busy' });
  await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'session_busy' });
  await assert.rejects(f.secondService.run({ ...f.base, content: 'Concurrent instance retry' }), { code: 'session_busy' });
  await assert.rejects(f.secondService.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'session_busy' });
  assert.equal(f.service.controlRun({ ...f.base, runId: card.action_id, action: 'cancel' }), true);
  assert.equal((await running).action.status, 'failed');
  assert.equal((await f.load()).study.route_revision, 0);
  mockTurn(t, false);
  assert.ok(await f.service.run({ ...f.base, content: 'Recovered' }));
});

// R2 service regressions use controlled workers but the real tools and persistence.
test('unavailable abandons a pending confirmation proposal after review failure and the original message can recover on retry', async t => {
  let outage = true;
  const f = await fixture(t, undefined, undefined, undefined, async () => ({ completed: !outage, findings: [],
    trace: { ...routeResult().trace, skill_id: 'reply-content-review', completed: !outage } }));
  const baseline = await f.load();
  baseline.study.teaching_question ??= null;
  normalizeTargetCoverage(baseline);
  const originalStudy = structuredClone(baseline.study);
  const content = '跳过这一步，同时解释一下刚才的例子。';
  scriptedTurn(t, async options => {
    await interpret(options, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释一下刚才的例子。' }]);
    await proposeSkip(options);
    const submit = options.tools.find(tool => tool.name === 'submit_conversation_reply')!;
    await submit.execute('with-answer', { kind: 'action', text: '', supplement: '独立解释仍应回答。' });
    assert.match(options.replyContract!.read()!, /尚未完成/);
    await assert.rejects(submit.execute('drop-explanation', { kind: 'action', text: '' }), /already submitted/);
  });
  const result = (await f.service.run({ ...f.base, content }))!;
  const saved = await f.load();
  assert.deepEqual(saved.study, originalStudy);
  assert.equal(result.assistant_message.learning_action ?? null, null);
  assert.equal(result.assistant_message.teaching_question, undefined);
  assert.equal(result.user_message.content, content);
  assert.equal(result.user_message.learning_action_result, undefined);
  assert.match(result.assistant_message.content, /学习操作未执行/);
  outage = false;
  scriptedTurn(t, async options => {
    await interpret(options, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释一下刚才的例子。' }]);
    await proposeSkip(options);
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('retry', { kind: 'action', text: '', supplement: '独立解释已完成。' });
  });
  const recovered = (await f.service.run({ ...f.base, content, replaceMessageId: result.user_message.message_id }))!;
  assert.match(recovered.assistant_message.content_parts!.body, /独立解释已完成/);
  assert.equal((await f.load()).study.current_step, 0);
  await confirmSkip(f, recovered);
  assert.equal((await f.load()).study.current_step, 1);
});

test('confirm proposals and candidate lessons roll back all assessment state on unavailable', async t => {
  for (const mode of ['confirm', 'candidate'] as const) await t.test(mode, async t => {
    const f = await fixture(t, undefined, mastered, undefined, async () => ({ completed: false, findings: [],
      trace: { ...routeResult().trace, skill_id: 'reply-content-review', completed: false } }));
    const lesson = await prepareLesson(t, f);
    const baseline = await f.load();
    scriptedTurn(t, async options => {
      const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
      await interpret(options);
      await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
      if (mode === 'confirm') await tool('propose_learning_action').execute('next', { action: 'advance_learning_step', advance_mode: 'complete' });
      else {
        await tool('get_learning_context').execute('context', {});
        await tool('register_teaching_question').execute('candidate', { prompt: steps[0]!.completion_check,
          target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] });
      }
      await tool('submit_conversation_reply').execute('check', mode === 'confirm'
        ? { kind: 'action', text: '', supplement: '保留独立解释。' }
        : { kind: 'lesson', text: '解释输入参数。' });
      assert.match(options.replyContract!.read()!, /尚未完成/);
    });
    const result = (await f.service.run({ ...f.base, content: 'input 是参数，也请解释例子。' }))!;
    const saved = await f.load();
    assert.deepEqual(saved.study, baseline.study);
    assert.deepEqual(saved.messages.find(message => message.message_id === lesson.assistant_message.message_id)!.teaching_question,
      lesson.assistant_message.teaching_question);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal(result.assistant_message.teaching_question, undefined);
    assert.equal(result.assistant_message.error, null);
  });
});

test('offending assessment prose has one owner repair, preserves its judgment and does not lose the follow-up', async t => {
  for (const repair of ['success', 'changed-judgment', 'still-invalid', 'unavailable'] as const) await t.test(repair, async t => {
    const offending = '请点击确认后进入下一步。';
    let repairCalls = 0;
    const f = await fixture(t, undefined, async input => {
      const result = await mastered(input);
      if (!input.feedbackRepair) return { ...result, feedback: result.feedback + offending };
      repairCalls++;
      assert.equal(input.originalMessage, 'input 是参数，另外请解释。');
      assert.equal(input.feedbackRepair.verdict, 'mastered');
      assert.deepEqual(input.feedbackRepair.offendingSpans, [offending]);
      return { ...result, completed: repair !== 'unavailable', verdict: repair === 'changed-judgment' ? 'partial' : 'mastered',
        feedback: repair === 'still-invalid' ? result.feedback + offending : result.feedback };
    }, undefined, async input => ({ completed: true, findings: input.text.includes(offending) ? [{ block_kind: 'assessment', span: offending }] : [],
      trace: { ...routeResult().trace, skill_id: 'reply-content-review' } }));
    const lesson = await prepareLesson(t, f);
    const baseline = structuredClone((await f.load()).study);
    scriptedTurn(t, async options => {
      const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
      await interpret(options);
      await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
      await tool('propose_learning_action').execute('next', { action: 'advance_learning_step', advance_mode: 'complete' });
      await tool('submit_conversation_reply').execute('reply', { kind: 'action', text: '', supplement: '独立解释：input 来自调用方。' });
    });
    const reply = (await f.service.run({ ...f.base, content: 'input 是参数，另外请解释。' }))!.assistant_message;
    const saved = await f.load();
    assert.equal(repairCalls, 1);
    assert.equal(reply.error, null);
    assert.doesNotMatch(reply.content, /请点击确认后/);
    if (repair === 'success') {
      assert.match(reply.content_parts!.body, /回答正确/);
      assert.match(reply.content_parts!.body, /独立解释/);
      assert.equal(reply.learning_action!.status, 'pending');
      assert.equal(saved.study.latest_assessment!.verdict, 'mastered');
      assert.equal(saved.study.teaching_question!.assessment_sequence, 1);
    } else {
      assert.deepEqual(saved.study, baseline);
      assert.equal(reply.learning_action ?? null, null);
      assert.equal(reply.teaching_question, undefined);
      assert.match(reply.content, /学习操作未执行/);
    }
  });
});

test('reply review receives action and block context and allows the two real check-question introductions', async t => {
  const seen: Parameters<typeof reviewReplyContent>[0][] = [];
  const f = await fixture(t, undefined, mastered, undefined, async input => {
    seen.push(input);
    return { completed: true, findings: [], trace: { ...routeResult().trace, skill_id: 'reply-content-review' } };
  });
  const lesson = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
    await interpret(options, [{ kind: 'answer', text: '这道题我选 C，' }, { kind: 'replace', text: '请再出一道题，确认一下我是否真的理解了。' }]);
    await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
    await tool('get_learning_context').execute('context', {});
    await tool('submit_conversation_reply').execute('reply', { kind: 'lesson', text: '你要的确认题在下面，它换了个角度：\n下面这道题请用自己的话回答，不用复述代码。',
      question: { prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] } });
  });
  const result = (await f.service.run({ ...f.base, content: '这道题我选 C，请再出一道题，确认一下我是否真的理解了。' }))!;
  assert.equal(result.assistant_message.error, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.action, null);
  assert.equal(seen[0]!.replyKind, 'lesson');
  assert.equal(seen[0]!.questionContext, 'new_question');
  assert.deepEqual(seen[0]!.blocks!.map(block => block.kind), ['assessment', 'explanation']);
  assert.match(result.assistant_message.content, /你要的确认题在下面/);
});

test('executed skip and normal advance replay without provider configuration, workers or runtime', async t => {
  for (const kind of ['skip', 'advance'] as const) await t.test(kind, async t => {
    const f = await fixture(t, undefined, mastered, supportedReview);
    let first;
    if (kind === 'skip') {
      mockTurn(t, true);
      first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
      await confirmSkip(f, first);
    } else {
      const lesson = await prepareLesson(t, f);
      scriptedTurn(t, async options => {
        const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
        await interpret(options);
        await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
        await tool('propose_learning_action').execute('next', { action: 'advance_learning_step', advance_mode: 'complete' });
        await tool('submit_conversation_reply').execute('reply', { kind: 'action', text: '', supplement: '独立解释保留。' });
      });
      first = (await f.service.run({ ...f.base, content: 'input 是参数，请提供完成确认。', reviewEvidence: true }))!;
      await f.service.resolveLearningAction({ ...f.base, actionId: first.assistant_message.learning_action!.action_id, decision: 'confirm' });
    }
    const baseline = await f.load();
    const answer = baseline.messages.at(-1)!;
    f.config.freeProviderApiKey = '';
    t.mock.method(PiConversationRuntime.prototype, 'run', async () => { assert.fail('deterministic replay must bypass runtime'); });
    t.mock.method(f.store, 'loadSettings', async () => { assert.fail('deterministic replay must bypass provider configuration'); });
    for (let retry = 0; retry < 2; retry++) {
      const replay: ConversationResult = (await f.service.run({ ...f.base, content: first.user_message.content, replaceMessageId: first.user_message.message_id, reviewEvidence: true }))!;
      assert.deepEqual((await f.load()).study, baseline.study);
      assert.equal(replay.assistant_message.content_parts!.body, answer.content_parts!.body);
      assert.deepEqual(replay.assistant_message.content_parts!.evidence_blocks, answer.content_parts!.evidence_blocks);
      assert.deepEqual(replay.assistant_message.evidence_review, answer.evidence_review);
      assert.deepEqual(replay.assistant_message.evidence, answer.evidence);
      assert.equal(replay.assistant_message.learning_action!.status, 'executed');
      assert.equal(replay.assistant_message.usage!.total_tokens, 0);
      assert.match(replay.assistant_message.content, /恢复已保存的回答/);
      const trace = JSON.parse(await readFile(join(f.root, 'traces', replay.assistant_message.trace_id! + '.json'), 'utf8'));
      assert.equal(trace.evidence_quality.model_call_count, 0);
    }
    await assert.rejects(f.service.run({ ...f.base, owner: { owner_id: 'another-owner', kind: 'guest' }, content: first.user_message.content,
      replaceMessageId: first.user_message.message_id }), { code: 'not_found' });
  });
});

test('review metrics count actual block requests and worker retries instead of worker objects', async t => {
  const diagnostic = (requestCount: number) => ({ ...createWorkerDiagnostics().data, requestCount });
  let reviewed = 0;
  const f = await fixture(t, undefined, async input => ({ ...await mastered(input),
    trace: { ...(await mastered(input)).trace, diagnostics: diagnostic(2) } }), async () => {
      reviewed++;
      return { ...unavailableEvidenceReview(), status: 'reviewed', completed: true, diagnostics: diagnostic(3) };
    }, async () => ({ completed: true, findings: [], trace: { ...routeResult().trace,
      skill_id: 'reply-content-review', diagnostics: diagnostic(2) } }));
  const lesson = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    await interpret(options);
    await options.tools.find(tool => tool.name === 'assess_understanding')!.execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
    await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'assessment', text: '', supplement: '独立解释。' });
  });
  const result = (await f.service.run({ ...f.base, content: 'input 是参数。', reviewEvidence: true }))!;
  assert.equal(reviewed, 2);
  const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
  assert.equal(trace.evidence_quality.model_call_count, 10, 'one content check, two evidence workers and the initial assessment are counted; a review without actionable findings cannot authorize another submission');
  assert.deepEqual(trace.submission_budget, { used: 1, limit: 3 });
  assert.equal(trace.review.request_count, 6);
});

test('the same quoted sentence in assessment and active instruction in supplement repairs only the supplement', async t => {
  const sentence = '请点击确认后进入下一步。';
  let grades = 0;
  const f = await fixture(t, undefined, async input => {
    assert.equal(input.feedbackRepair, undefined, 'the assessment quotation is not the offending source');
    grades++;
    return { ...await mastered(input), feedback: '回答正确。旧话术“' + sentence + '”容易误导，这里只讨论它的含义。' };
  }, undefined, async input => ({ completed: true,
    findings: input.blocks?.some(block => block.kind === 'explanation' && block.text.includes(sentence))
      ? [{ block_kind: 'explanation', span: sentence }] : [],
    trace: { ...routeResult().trace, skill_id: 'reply-content-review' } }));
  const lesson = await prepareLesson(t, f);
  scriptedTurn(t, async options => {
    const tool = (name: string) => options.tools.find(tool => tool.name === name)!;
    await interpret(options);
    await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
    await tool('propose_learning_action').execute('advance', { action: 'advance_learning_step', advance_mode: 'complete' });
    await assert.rejects(tool('submit_conversation_reply').execute('bad', { kind: 'action', text: '', supplement: '独立解释。' + sentence }), /explanation:/);
    await tool('submit_conversation_reply').execute('fixed', { kind: 'action', text: '', supplement: '独立解释：input 是参数。' });
  });
  const reply = (await f.service.run({ ...f.base, content: 'input 是参数，请解释旧话术。' }))!.assistant_message;
  assert.equal(grades, 1);
  assert.match(reply.content_parts!.body, /旧话术/);
  assert.match(reply.content_parts!.body, /独立解释：input/);
  assert.equal(reply.learning_action!.status, 'pending');
});

test('an incomplete reply check ends immediately and cannot clear a follow-up to execute', async t => {
  let runs = 0;
  const f = await fixture(t, undefined, undefined, undefined, async () => {
    runs++;
    return { completed: false, findings: [], trace: { ...routeResult().trace, skill_id: 'reply-content-review', completed: false } };
  });
  scriptedTurn(t, async options => {
    const submit = options.tools.find(tool => tool.name === 'submit_conversation_reply')!;
    await interpret(options, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释例子。' }]);
    await proposeSkip(options);
    await submit.execute('first', { kind: 'action', text: '', supplement: '独立解释。' });
    assert.match(options.replyContract!.read()!, /尚未完成/);
    await assert.rejects(submit.execute('changed', { kind: 'action', text: '', supplement: '换个说法。' }), /already submitted/);
  });
  const reply = (await f.service.run({ ...f.base, content: '跳过这一步，同时解释例子。' }))!.assistant_message;
  assert.equal(runs, 1);
  assert.equal(reply.learning_action ?? null, null);
  assert.deepEqual(reply.evidence, []);
  assert.deepEqual(reply.content_parts!.evidence_blocks, []);
  assert.equal((await f.load()).study.current_step, 0);
});

test('an executed action on a valid historical view replays against its leased snapshot even after project publication changes', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  await confirmSkip(f, first);
  const baseline = await f.load();
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.analysis.snapshot_id = 'snapshot:new'; });
  t.mock.method(f.store, 'findPublicSnapshotKeyBySnapshotId', async () => 'old-public-key');
  t.mock.method(f.store, 'loadPublicSnapshotMetadata', async () => ({ repository_identity: 'example/teaching',
    public_snapshot_key: 'old-public-key', analysis_snapshot_id: snapshot.snapshot_id, commit_sha: 'old',
    retired_at: new Date().toISOString(), purge_after: new Date(Date.now() + 60_000).toISOString() }));
  t.mock.method(f.store, 'loadCurrentRepositoryHead', async () => ({ current_public_snapshot_key: 'new-public-key' }));
  t.mock.method(f.store, 'acquireSnapshotReadLease', async () => 'lease:test');
  t.mock.method(f.store, 'releaseSnapshotReadLease', async () => {});
  t.mock.method(PiConversationRuntime.prototype, 'run', async () => { assert.fail('no model for pinned replay'); });
  const replay = (await f.service.run({ ...f.base, content: first.user_message.content,
    replaceMessageId: first.user_message.message_id, viewSnapshotId: snapshot.snapshot_id }))!;
  assert.equal(replay.assistant_message.content_parts!.body, first.assistant_message.content_parts!.body);
  assert.equal((await f.load()).analysis.snapshot_id, 'snapshot:new');
  assert.deepEqual((await f.load()).study, baseline.study);
});

test('nonexecuted cards, changed text and another explicit action do not use deterministic replay', async t => {
  for (const state of ['pending', 'failed', 'expired', 'declined', 'edited', 'new-intent'] as const) await t.test(state, async t => {
    const f = await fixture(t); mockTurn(t, true);
    const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  await confirmSkip(f, first);
    if (!['edited', 'new-intent'].includes(state)) await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => {
      row.messages.at(-1)!.learning_action!.status = state as 'pending' | 'failed' | 'expired' | 'declined';
      delete row.messages[0]!.learning_action_result;
    });
    f.config.freeProviderApiKey = '';
    const executed = (await f.load()).messages.find(message => message.learning_action?.action_id === first.assistant_message.learning_action?.action_id)?.learning_action;
    await assert.rejects(f.service.run({ ...f.base, content: state === 'edited' ? '再解释一下。' : state === 'new-intent' ? '' : first.user_message.content,
      ...(state === 'new-intent' ? { lessonActionId: executed!.action_id, runId: executed!.outcome!.lesson_run_id }
        : { replaceMessageId: first.user_message.message_id }),
    }), { code: 'provider_unavailable' });
    assert.equal((await f.load()).study.current_step, 1);
  });
});

test('assessment owner repair validates locked fields through the real structured-worker retry loop', async t => {
  const f = await fixture(t);
  const lesson = await prepareLesson(t, f);
  const project = await f.load();
  const question = lesson.assistant_message.teaching_question!;
  const faux = fauxProvider({ provider: 'assessment-feedback-repair' });
  const models = createModels(); models.setProvider(faux.provider);
  const valid = { answer_relevant: true, verdict: 'mastered', feedback: 'input 是函数参数。',
    mastered_items: ['input'], misconceptions: [], evidence_ids: ['evidence:input'],
    target_results: question.target_ids!.map(target_id => ({ target_id, outcome: 'proven', reason: 'Controlled repair keeps judgment.', answer_spans: ['input 是参数。'], evidence_ids: ['evidence:input'] })) };
  const repairInput = { answer: 'input 是参数。', question, project } as Parameters<typeof runUnderstandingAssessment>[0];
  const questionResult = fixtureQuestionResult(repairInput);
  const feedbackScope = fixtureFeedbackScope(repairInput, valid.target_results as TeachingTargetResult[], questionResult);
  faux.setResponses([
    context => {
      assert.match(JSON.stringify(context.messages), /fixed_assessment/);
      assert.match(JSON.stringify(context.messages), /question_covered_target_ids/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { feedback: valid.feedback, verdict: 'partial' }));
    },
    context => {
      assert.match(JSON.stringify(context.messages), /verdict|additional/i);
      return fauxAssistantMessage(fauxToolCall('submit_result', { feedback: valid.feedback }));
    },
  ]);
  const result = await runUnderstandingAssessment({ answer: 'input 是参数。', originalMessage: 'input 是参数。另外请解释。',
    question, evidence: question.evidence, project, snapshot, store: f.store, modelRuntime: { models, model: faux.getModel() as Model<Api> },
    feedbackRepair: { feedback: 'input 是函数参数。请点确认。', offendingSpans: ['请点确认。'], verdict: 'mastered', answerRelevant: true,
      masteredItems: ['input'], misconceptions: [], evidenceIds: ['evidence:input'], targetResults: valid.target_results as TeachingTargetResult[], feedbackScope, questionResult } });
  assert.equal(result.completed, true);
  assert.equal(result.verdict, 'mastered');
  assert.equal(result.feedback, valid.feedback);
  assert.deepEqual(result.feedbackScope, feedbackScope);
  assert.deepEqual(result.questionResult, questionResult);
  assert.deepEqual(result.targetResults, valid.target_results);
  assert.equal(result.trace.diagnostics!.requestCount, 2);
});

test('the persisted execution marker replays a prior regenerated answer that has no card', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  await confirmSkip(f, first);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.messages.at(-1)!.learning_action = null; });
  f.config.freeProviderApiKey = '';
  t.mock.method(PiConversationRuntime.prototype, 'run', async () => { assert.fail('saved execution result suffices for exact resend'); });
  const result = (await f.service.run({ ...f.base, content: first.user_message.content, replaceMessageId: first.user_message.message_id }))!;
  assert.equal(result.assistant_message.learning_action, null);
  assert.equal(result.assistant_message.usage!.total_tokens, 0);
  assert.equal((await f.load()).study.current_step, 1);
  assert.match(result.assistant_message.content, /恢复已保存/);
});

// Fixed contract matrix: controlled semantic results enter the real tools,
// final review, atomic save and confirmation API. No real provider is called.
const supportedReview: typeof reviewAnswerEvidence = async input => ({ ...unavailableEvidenceReview(),
  status: 'reviewed', supported: true, completed: true, summary: 'Controlled complete source support.',
  acceptedEvidenceIds: input.evidence.map(row => row.stable_id) });

async function exposeRepairSources(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const evidence = Array.from({ length: count }, (_, index) => ({ stable_id: `repair:${index}`, label: `src/repair${index}.ts`,
    path: `src/repair${index}.ts`, start_line: 1, end_line: 1, kind: 'source_excerpt' }));
  const bound = structuredClone(snapshot);
  bound.graph.layers.push({ id: 'repair:layer', name: 'Repair', responsibility: 'Input', component_ids: [], certainty: 'verified', evidence });
  await f.store.saveSnapshot(f.project.project_id, bound);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.dynamic_learning_plan![0]!.evidence_refs = evidence.map(row => row.stable_id); });
  t.mock.method(f.store, 'listSourceFiles', async () => evidence.map(row => row.path));
  t.mock.method(f.store, 'readSourceLines', async (_project: string, _snapshot: string, _path: string, start: number, end: number) => ({
    lines: ['export function entry(input) {', '  return input;', '}'].slice(start - 1, end), truncated: false }));
  return evidence;
}

test('R3 packet-budget rejection spends no review request and a focused second submission activates its question', async t => {
  const reviewed: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  const f = await fixture(t, undefined, undefined, async input => { reviewed.push(input); return supportedReview(input); });
  const evidence = await exposeRepairSources(t, f, 14);
  const sensitive = 'PRIVATE_CANDIDATE_ONLY_7b812';
  // The extra overlapping citation has its own identity but shares one source packet.
  const references = evidence.map(row => '`' + row.path + ':1`').join('、') + '、`src/repair0.ts:1-2`';
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    await tool('get_learning_context').execute('context', {});
    await assert.rejects(tool('submit_conversation_reply').execute('wide', { kind: 'lesson',
      text: `入口接收参数。 ${sensitive} ${references}`, question: { prompt: 'What is the input? ' + references, target_items: [steps[0]!.completion_check], evidence_ids: [evidence[0]!.stable_id] } }), error => {
      assert.equal((error as { code: string }).code, 'reply_evidence_repair_required');
      const repairs = JSON.parse((error as Error).message.split('Repair details: ')[1]!.split('\nSubmission budget:')[0]!);
      assert.ok(repairs.some((row: { packet_count: number; unread_ranges: Array<{ reason: string }> }) => row.packet_count === 14 && row.unread_ranges.some(packet => packet.reason === 'budget_exceeded')));
      return true;
    });
    assert.equal(reviewed.length, 0);
    assert.equal(runtime.replyContract!.read(), null);
    await tool('read_source_excerpt').execute('focus', { path: evidence[0]!.path, offset: 1, limit: 1 });
    await tool('submit_conversation_reply').execute('focused', { kind: 'lesson', text: '入口接收参数，见 `src/repair0.ts:1`。',
      question: { prompt: 'What is the input?', target_items: [steps[0]!.completion_check], evidence_ids: [evidence[0]!.stable_id] } });
  }, '模型草稿', 'completed', false);
  const result = (await f.service.run({ ...f.base, content: '开始当前步骤', reviewEvidence: true }))!;
  assert.ok(result.assistant_message.teaching_question);
  assert.equal(reviewed.length, 2, 'final gate reuses the successful explanation and question reviews');
  const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
  assert.equal(trace.submission_diagnostics[0].code, 'reply_evidence_repair_required');
  assert.equal(trace.submission_diagnostics[0].attempt, 1);
  assert.match(trace.submission_diagnostics[0].candidate_sha256, /^[a-f0-9]{64}$/);
  assert.ok(trace.evidence_preflight.some((row: { attempt: number; packet_count: number; coverage_reasons?: string[] }) => row.attempt === 1 && row.packet_count === 14 && row.coverage_reasons?.includes('budget_exceeded')));
  assert.doesNotMatch(JSON.stringify(trace), new RegExp(sensitive));
});

test('R3 a narrow unsupported packet is repaired by reading a wider range and every actual review is charged once', async t => {
  const reviewed: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  const f = await fixture(t, undefined, undefined, async input => {
    reviewed.push(input);
    const supported = input.evidence.some(row => row.start_line === 1 && row.end_line === 3);
    return { ...await supportedReview(input), supported, usage: { ...usage, inputTokens: 2, costUsd: 0.01 },
      diagnostics: { ...createWorkerDiagnostics().data, requestCount: 1 },
      issues: supported ? [] : [{ claim: input.text, reason: 'The narrow range excludes the return statement.', kind: 'insufficient_evidence' }] };
  });
  const evidence = await exposeRepairSources(t, f, 1);
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    await tool('get_learning_context').execute('context', {});
    await assert.rejects(tool('submit_conversation_reply').execute('narrow', { kind: 'lesson', text: '返回 input，见 `src/repair0.ts:1`。',
      question: { prompt: 'What is the input?', target_items: [steps[0]!.completion_check], evidence_ids: [evidence[0]!.stable_id] } }), error => {
      assert.equal((error as { code: string }).code, 'reply_evidence_repair_required');
      assert.match((error as Error).message, /excludes the return statement/);
      return true;
    });
    assert.equal(reviewed.length, 2);
    const read = toolPayload(await tool('read_source_excerpt').execute('wider', { path: evidence[0]!.path, offset: 1, limit: 3 }));
    await tool('submit_conversation_reply').execute('repaired', { kind: 'lesson', text: '返回 input，见 `src/repair0.ts:1-3`。',
      question: { prompt: 'What is the input?', target_items: [steps[0]!.completion_check], evidence_ids: [read.evidence[0].stable_id] } });
  }, '模型草稿', 'completed', false);
  const result = (await f.service.run({ ...f.base, content: '开始当前步骤', reviewEvidence: true }))!;
  assert.ok(result.assistant_message.teaching_question);
  assert.equal(reviewed.length, 4, 'two rejected narrow reviews and two supported wider reviews; finalization adds none');
  assert.deepEqual(reviewed.map(row => row.evidence[0]!.end_line), [1, 1, 3, 3]);
  const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
  assert.equal(trace.review.request_count, 4);
  assert.equal(trace.review.usage.costUsd, 0.04);
  assert.equal(trace.usage.costUsd, 0.04);
  assert.equal(result.assistant_message.usage!.prompt_tokens, 8);
});

test('R3 an unavailable review freezes the first candidate and cannot be resampled by rewriting it', async t => {
  for (const oldQuestion of [false, true]) await t.test(oldQuestion ? 'retains the old question' : 'reports that no question is active', async t => {
    let calls = 0;
    const f = await fixture(t, undefined, undefined, async input => {
      calls++;
      return calls === 1 ? unavailableEvidenceReview('Controlled transient review outage.', input.text) : supportedReview(input);
    });
    if (oldQuestion) await prepareLesson(t, f);
    const previous = structuredClone((await f.load()).study.teaching_question ?? null);
    await exposeRepairSources(t, f, 1);
    scriptedTurn(t, async runtime => {
      await interpret(runtime, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释实现。' }]);
    await proposeSkip(runtime);
      const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
      await tool('get_learning_context').execute('context', {});
      const candidate = { kind: 'action', text: '', supplement: '入口接收参数，见 `src/repair0.ts:1`。' };
      await tool('submit_conversation_reply').execute('first', candidate);
      assert.ok(runtime.replyContract!.read(), 'runtime has a terminal candidate');
      await assert.rejects(tool('submit_conversation_reply').execute('rewritten',
        { ...candidate, supplement: '改写后的说明，见 `src/repair0.ts:1-3`。' }), /already submitted/);
      assert.equal(calls, 1);
    }, '模型草稿', 'completed', false);
    const result = (await f.service.run({ ...f.base, content: '跳过这一步，同时解释实现。', reviewEvidence: true }))!;
    assert.equal(calls, 1);
    const saved = await f.load();
    assert.equal(saved.study.current_step, 0);
    assert.deepEqual(saved.study.teaching_question ?? null, previous);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal(result.user_message.learning_action_result, undefined);
    assert.match(result.assistant_message.content, /未能完成证据核对/);
    assert.doesNotMatch(result.assistant_message.content, /已跳过|点击确认|确认后/);
    const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
    assert.deepEqual(trace.submission_budget, { used: 1, limit: 3 });
    assert.equal(trace.submission_diagnostics[0].code, 'review_unavailable_terminal');
  });
});

test('an unavailable lesson explanation ends without another review and cannot activate its supported question', async t => {
  const reviews: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  const f = await fixture(t, undefined, undefined, async input => {
    reviews.push(input);
    return input.purpose === 'question' ? supportedReview(input) : unavailableEvidenceReview('Controlled length limit.', input.text);
  });
  const evidence = await exposeRepairSources(t, f, 1);
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    await tool('get_learning_context').execute('context', {});
    await tool('submit_conversation_reply').execute('first', { kind: 'lesson', text: '入口接收参数，见 `src/repair0.ts:1`。',
      question: { prompt: 'What is the input?', target_items: [steps[0]!.completion_check], evidence_ids: [evidence[0]!.stable_id] } });
    assert.ok(runtime.replyContract!.read(), 'runtime has a terminal candidate');
    await assert.rejects(tool('submit_conversation_reply').execute('rewrite', { kind: 'lesson', text: 'A different explanation.' }), /already submitted/);
  }, '模型草稿', 'completed', false);
  const result = (await f.service.run({ ...f.base, content: '开始讲解当前步骤。', reviewEvidence: true }))!;
  assert.deepEqual(reviews.map(review => review.purpose), ['answer', 'question'], 'finalization reuses both original results');
  assert.equal(result.assistant_message.teaching_question, undefined);
  assert.equal(result.assistant_message.context_eligible, false);
  const saved = await f.load();
  assert.equal(saved.study.current_step, 0);
  assert.equal(saved.study.teaching_question ?? null, null);
  assert.equal(saved.study.latest_assessment ?? null, null);
  assert.deepEqual(saved.study.mastered, []);
});

test('R3 three over-budget lesson candidates retain the old question or accurately report no active question', async t => {
  for (const oldQuestion of [false, true]) await t.test(oldQuestion ? 'retains old displayed question' : 'no old question', async t => {
    let reviews = 0;
    const f = await fixture(t, undefined, undefined, async input => { reviews++; return supportedReview(input); });
    if (oldQuestion) await prepareLesson(t, f);
    const previous = structuredClone((await f.load()).study.teaching_question ?? null);
    const evidence = await exposeRepairSources(t, f, 14);
    const references = evidence.map(row => '`' + row.path + ':1`').join('、');
    scriptedTurn(t, async runtime => {
      const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
      if (oldQuestion) await interpret(runtime, 'replace');
      await tool('get_learning_context').execute('context', {});
      const candidate = { kind: 'lesson', text: '入口接收参数。' + references,
        question: { prompt: 'What is the input? ' + references, target_items: [steps[0]!.completion_check], evidence_ids: [evidence[0]!.stable_id] } };
      for (let attempt = 1; attempt <= 2; attempt++) {
        await assert.rejects(tool('submit_conversation_reply').execute(`fail:${attempt}`, candidate), { code: 'reply_evidence_repair_required' });
        assert.equal(runtime.replyContract!.read(), null);
      }
      await tool('submit_conversation_reply').execute('third', candidate);
    }, '模型草稿', 'completed', false);
    const result = (await f.service.run({ ...f.base, content: oldQuestion ? '请换一道题。' : '开始当前步骤', reviewEvidence: true }))!;
    assert.equal(reviews, 0, 'known incomplete packet sets never spend semantic review requests');
    const saved = await f.load();
    assert.deepEqual(saved.study.teaching_question ?? null, previous);
    assert.equal(saved.study.current_step, 0);
    assert.equal(result.assistant_message.teaching_question, undefined);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.match(result.assistant_message.content, oldQuestion ? /原题|当前题|保留/ : /没有(?:生效|可作答)的题目/);
    const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
    assert.equal(trace.submission_diagnostics.length, 2);
    assert.ok(trace.evidence_preflight.every((row: { coverage_reasons: string[] }) => row.coverage_reasons.includes('budget_exceeded')));
  });
});

async function gradeTurn(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, content: string,
  options: { card?: boolean; supplement?: string; replaceMessageId?: string; reviewEvidence?: boolean } = {}) {
  const before = await f.load();
  const question = before.study.teaching_question ?? [...before.messages].reverse().find(message => message.teaching_question)?.teaching_question;
  assert.ok(question, 'fixture needs an actual displayed question');
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    await interpret(runtime);
    await tool('assess_understanding').execute('grade', { question_id: question.question_id });
    if (options.card) await tool('propose_learning_action').execute('advance', { action: 'advance_learning_step', advance_mode: 'complete' });
    await tool('submit_conversation_reply').execute('reply', { kind: options.card ? 'action' : 'assessment', text: '', supplement: options.supplement ?? '' });
  });
  return (await f.service.run({ ...f.base, content, replaceMessageId: options.replaceMessageId, reviewEvidence: options.reviewEvidence }))!;
}

const partialTargets: typeof runUnderstandingAssessment = async input => {
  const result: Awaited<ReturnType<typeof runUnderstandingAssessment>> = { ...await mastered(input),
  verdict: input.answer.includes('wrong') ? 'misconception' : input.answer.includes('A') && input.answer.includes('B') ? 'mastered' : 'partial',
  targetResults: input.question.target_ids!.map((target_id, index) => {
    const label = input.question.target_items[index]!;
    const span = input.answerParts?.find(part => part.includes(label)) ?? input.answer;
    const mentioned = span.includes(label);
    return { target_id, outcome: mentioned ? span.includes(label + ' wrong') ? 'contradicted' : 'proven' : 'not_addressed',
      reason: mentioned ? 'Controlled judgment of this exact answer.' : 'This allowed branch was not answered.',
      answer_spans: mentioned ? [span] : [], evidence_ids: mentioned ? ['evidence:input'] : [] };
  }) };
  result.feedbackScope = fixtureFeedbackScope(input, result.targetResults!);
  result.reviewContext = assessmentTestReviewContext(input, result);
  return result;
};

test('TA09 allowed choice proves only the answered target even when the question declares four targets', async t => {
  const f = await fixture(t, undefined, async input => ({ ...await partialTargets(input), verdict: 'mastered' }));
  f.project.study.dynamic_learning_plan![0]!.learning_targets = ['A', 'B', 'C', 'D'];
  await prepareLesson(t, f, { prompt: '任选一项：A、B、C、D。', targets: ['A', 'B', 'C', 'D'] });
  const result = await gradeTurn(t, f, 'A correct.');
  const saved = await f.load();
  assert.equal(saved.study.latest_assessment!.verdict, 'mastered', 'question correctness does not punish allowed unchosen branches');
  assert.equal(saved.study.latest_assessment!.step_completed, false);
  assert.deepEqual(saved.study.mastered_target_items, ['A']);
  assert.equal(saved.study.step_passed, null);
  assert.equal(result.assistant_message.learning_action ?? null, null);
  assert.equal(saved.study.target_assessments!.length, 1);
});

test('TA13 definitions-only steps register, restore and assess only their explicitly bound target IDs', async t => {
  const f = await fixture(t, undefined, mastered);
  f.project.study.dynamic_learning_plan![0]!.learning_target_defs = [{ target_id: 'target:input', label: 'Explain input' }];
  delete f.project.study.dynamic_learning_plan![0]!.learning_targets;
  const lesson = await prepareLesson(t, f, { prompt: 'Explain the input parameter.', targets: ['Explain input'] });
  assert.deepEqual(lesson.assistant_message.teaching_question!.target_ids, ['target:input']);
  await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.teaching_question = null; });
  await gradeTurn(t, f, 'input 是参数。');
  const saved = await f.load();
  assert.deepEqual(saved.study.step_passed!.target_ids, ['target:input']);
  assert.deepEqual(saved.study.mastered_target_items, ['Explain input']);
});

test('TA10 TA11 partial proofs accumulate and only explicit target counterevidence revokes a pass and its old card', async t => {
  const f = await fixture(t, undefined, partialTargets);
  f.project.study.dynamic_learning_plan![0]!.learning_targets = ['A', 'B'];
  await prepareLesson(t, f, { prompt: '分别解释A与B，可以逐次补齐。', targets: ['A', 'B'] });
  await gradeTurn(t, f, 'A correct.');
  assert.deepEqual((await f.load()).study.mastered_target_items, ['A']);
  const completed = await gradeTurn(t, f, 'B correct.', { card: true });
  assert.deepEqual((await f.load()).study.mastered_target_items, ['A', 'B']);
  assert.ok((await f.load()).study.step_passed);
  const card = completed.assistant_message.learning_action!;
  assert.equal(card.status, 'pending');
  await gradeTurn(t, f, 'A wrong.');
  assert.deepEqual((await f.load()).study.mastered_target_items, ['B']);
  assert.equal((await f.load()).study.step_passed, null);
  assert.equal((await f.load()).messages.find(message => message.learning_action?.action_id === card.action_id)!.learning_action!.status, 'expired');
  await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'learning_action_not_pending' });
  await gradeTurn(t, f, 'A correct.');
  assert.deepEqual((await f.load()).study.mastered_target_items, ['A', 'B']);
  assert.ok((await f.load()).study.step_passed);
  await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId: card.action_id, decision: 'confirm' }), { code: 'learning_action_not_pending' });
  assert.equal((await f.load()).study.current_step, 0);
});

test('TA19 same-message retry and editing replace the target proof source instead of counting two answers', async t => {
  const f = await fixture(t, undefined, partialTargets);
  f.project.study.dynamic_learning_plan![0]!.learning_targets = ['A', 'B'];
  await prepareLesson(t, f, { prompt: '解释A与B。', targets: ['A', 'B'] });
  const first = await gradeTurn(t, f, 'A correct.');
  await gradeTurn(t, f, 'A correct.', { replaceMessageId: first.user_message.message_id });
  assert.equal((await f.load()).study.target_assessments!.length, 1);
  await gradeTurn(t, f, 'B correct.', { replaceMessageId: first.user_message.message_id });
  const saved = await f.load();
  assert.equal(saved.study.target_assessments!.length, 1);
  assert.deepEqual(saved.study.mastered_target_items, ['B']);
  assert.equal(saved.study.step_passed, null);
  assert.deepEqual(saved.study.target_assessments![0]!.answer_parts, ['B correct.']);
  assert.equal(saved.study.target_assessments![0]!.original_message_id, first.user_message.message_id);
});

test('TA12 unrelated or unclear answers preserve already qualified target proofs without adding an attempt', async t => {
  for (const relevant of [false, true]) await t.test(relevant ? 'uncertain actual answer' : 'unrelated request', async t => {
    let unclear = false;
    const f = await fixture(t, undefined, async input => !unclear ? mastered(input) : ({ ...await mastered(input),
      verdict: 'unclear', answerRelevant: relevant, targetResults: input.question.target_ids!.map(target_id => ({ target_id,
        outcome: 'not_addressed', reason: 'No current proof or counterevidence.', answer_spans: [], evidence_ids: [] })) }));
    await prepareLesson(t, f);
    await gradeTurn(t, f, 'input 是参数。');
    const before = structuredClone((await f.load()).study);
    unclear = true;
    if (relevant) await gradeTurn(t, f, '我不确定。');
    else {
      scriptedTurn(t, async runtime => {
        await interpret(runtime);
        await assert.rejects(runtime.tools.find(tool => tool.name === 'assess_understanding')!.execute('irrelevant',
          { question_id: before.teaching_question!.question_id }), /does not answer/);
        await assert.rejects(interpret(runtime, 'explain'), /cannot change/);
        await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'answer', text: '处理独立话题。' });
      });
      const response = (await f.service.run({ ...f.base, content: '请解释另一个话题。' }))!;
      assert.match(response.assistant_message.content, /处理独立话题/);
    }
    const after = (await f.load()).study;
    assert.deepEqual(after.target_assessments, before.target_assessments);
    assert.deepEqual(after.mastered_target_items, before.mastered_target_items);
    assert.deepEqual(after.step_passed, before.step_passed);
    assert.deepEqual(after.misconceptions, before.misconceptions);
    assert.deepEqual(after.teaching_question!.answer_attempts, before.teaching_question!.answer_attempts);
  });
});

test('TA05 final question or supporting lesson review failure retains the old displayed question and rejects the candidate next turn', async t => {
  for (const block of ['question', 'explanation'] as const) for (const failure of ['unsupported', 'unavailable'] as const)
    await t.test(block + ':' + failure, async t => {
      let grades = 0;
      const f = await fixture(t, undefined, async input => { grades++; return mastered(input); }, async input => {
        const fails = block === 'question' ? input.text.includes('Replacement?') : input.text.includes('替换题的讲解');
        return !fails ? supportedReview(input) : failure === 'unavailable' ? unavailableEvidenceReview()
          : { ...await supportedReview(input), supported: false, acceptedEvidenceIds: [], issues: [{ claim: input.text, kind: 'contradicted', reason: 'Controlled review rejection.' }] };
      });
      f.project.study.dynamic_learning_plan![0]!.learning_targets = [steps[0]!.completion_check];
      const original = await prepareLesson(t, f);
      let candidateId = '';
      scriptedTurn(t, async runtime => {
        await interpret(runtime, 'replace');
        await runtime.tools.find(tool => tool.name === 'get_learning_context')!.execute('context', {});
        const registered = await runtime.tools.find(tool => tool.name === 'register_teaching_question')!.execute('candidate',
          { prompt: 'Replacement?', target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] });
        candidateId = toolPayload(registered).question.question_id;
        await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply',
          { kind: 'lesson', text: '替换题的讲解。', question_id: candidateId });
      });
      const result = (await f.service.run({ ...f.base, content: '请换一道题。', reviewEvidence: true }))!;
      assert.equal(result.assistant_message.teaching_question, undefined);
      assert.doesNotMatch(result.assistant_message.content, /Replacement\?/);
      assert.match(result.assistant_message.content, /替换题的讲解/);
      assert.equal((await f.load()).study.teaching_question!.question_id, original.assistant_message.teaching_question!.question_id);
      scriptedTurn(t, async runtime => {
        await interpret(runtime);
        await assert.rejects(runtime.tools.find(tool => tool.name === 'assess_understanding')!.execute('hidden', { question_id: candidateId }), /registered current question/);
        await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('fallback', { kind: 'unavailable', text: '' });
      });
      await f.service.run({ ...f.base, content: 'input 是参数。' });
      assert.equal(grades, 0);
    });
});

test('TA22 failed final assessment review cannot publish any new proof, attempt or completion card', async t => {
  for (const failure of ['contradicted', 'unverified', 'incomplete', 'missing-subject'] as const) await t.test(failure, async t => {
    let ownerCalls = 0;
    const f = await fixture(t, undefined, async input => { ownerCalls++; return mastered(input); }, async input => failure === 'unverified' ? unavailableEvidenceReview()
      : { ...await supportedReview(input), supported: failure === 'incomplete', evidenceIncomplete: failure === 'incomplete',
        issues: failure === 'contradicted' || failure === 'missing-subject' ? [{ claim: input.text, kind: 'contradicted', ...(failure === 'contradicted' ? { subject: 'assessment_judgment' as const } : {}), reason: 'Controlled counterevidence.' }] : [] });
    await prepareLesson(t, f);
    const baseline = structuredClone((await f.load()).study);
    const result = await gradeTurn(t, f, 'input 是参数。', { card: true, reviewEvidence: true });
    assert.deepEqual((await f.load()).study, baseline);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal(result.assistant_message.teaching_question, undefined);
    assert.equal((await f.load()).study.current_step, 0);
    assert.equal(ownerCalls, 1, 'judgment denial, unavailable/incomplete review and unknown issue ownership never authorize feedback repair');
    assert.doesNotMatch(result.assistant_message.content, /回答正确|本题已回答完整|本步所有学习目标已有有效证明/);
    assert.match(result.assistant_message.content, /未|核对/);
  });
});

test('TA22 a rejected new counterassessment preserves previously qualified target coverage and its original source', async t => {
  let counter = false;
  const f = await fixture(t, undefined, async input => !counter ? mastered(input) : ({ ...await mastered(input), verdict: 'misconception',
    targetResults: input.question.target_ids!.map(target_id => ({ target_id, outcome: 'contradicted', reason: 'Controlled current counterassessment.',
      answer_spans: [input.answer], evidence_ids: ['evidence:input'] })) }), async input => ({ ...await supportedReview(input), supported: false,
    acceptedEvidenceIds: [], issues: [{ claim: input.text, kind: 'contradicted', reason: 'The new assessment is factually wrong.' }] }));
  await prepareLesson(t, f);
  const established = await gradeTurn(t, f, 'input 是参数。');
  const previous = structuredClone((await f.load()).study);
  assert.ok(previous.step_passed, 'prior proof must come from actual assessment and save');
  counter = true;
  const rejected = await gradeTurn(t, f, 'input 不是参数。', { reviewEvidence: true });
  assert.deepEqual((await f.load()).study, previous);
  assert.equal(rejected.assistant_message.learning_action ?? null, null);
  assert.equal((await f.load()).study.target_assessments![0]!.original_message_id, established.user_message.message_id);
  assert.equal((await f.load()).study.target_assessments!.length, 1);
});

test('TA23 valid assessment survives failed independent supplement but neither completion nor skip can publish', async t => {
  for (const kind of ['advance', 'skip'] as const) for (const failure of ['unsupported', 'unavailable'] as const) await t.test(kind + ':' + failure, async t => {
    const f = await fixture(t, undefined, mastered, async input => input.text.includes('永远返回 null')
      ? failure === 'unavailable' ? unavailableEvidenceReview('Controlled reviewer outage.', input.text)
        : { ...await supportedReview(input), supported: false, acceptedEvidenceIds: [], issues: [{ claim: input.text, kind: 'contradicted', reason: 'Returns input.' }] }
      : supportedReview(input));
    const lesson = await prepareLesson(t, f);
    t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
    let result;
    if (kind === 'advance') result = await gradeTurn(t, f, 'input 是参数。', { card: true, supplement: '这里永远返回 null，参见 `src/entry.ts:3`。', reviewEvidence: true });
    else {
      scriptedTurn(t, async runtime => {
        await interpret(runtime, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释实现。' }]);
        await proposeSkip(runtime);
        await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply',
          { kind: 'action', text: '', supplement: '这里永远返回 null，参见 `src/entry.ts:3`。' });
      });
      result = (await f.service.run({ ...f.base, content: '跳过这一步，同时解释实现。', reviewEvidence: true }))!;
    }
    assert.equal((await f.load()).study.current_step, 0);
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.match(result.assistant_message.content, /永远返回 null/);
    assert.equal(result.assistant_message.evidence_review!.supported, false);
    if (kind === 'advance') {
      assert.ok((await f.load()).study.step_passed);
      assert.equal(result.assistant_message.content_parts!.evidence_blocks!.find(block => block.kind === 'assessment')!.review!.supported, true);
    } else assert.equal((await f.load()).study.teaching_question!.question_id, lesson.assistant_message.teaching_question!.question_id);
  });
});

test('TA04 explicit defer explains without creating or grading a formal question', async t => {
  for (const oldQuestion of [false, true]) await t.test(oldQuestion ? 'retains old question' : 'no question', async t => {
    let grades = 0;
    const f = await fixture(t, undefined, async input => { grades++; return mastered(input); });
    if (oldQuestion) await prepareLesson(t, f);
    const previous = structuredClone((await f.load()).study.teaching_question ?? null);
    scriptedTurn(t, async runtime => {
      if (oldQuestion) await interpret(runtime, 'explain');
      await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply',
        { kind: 'answer', text: '先解释：input 从调用参数传入。', question_policy: 'defer' });
    });
    const result = (await f.service.run({ ...f.base, content: '开始当前步骤，先讲解，暂时不要出题。' }))!;
    assert.equal(result.assistant_message.error, null);
    assert.match(result.assistant_message.content, /input 从调用参数传入/);
    assert.equal(result.assistant_message.teaching_question, undefined);
    assert.deepEqual((await f.load()).study.teaching_question ?? null, previous);
    assert.equal(grades, 0);
    assert.equal((await f.load()).study.step_passed, null);
  });
});

test('TA25 cancellation during submission preflight or final assessment review cannot commit and releases the turn', async t => {
  for (const kind of ['assessment', 'lesson', 'skip'] as const) await t.test(kind, async t => {
  const controller = new AbortController();
  let submitted = false;
  let sawAbort = false;
  const f = await fixture(t, undefined, mastered, async input => {
    assert.equal(submitted, true, 'cancellation is injected after submission begins, inside the actual review stage');
    controller.abort('cancelled');
    sawAbort = input.signal!.aborted;
    return unavailableEvidenceReview('cancelled');
  });
  await prepareLesson(t, f);
  const baseline = structuredClone((await f.load()).study);
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    submitted = true;
    if (kind === 'assessment') {
      await interpret(runtime);
      await tool('assess_understanding').execute('grade', { question_id: baseline.teaching_question!.question_id });
      await tool('propose_learning_action').execute('advance', { action: 'advance_learning_step', advance_mode: 'complete' });
      await tool('submit_conversation_reply').execute('reply', { kind: 'action', text: '' }, runtime.signal);
    } else if (kind === 'lesson') {
      await interpret(runtime, 'replace');
      await tool('get_learning_context').execute('context', {});
      await tool('submit_conversation_reply').execute('reply', { kind: 'lesson', text: '入口接收 input。',
        question: { prompt: steps[0]!.completion_check, target_items: [steps[0]!.completion_check], evidence_ids: ['evidence:input'] } }, runtime.signal);
    } else {
      await interpret(runtime, [{ kind: 'control', text: '跳过这一步，' }, { kind: 'explain', text: '同时解释实现。' }]);
      await proposeSkip(runtime);
      await tool('submit_conversation_reply').execute('reply', { kind: 'action', text: '', supplement: '入口接收 input。' }, runtime.signal);
    }
  });
  try { await f.service.run({ ...f.base, content: kind === 'assessment' ? 'input 是参数。' : kind === 'lesson' ? '请换一道题。' : '跳过这一步，同时解释实现。',
    signal: controller.signal, reviewEvidence: true }); }
  catch (error) { assert.ok(controller.signal.aborted, String(error)); }
  assert.equal(sawAbort, true);
  assert.deepEqual((await f.load()).study, baseline);
  assert.equal((await f.load()).messages.at(-1)!.learning_action ?? null, null);
  scriptedTurn(t, async runtime => {
    await interpret(runtime, 'explain');
    await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('recovered', { kind: 'answer', text: '恢复后的解释。' });
  });
  assert.ok(await f.service.run({ ...f.base, content: '恢复后的普通问题。' }));
  });
});

test('TA26 trace failure after a saved skip proposal retains its card and confirmed replay never advances twice', async t => {
  const f = await fixture(t); mockTurn(t, true);
  let confirmed = false;
  t.mock.method(f.store, 'saveTrace', async () => {
    assert.equal((await f.load()).study.current_step, confirmed ? 1 : 0, 'trace failure cannot undo persisted proposal or execution');
    assert.equal((await f.load()).messages.at(-1)!.learning_action!.status, confirmed ? 'executed' : 'pending');
    throw new Error('controlled trace failure after commit');
  });
  const first = (await f.service.run({ ...f.base, content: '直接进入下一步' }))!;
  assert.equal(first.assistant_message.error, null);
  assert.equal(first.assistant_message.learning_action!.status, 'pending');
  confirmed = true;
  await confirmSkip(f, first);
  t.mock.method(PiConversationRuntime.prototype, 'run', async () => { assert.fail('replay must not call runtime'); });
  const replay = (await f.service.run({ ...f.base, content: first.user_message.content, replaceMessageId: first.user_message.message_id }))!;
  assert.equal((await f.load()).study.current_step, 1);
  assert.equal(replay.assistant_message.content_parts!.body, first.assistant_message.content_parts!.body);
  assert.equal((await f.load()).messages.filter(message => message.role === 'user').length, 1);
});

test('TA16 even an erroneous controlled skip proposal on ambiguous continue cannot advance without confirmation', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const result = (await f.service.run({ ...f.base, content: '继续' }))!;
  assert.equal((await f.load()).study.current_step, 0);
  assert.deepEqual((await f.load()).study.skipped_steps, []);
  assert.equal(result.user_message.learning_action_result, undefined);
});

test('TA17 normal confirmation on the last step ends the route without changing earlier skips to mastery', async t => {
  const f = await fixture(t, undefined, mastered);
  f.project.study.dynamic_learning_plan = [structuredClone(steps[0]!)];
  f.project.study.total_steps = 1;
  f.project.study.skipped_steps = ['earlier:skipped'];
  await prepareLesson(t, f);
  const answer = await gradeTurn(t, f, 'input 是参数。', { card: true });
  const done = await f.service.resolveLearningAction({ ...f.base, actionId: answer.assistant_message.learning_action!.action_id, decision: 'confirm' });
  assert.equal(done.project.study.phase, 'completed');
  assert.equal(done.project.study.current_step, 1);
  assert.deepEqual(done.project.study.skipped_steps, ['earlier:skipped']);
  assert.equal(done.action.outcome!.next_step_id, null);
  assert.doesNotMatch(done.action.description, /可以开始学习|确认后/);
  assert.equal(done.project.study.teaching_question, null);
});

test('TA21 question citations stay inside their own narrow packet despite a globally exposed wide packet', async t => {
  for (const outside of [false, true]) await t.test(outside ? 'out-of-bound exact reference cannot activate' : 'bare path cannot borrow wider context', async t => {
    const reviewed: Parameters<typeof reviewAnswerEvidence>[0][] = [];
    const f = await fixture(t, undefined, mastered, async input => { reviewed.push(input); return supportedReview(input); });
    const narrow = { stable_id: 'evidence:narrow', label: 'src/entry.ts', path: 'src/entry.ts', start_line: 2, end_line: 2, kind: 'symbol' };
    const wide = { ...narrow, stable_id: 'evidence:wide', start_line: 1, end_line: 3 };
    const bound = structuredClone(snapshot);
    bound.graph.layers.push({ id: 'layer:entry', name: 'Entry', responsibility: 'Input', component_ids: [], certainty: 'verified', evidence: [wide, narrow] });
    await f.store.saveSnapshot(f.project.project_id, bound);
    f.project.study.dynamic_learning_plan![0]!.learning_targets = ['Input'];
    f.project.study.dynamic_learning_plan![0]!.evidence_refs = [wide.stable_id, narrow.stable_id];
    await f.store.saveProject(f.project);
    t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
    t.mock.method(f.store, 'readSourceLines', async (_projectId: string, _snapshotId: string, _path: string, start: number, end: number) => ({
      lines: ['export function entry(input) {', '  return input;', '}'].slice(start - 1, end), truncated: false }));
    const prompt = outside ? 'Explain `src/entry.ts:1-3`.' : 'Explain `src/entry.ts`.';
    scriptedTurn(t, async runtime => {
      const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
      await tool('get_learning_context').execute('global-wide-and-narrow', {});
      await tool('submit_conversation_reply').execute('lesson', { kind: 'lesson', text: '本次只检查已绑定的单行。',
        question: { prompt, target_items: ['Input'], evidence_ids: [narrow.stable_id] } });
    });
    const result = (await f.service.run({ ...f.base, content: '开始当前步骤', reviewEvidence: true }))!;
    if (outside) {
      assert.equal(result.assistant_message.teaching_question, undefined);
      assert.equal((await f.load()).study.teaching_question ?? null, null);
    } else {
      assert.ok(result.assistant_message.teaching_question, JSON.stringify(result.assistant_message.content_parts));
      const questionReview = reviewed.find(review => review.text.includes(prompt));
      assert.ok(questionReview);
      assert.deepEqual(questionReview.evidence.map(row => [row.start_line, row.end_line]), [[2, 2]]);
      assert.deepEqual(result.assistant_message.teaching_question.evidence.map(row => [row.start_line, row.end_line]), [[2, 2]]);
    }
  });
});

function useFauxRuntime(t: TestContext, provider: string) {
  const faux = fauxProvider({ provider });
  const models = createModels(); models.setProvider(faux.provider);
  t.mock.method(PiConversationRuntime.prototype, 'run', function(this: PiConversationRuntime, options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) {
    return realRuntimeRun.call(this, { ...options, modelRuntime: { models, model: faux.getModel() as Model<Api> } }, finalize);
  });
  return faux;
}

test('R5 mixed schema and evidence failures share three submissions; optional expansion can be removed without losing grading', async t => {
  const marker = 'R5_REJECTED_SELF_INITIATED_EXPANSION';
  const answer = '补上 off 部分：不传 handler 时，会把 foo 键对应的值换成一个新的空数组，所以 all.get("foo") 是 []，all.has("foo") 仍然为 true，并没有删除键。';
  const reviews: string[] = [];
  const f = await fixture(t, undefined, async input => {
    assert.equal(input.answer, answer);
    assert.deepEqual(input.answerParts, [answer]);
    return mastered(input);
  }, async input => {
    reviews.push(input.text);
    return input.text.includes(marker) ? { ...await supportedReview(input), supported: false,
      issues: [{ claim: input.text, reason: 'Controlled unsupported expansion.', kind: 'insufficient_evidence' }] } : supportedReview(input);
  });
  const lesson = await prepareLesson(t, f);
  const before = (await f.load()).study.teaching_question!;
  t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
  const control = '先留在这一步。';
  const original = answer + control;
  const faux = useFauxRuntime(t, 'r5-mixed-submission-budget');
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('interpret_teaching_turn', { parts: [{ kind: 'answer', text: answer }, { kind: 'control', text: control }] })),
    fauxAssistantMessage(fauxToolCall('assess_understanding', { question_id: lesson.assistant_message.teaching_question!.question_id })),
    fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'assessment', supplement: marker + '，见 `src/entry.ts:1`。' })),
    fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'assessment', text: { invalid: true } })),
    context => {
      assert.match(JSON.stringify(context.messages), /Submission budget|Repair details/);
      return fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'assessment' }));
    },
  ]);
  const result = (await f.service.run({ ...f.base, content: original, reviewEvidence: true }))!;
  assert.equal(result.error, undefined);
  assert.match(result.assistant_message.content, /回答正确.*input/s);
  assert.doesNotMatch(result.assistant_message.content, new RegExp(marker));
  assert.equal(result.assistant_message.learning_action ?? null, null);
  assert.equal(result.assistant_message.context_eligible, true);
  const saved = await f.load();
  assert.equal(saved.messages.filter(row => row.role === 'user' && row.content === original).length, 1);
  assert.equal(saved.study.current_step, 0);
  assert.equal(saved.study.latest_assessment!.verdict, 'mastered');
  assert.equal(saved.study.teaching_question!.question_id, before.question_id);
  assert.equal(saved.study.teaching_question!.answer_attempts!.length, 1);
  assert.ok(saved.study.mastered_target_items!.length > 0);
  assert.ok(reviews.some(text => text.includes(marker)));
  const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
  assert.deepEqual(trace.submission_diagnostics.filter((row: { code: string }) => row.code !== 'optional_expansion_omitted')
    .map((row: { attempt: number }) => row.attempt), [1, 2]);
  assert.deepEqual(trace.submission_budget, { used: 3, limit: 3 });
  assert.ok(trace.submission_diagnostics.some((row: { code: string; attempt: number }) => row.code === 'optional_expansion_omitted' && row.attempt === 3));
  faux.setResponses([context => {
    assert.doesNotMatch(JSON.stringify(context.messages), new RegExp(marker));
    assert.match(JSON.stringify(context.messages), /回答正确/);
    return fauxAssistantMessage(fauxToolCall('interpret_teaching_turn', { parts: [{ kind: 'explain', text: '接下来看看参数。' }] }));
  }, fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'answer', text: '参数来自调用方。' }))]);
  await f.service.run({ ...f.base, content: '接下来看看参数。' });
});

test('R5 schema then evidence failure reaches the third final gate, retaining valid grading without an action or fourth review', async t => {
  const marker = 'R5_REQUIRED_FOLLOW_UP';
  let explanationReviews = 0;
  const f = await fixture(t, undefined, mastered, async input => {
    if (!input.text.includes(marker)) return supportedReview(input);
    explanationReviews++;
    return { ...await supportedReview(input), supported: false,
      issues: [{ claim: input.text, reason: 'Controlled unresolved follow-up.', kind: 'insufficient_evidence' }] };
  });
  const lesson = await prepareLesson(t, f);
  t.mock.method(f.store, 'listSourceFiles', async () => ['src/entry.ts']);
  const answer = 'input 是参数。';
  const followUp = '另外解释 input 的来源。';
  const faux = useFauxRuntime(t, 'r5-final-submission-boundary');
  const candidate = { kind: 'action', supplement: marker + '，见 `src/entry.ts:1`。' };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('interpret_teaching_turn', { parts: [{ kind: 'answer', text: answer }, { kind: 'explain', text: followUp }] })),
    fauxAssistantMessage(fauxToolCall('assess_understanding', { question_id: lesson.assistant_message.teaching_question!.question_id })),
    fauxAssistantMessage(fauxToolCall('propose_learning_action', { action: 'advance_learning_step', advance_mode: 'complete' })),
    fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { ...candidate, text: { invalid: true } })),
    fauxAssistantMessage(fauxToolCall('submit_conversation_reply', candidate)),
    fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { ...candidate, supplement: candidate.supplement + '修订仍待核对。' })),
  ]);
  const result = (await f.service.run({ ...f.base, content: answer + followUp, reviewEvidence: true }))!;
  assert.equal(explanationReviews, 2, 'schema refusal consumes an attempt but performs no semantic review; final gate reuses attempt three');
  assert.match(result.assistant_message.content, /回答正确/);
  assert.match(result.assistant_message.content, /证据不足/);
  assert.equal(result.assistant_message.content_parts!.evidence_blocks!.find(row => row.kind === 'assessment')!.commit_eligible, true);
  assert.equal(result.assistant_message.content_parts!.evidence_blocks!.find(row => row.kind === 'explanation')!.commit_eligible, false);
  assert.equal(result.assistant_message.context_eligible, false);
  assert.equal(result.assistant_message.learning_action ?? null, null);
  const saved = await f.load();
  assert.equal(saved.study.current_step, 0);
  assert.equal(saved.study.latest_assessment!.verdict, 'mastered');
  assert.ok(saved.study.mastered_target_items!.length > 0);
  assert.equal(faux.state.callCount, 6, 'no fourth submission is requested');
  faux.setResponses([context => {
    assert.doesNotMatch(JSON.stringify(context.messages), new RegExp(marker));
    return fauxAssistantMessage(fauxToolCall('interpret_teaching_turn', { parts: [{ kind: 'explain', text: '重新解释来源。' }] }));
  }, fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'answer', text: '参数来自调用方。' }))]);
  await f.service.run({ ...f.base, content: '重新解释来源。' });
});

test('R5 requested explanation and conservative other segments cannot be discarded after a failed supplement', async t => {
  for (const kind of ['explain', 'other'] as const) await t.test(kind, async t => {
    const f = await fixture(t, undefined, mastered, async input => input.text.includes('FAILED_FOLLOW_UP')
      ? { ...await supportedReview(input), supported: false, issues: [{ claim: input.text, reason: 'Controlled unsupported reply.', kind: 'insufficient_evidence' }] }
      : supportedReview(input));
    const lesson = await prepareLesson(t, f);
    const answer = 'input 是参数。'; const request = '解释它的来源。';
    scriptedTurn(t, async runtime => {
      const tool = (name: string) => runtime.tools.find(row => row.name === name)!;
      await interpret(runtime, [{ kind: 'answer', text: answer }, { kind, text: request }]);
      await tool('assess_understanding').execute('grade', { question_id: lesson.assistant_message.teaching_question!.question_id });
      await assert.rejects(tool('submit_conversation_reply').execute('bad', { kind: 'assessment', supplement: 'FAILED_FOLLOW_UP，见 `src/entry.ts:1`。' }), { code: 'reply_evidence_repair_required' });
      await assert.rejects(tool('submit_conversation_reply').execute('drop', { kind: 'assessment' }), /do not discard|independent|requested/i);
      await tool('submit_conversation_reply').execute('abandon', { kind: 'unavailable' });
    }, '模型草稿', 'completed', false);
    const result = (await f.service.run({ ...f.base, content: answer + request, reviewEvidence: true }))!;
    assert.equal(result.assistant_message.learning_action ?? null, null);
    assert.equal((await f.load()).study.latest_assessment ?? null, null);
  });
});

test('R5 original route requests retain their target and can drop a sixteen-packet self-initiated expansion in the same turn', async t => {
  const requests = [
    '我想系统学习 mitt，请为我安排三步短路线：第一步理解 on 和 off，第二步理解 emit 的数组复制，第三步理解公开类型。每步先简短讲解，再让我回答问题。',
    '我现在想开始学习，请先给出学习路线的确认入口，不用先展开三个主题的详细解释。',
  ];
  for (const original of requests) await t.test(original, async t => {
    let routeCalls = 0; let reviews = 0;
    const f = await fixture(t, async () => { routeCalls++; return routeResult(); }, undefined,
      async input => { if (input.text.includes('R5_ROUTE_REJECTED_EXPANSION')) reviews++; return supportedReview(input); });
    const evidence = await exposeRepairSources(t, f, 16);
    const references = evidence.map(row => '`' + row.path + ':1`').join('、');
    const marker = 'R5_ROUTE_REJECTED_EXPANSION';
    const faux = useFauxRuntime(t, 'r5-route-without-rewrite');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('interpret_teaching_turn', { parts: [{ kind: 'control', text: original }] })),
      fauxAssistantMessage(fauxToolCall('propose_learning_action', { action: 'start_learning_route', target_kind: 'repository' })),
      fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'action', supplement: marker + references })),
      context => {
        assert.match(JSON.stringify(context.messages), /budget_exceeded|packet/i);
        assert.ok(JSON.stringify(context.messages).includes(original));
        return fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { kind: 'action' }));
      },
    ]);
    const result = (await f.service.run({ ...f.base, content: original, reviewEvidence: true }))!;
    assert.equal(result.error, undefined);
    assert.equal(result.user_message.content, original);
    assert.equal(result.assistant_message.learning_action!.action, 'start_learning_route');
    assert.equal(result.assistant_message.learning_action!.target!.kind, 'repository');
    assert.equal(result.assistant_message.learning_action!.status, 'pending');
    assert.doesNotMatch(result.assistant_message.content, /R5_ROUTE_REJECTED_EXPANSION|验证与持续集成|repair\d+\.ts/);
    assert.equal(routeCalls, 0, 'only proposal is prepared before confirmation');
    assert.equal(reviews, 0, 'sixteen packets retain deterministic overflow without spending a semantic review');
    assert.equal((await f.load()).messages.filter(row => row.role === 'user').length, 1);
    const trace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
    assert.equal(trace.submission_diagnostics[0].code, 'reply_evidence_repair_required');
    assert.ok(trace.evidence_preflight.some((row: { packet_count?: number; coverage_reasons?: string[] }) => row.packet_count === 16 && row.coverage_reasons?.includes('budget_exceeded')));
  });
});


test('TA19 an edited original whose assessment fails cannot retain effective proof caches from the old text', async t => {
  let failed = false;
  let calls = 0;
  const f = await fixture(t, undefined, async input => {
    calls++;
    const result = await mastered(input);
    return failed ? { ...result, completed: false, verdict: null, feedback: null, reviewContext: null,
      trace: { ...result.trace, completed: false, stop_reason: 'assessment_validation_failed' } } : result;
  });
  await prepareLesson(t, f);
  const established = await gradeTurn(t, f, 'input 是参数。');
  const prior = await f.load();
  assert.ok(prior.study.step_passed);
  const questionId = prior.study.teaching_question!.question_id;
  failed = true;
  scriptedTurn(t, async runtime => {
    const tool = (name: string) => runtime.tools.find(tool => tool.name === name)!;
    await interpret(runtime);
    await assert.rejects(tool('assess_understanding').execute('failed', { question_id: questionId }), /reliable result/);
    await assert.rejects(tool('assess_understanding').execute('resample', { question_id: questionId }), /attempt.*locked/);
    await tool('submit_conversation_reply').execute('unavailable', { kind: 'unavailable' });
  });
  const response = (await f.service.run({ ...f.base, content: '修改后我还不会解释。', replaceMessageId: established.user_message.message_id }))!;
  const saved = await f.load();
  assert.equal(calls, 2, 'one established assessment and one failed edit, with no same-turn resampling');
  assert.equal(response.user_message.message_id, established.user_message.message_id);
  assert.equal(saved.study.current_step, prior.study.current_step);
  assert.equal(saved.study.step_passed, null);
  assert.deepEqual(saved.study.mastered_target_items, []);
  assert.deepEqual(saved.study.mastered_target_evidence, {});
  assert.deepEqual(saved.study.target_assessments, prior.study.target_assessments, 'historical records remain but their old source hash has no authority');
  assert.equal(response.assistant_message.learning_action ?? null, null);
  assert.match(response.assistant_message.content, /尚未完成/);
  scriptedTurn(t, async runtime => {
    const result = await runtime.tools.find(tool => tool.name === 'get_learning_context')!.execute('inspect', {});
    assert.equal(toolPayload(result).study.step_passed, null);
    await interpret(runtime, 'explain');
    await runtime.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'answer', text: '可以继续回答原题。' });
  });
  await f.service.run({ ...f.base, content: '现在进度如何？' });
  assert.equal((await f.load()).study.step_passed, null);
});

test('skip mode is required and a pending skip preserves independent content on decline or expiry', async t => {
  for (const decision of ['decline', 'expire'] as const) await t.test(decision, async t => {
    const f = await fixture(t);
    scriptedTurn(t, async options => {
      await interpret(options, 'control');
      await assert.rejects(options.tools.find(tool => tool.name === 'propose_learning_action')!.execute('missing-mode', { action: 'advance_learning_step' }));
      await proposeSkip(options);
      await options.tools.find(tool => tool.name === 'submit_conversation_reply')!.execute('reply', { kind: 'action', text: '', supplement: '独立解释保留。' });
    });
    const first = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
    const body = first.assistant_message.content_parts!.body;
    const blocks = first.assistant_message.content_parts!.evidence_blocks;
    if (decision === 'expire') await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, row => { row.study.route_revision = (row.study.route_revision ?? 0) + 1; });
    const resolved = await f.service.resolveLearningAction({ ...f.base, actionId: first.assistant_message.learning_action!.action_id, decision: decision === 'decline' ? 'decline' : 'confirm' });
    assert.equal(resolved.action.status, decision === 'decline' ? 'declined' : 'expired');
    assert.equal(resolved.project.study.current_step, 0);
    assert.deepEqual(resolved.project.study.skipped_steps, []);
    const receipt = resolved.project.messages.find(message => message.message_id === first.assistant_message.message_id)!;
    assert.equal(receipt.content_parts!.body, body);
    assert.deepEqual(receipt.content_parts!.evidence_blocks, blocks);
    assert.equal(resolved.project.messages.find(message => message.message_id === first.user_message.message_id)!.learning_action_result, undefined);
  });
});

test('TA26 skip confirmation commits once across faults before and after atomic persistence', async t => {
  for (const boundary of ['before', 'after'] as const) await t.test(boundary, async t => {
    const f = await fixture(t); mockTurn(t, true);
    const first = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
    const actionId = first.assistant_message.learning_action!.action_id;
    const original = f.store.updateProject.bind(f.store);
    let fault = true;
    t.mock.method(f.store, 'updateProject', async (...args: Parameters<typeof original>) => {
      if (fault && boundary === 'before') { fault = false; throw Error('controlled fault before confirmation commit'); }
      const saved = await original(...args);
      if (fault && boundary === 'after') { fault = false; throw Error('controlled fault after confirmation commit'); }
      return saved;
    });
    await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId, decision: 'confirm' }), /controlled fault/);
    assert.equal((await f.load()).study.current_step, boundary === 'before' ? 0 : 1);
    const retry = await f.service.resolveLearningAction({ ...f.base, actionId, decision: 'confirm' });
    assert.equal(retry.project.study.current_step, 1);
    assert.deepEqual(retry.project.study.skipped_steps, ['step:1']);
    assert.deepEqual(retry.project.study.mastered, []);
    assert.equal(retry.state_changed, boundary === 'before');
    t.mock.method(PiConversationRuntime.prototype, 'run', async () => { assert.fail('committed skip replay must not run a model'); });
    const replay = (await f.service.run({ ...f.base, content: first.user_message.content, replaceMessageId: first.user_message.message_id }))!;
    assert.equal((await f.load()).study.current_step, 1);
    assert.equal(replay.assistant_message.content_parts!.body, first.assistant_message.content_parts!.body);
    assert.equal((await f.load()).messages.filter(message => message.role === 'user').length, 1);
  });
});

test('cancelled skip confirmation retains its pending card and never advances', async t => {
  const f = await fixture(t); mockTurn(t, true);
  const first = (await f.service.run({ ...f.base, content: '跳过这一步' }))!;
  const controller = new AbortController(); controller.abort('cancelled');
  await assert.rejects(f.service.resolveLearningAction({ ...f.base, actionId: first.assistant_message.learning_action!.action_id,
    decision: 'confirm', signal: controller.signal }));
  const saved = await f.load();
  assert.equal(saved.study.current_step, 0);
  assert.deepEqual(saved.study.skipped_steps, []);
  assert.equal(saved.messages.at(-1)!.learning_action!.status, 'pending');
  assert.equal(saved.messages[0]!.learning_action_result, undefined);
  await confirmSkip(f, first);
  assert.equal((await f.load()).study.current_step, 1);
});
