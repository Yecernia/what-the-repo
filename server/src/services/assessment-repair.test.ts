import { assessmentTestReviewContext } from '../agent/assessment-test-context.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMessage, createProject } from '../domain/conversation.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import type { ServerConfig } from '../config.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { PiConversationRuntime } from '../agent/runtime.js';
import { MemoryMaintenance } from '../agent/memory-maintenance.js';
import { FeedbackAnalysisWorker } from '../agent/feedback.js';
import type { PiAgentRunOptions, PiRunFinalization, PiRunResult } from '../agent/types.js';
import type { runUnderstandingAssessment } from '../agent/teaching-workers.js';
import { unavailableEvidenceReview, type reviewAnswerEvidence } from '../agent/citation-review.js';
import { assessmentFeedbackScope, priorTargetCoverageForAssessment } from '../agent/target-coverage.js';
import type { TeachingQuestionResult, TeachingTargetResult } from '../agent/teaching-question.js';
import { ConversationService } from './conversation-service.js';

// Predetermined owner/reviewer outputs test orchestration only, not model semantics.
const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const trace = { worker_run_id: 'worker:controlled', skill_id: 'understanding-assessment', skill_version: 'test',
  stop_reason: 'completed', completed: true, usage, evidence_ids: [], state_candidate: false };
const evidence = ['on', 'off', 'next'].map(name => ({ stable_id: `evidence:${name}`, label: `src/${name}.ts`,
  path: `src/${name}.ts`, start_line: 1, end_line: 3, kind: 'symbol' }));
const step = { step_id: 'step:repair', order: 1, title: 'Registration', objective: 'Understand registration',
  learning_targets: ['On', 'Off', 'Factory'], completion_check: 'Explain On and Off.', component_ids: [], evidence_refs: evidence.map(e => e.stable_id) };
const snapshot: EvidenceSnapshot = { snapshot_id: 'snapshot:repair',
  summary: { file_count: 3, symbol_count: 3, call_count: 0, component_count: 0 },
  graph: { semantic_mode: 'provider_supported', nodes: [], edges: [], layers: [{ id: 'layer:repair', name: 'Registration',
    responsibility: 'Registration', component_ids: [], certainty: 'verified', evidence }], unassigned_component_ids: [] },
  languages: [], value_points: [], learning_plan: { snapshot_id: 'snapshot:repair', selected_value_point: null, steps: [] } };
const supported: typeof reviewAnswerEvidence = async input => ({ ...unavailableEvidenceReview(), status: 'reviewed',
  supported: true, completed: true, summary: 'Controlled support.', acceptedEvidenceIds: input.evidence.map(e => e.stable_id) });

function scripted(t: TestContext, body: (options: PiAgentRunOptions) => Promise<void>) {
  t.mock.method(PiConversationRuntime.prototype, 'run', async (options: PiAgentRunOptions,
    finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) => {
    await options.beforePrompt?.(options.signal);
    await body(options);
    return (await finalize({ runId: options.runId, text: 'Controlled draft', stopReason: 'completed', usage, events: [] })).value;
  });
}
const tool = (o: PiAgentRunOptions, name: string) => o.tools.find(t => t.name === name)!;
async function interpret(o: PiAgentRunOptions, answer: string, request = '') {
  await tool(o, 'interpret_teaching_turn').execute('interpret', { parts: [{ kind: 'answer', text: answer },
    ...(request ? [{ kind: 'replace', text: request }] : [])] });
}

function grade(input: Parameters<typeof runUnderstandingAssessment>[0], initial = false) {
  const boundStep = input.project.study.dynamic_learning_plan![0]!;
  const targetResults: TeachingTargetResult[] = input.question.target_ids!.map((target_id, i) => ({ target_id,
    outcome: initial ? i === 0 ? 'proven' : 'unproven' : i === 0 ? 'not_addressed' : 'proven',
    reason: 'Controlled current-answer result.', answer_spans: initial ? i === 0 ? [input.answer] : [] : i === 0 ? [] : [input.answer],
    evidence_ids: initial ? i === 0 ? ['evidence:on'] : [] : i === 0 ? [] : ['evidence:off'] }));
  const prior = input.project.study.target_assessments?.find(r => r.question_id === input.question.question_id)?.message_id;
  const questionResult: TeachingQuestionResult = { complete: !initial, requirements: input.question.target_ids!.map((id, i) => ({
    prompt_span: input.question.prompt, target_ids: [id], outcome: initial && i === 1 ? 'missing' : 'satisfied',
    answer_spans: initial ? i === 0 ? [input.answer] : [] : i === 0 ? [] : [input.answer],
    prior_answer_message_ids: !initial && i === 0 && prior ? [prior] : [],
    evidence_ids: initial && i === 1 ? [] : [i === 0 ? 'evidence:on' : 'evidence:off'], reason: 'Controlled prompt requirement.' })) };
  const feedbackScope = assessmentFeedbackScope(priorTargetCoverageForAssessment(input.project, input.question, boundStep, input.sourceMessageId),
    input.question, targetResults, questionResult);
  return { completed: true, answerRelevant: true, feedback: initial ? 'On is correct; Off remains.' : 'Off is correct. UNSUPPORTED_ON_FACTORY_DETAIL',
    verdict: initial ? 'partial' : 'mastered', masteredItems: initial ? ['On'] : ['Off'], misconceptions: [],
    acceptedEvidenceIds: initial ? ['evidence:on'] : ['evidence:off'], targetResults, feedbackScope, questionResult,
    reviewContext: assessmentTestReviewContext(input, { targetResults, questionResult }), trace };
}

async function fixture(t: TestContext, assess: typeof runUnderstandingAssessment, reviewEvidence: typeof reviewAnswerEvidence,
  oldPrompt = 'Explain On and Off.') {
  const root = await mkdtemp(join(tmpdir(), 'wtr-assessment-repair-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = new FileStore(root); await store.init();
  const project = createProject('guest:repair', 'https://github.com/example/repair', 'Repair', 'free:deepseek-chat');
  project.analysis.snapshot_id = snapshot.snapshot_id; project.analysis.stage = 'done';
  project.study = { ...project.study, snapshot_id: snapshot.snapshot_id, phase: 'explaining', current_step: 0, total_steps: 1,
    route_revision: 0, dynamic_learning_plan: [structuredClone(step)] };
  await store.saveProject(project); await store.saveSnapshot(project.project_id, snapshot);
  t.mock.method(MemoryMaintenance.prototype, 'schedule', () => {});
  t.mock.method(FeedbackAnalysisWorker.prototype, 'schedule', () => {});
  t.mock.method(store, 'readSourceLines', async () => ({ lines: ['function entry(input) {', '  return input;', '}'], truncated: false }));
  const config = { root, dataDir: root, nodeEnv: 'test', sessionSecret: 'test-only', keyEncryptionSecret: 'test-only',
    freeProviderBaseUrl: 'https://api.deepseek.com', freeProviderModel: 'deepseek-chat', freeProviderApiKey: 'never-used' } as ServerConfig;
  const service = new ConversationService(config, store, new PiSessionStore(join(root, 'sessions')), new PiMemoryStore(join(root, 'memory')),
    undefined, undefined, undefined, undefined, { assess, reviewEvidence,
      reviewReplyContent: async () => ({ completed: true, findings: [], trace: { ...trace, skill_id: 'reply-content-review' } }) });
  const base = { owner: { owner_id: project.owner_id, kind: 'guest' as const }, projectId: project.project_id };
  const load = async () => (await store.loadProject(project.project_id, project.owner_id))!;
  scripted(t, async o => {
    await tool(o, 'get_learning_context').execute('context', {});
    await tool(o, 'submit_conversation_reply').execute('old-question', { kind: 'lesson', text: 'Registration.',
      question: { prompt: oldPrompt, target_items: ['On', 'Off'], evidence_ids: ['evidence:on', 'evidence:off'] } });
  });
  const old = (await service.run({ ...base, content: '开始当前步骤' }))!.assistant_message.teaching_question!;
  scripted(t, async o => {
    await interpret(o, 'On answer.');
    await tool(o, 'assess_understanding').execute('prior', { question_id: old.question_id });
    await tool(o, 'submit_conversation_reply').execute('save-prior', { kind: 'assessment' });
  });
  await service.run({ ...base, content: 'On answer.', reviewEvidence: true });
  assert.equal((await load()).study.target_assessments!.length, 1);
  return { root, store, service, base, load, old };
}

test('assessment feedback retains the original question packets without expanding partial learner proof', async t => {
  const ownerInputs: Parameters<typeof runUnderstandingAssessment>[0][] = [];
  const assessmentReviews: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  const f = await fixture(t, async input => {
    ownerInputs.push(input);
    assert.deepEqual(input.evidence.map(row => row.stable_id).sort(), ['evidence:off', 'evidence:on']);
    assert.equal(input.feedbackRepair, undefined);
    return { ...grade(input, true), feedback: 'On is correct. Off is not answered; its implementation removes a handler from the registered list.' };
  }, async input => {
    if (input.purpose === 'assessment') {
      assessmentReviews.push(input);
      assert.deepEqual(input.evidence.map(row => [row.stable_id, row.path, row.start_line, row.end_line]),
        [evidence[1]!, evidence[0]!].map(row => [row.stable_id, row.path, row.start_line, row.end_line]));
      assert.ok(!input.evidence.some(row => row.stable_id === 'evidence:next'), 'globally exposed Factory evidence cannot enter the assessment block');
      assert.match(input.text, /Off is not answered/);
      assert.equal(input.assessmentContext!.question_result!.complete, false);
    }
    return supported(input);
  });
  const saved = await f.load();
  assert.equal(ownerInputs.length, 1);
  assert.equal(assessmentReviews.length, 1, 'finalization reuses the exact preflight review');
  const record = saved.study.target_assessments![0]!;
  assert.equal(saved.study.target_assessments!.length, 1);
  assert.deepEqual(record.results.filter(result => result.outcome === 'proven').map(result => result.evidence_ids), [['evidence:on']]);
  assert.equal(record.results[1]!.outcome, 'unproven');
  assert.deepEqual(record.results[1]!.evidence_ids, []);
  assert.equal(record.question_result!.complete, false);
  assert.equal(record.question_result!.requirements[1]!.outcome, 'missing');
  assert.deepEqual(record.question_result!.requirements.flatMap(requirement => requirement.evidence_ids), ['evidence:on']);
  assert.equal(saved.study.current_step, 0);
  assert.equal(saved.study.step_passed ?? null, null);
  assert.equal(saved.study.teaching_question!.question_id, f.old.question_id);
  assert.equal(saved.study.latest_assessment!.step_completed, false);
  assert.equal(saved.messages.at(-1)!.learning_action ?? null, null);
});

for (const mode of ['success', 'changed-judgment', 'borrowed-next-evidence', 'still-unsupported'] as const) test(`R6 assessment evidence owner repair: ${mode}`, async t => {
  const assessments: Parameters<typeof runUnderstandingAssessment>[0][] = [];
  const reviews: Parameters<typeof reviewAnswerEvidence>[0][] = [];
  let recover = false;
  const f = await fixture(t, async input => {
    assessments.push(input);
    const result = grade(input, input.answer === 'On answer.');
    if (recover) return { ...result, feedback: 'Off is correct; prior proof is retained.' };
    if (!input.feedbackRepair) return result;
    assert.deepEqual(input.feedbackRepair.evidenceIds, ['evidence:off']);
    assert.deepEqual(input.feedbackRepair.targetResults, result.targetResults);
    assert.deepEqual(input.feedbackRepair.questionResult, result.questionResult);
    assert.equal(input.feedbackRepair.verdict, 'mastered');
    assert.ok(input.feedbackRepair.evidenceIssues!.some(issue => issue.claim === 'UNSUPPORTED_ON_FACTORY_DETAIL'));
    return { ...result, verdict: mode === 'changed-judgment' ? 'partial' : result.verdict,
      acceptedEvidenceIds: mode === 'borrowed-next-evidence' ? ['evidence:next'] : result.acceptedEvidenceIds,
      feedback: mode === 'still-unsupported' ? result.feedback : 'Off is correct. Prior On proof is retained; Factory is future work.' };
  }, async input => {
    reviews.push(input);
    if (input.purpose === 'assessment' && input.text.includes('UNSUPPORTED_ON_FACTORY_DETAIL')) return { ...await supported(input), supported: false,
      issues: [{ kind: 'insufficient_evidence', subject: 'assessment_feedback', claim: 'UNSUPPORTED_ON_FACTORY_DETAIL', reason: 'Controlled extraneous mechanism outside Off packets.' }] };
    return supported(input);
  });
  const baseline = structuredClone((await f.load()).study);
  const answer = 'Off answer.'; const request = ' Ask the remaining Factory question.';
  scripted(t, async o => {
    await interpret(o, answer, request);
    await tool(o, 'assess_understanding').execute('grade', { question_id: f.old.question_id });
    await tool(o, 'get_learning_context').execute('context', {});
    const candidate = { kind: 'lesson', text: 'Factory follows.', question: { prompt: 'Explain Factory.', target_items: ['Factory'], evidence_ids: ['evidence:next'] } };
    for (let i = 1; i <= (mode === 'success' ? 2 : 3); i++) {
      try { await tool(o, 'submit_conversation_reply').execute(`candidate:${i}`, candidate); break; }
      catch (error) { assert.equal((error as { code: string }).code, 'reply_evidence_repair_required'); }
    }
  });
  const result = (await f.service.run({ ...f.base, content: answer + request, reviewEvidence: true }))!;
  const saved = await f.load();
  const ownerRepairs = assessments.filter(a => a.feedbackRepair);
  assert.equal(ownerRepairs.length, 1);
  assert.equal(ownerRepairs[0]!.answer, answer);
  assert.equal(ownerRepairs[0]!.originalMessage, answer + request);
  const offInputs = assessments.filter(input => input.answer !== 'On answer.');
  assert.ok(offInputs.length >= 1);
  for (const input of offInputs) {
    assert.equal(input.project.study.target_assessments!.length, 1, 'immutable worker input contains only the previously accepted A ledger');
    assert.equal(input.question.answer_attempts!.length, 1, 'applying the B candidate cannot mutate the original worker question');
    assert.equal(input.project.study.teaching_question!.answer_attempts!.length, 1);
    assert.ok(!input.project.study.target_assessments!.some(record => record.message_id === input.sourceMessageId));
  }
  const assessmentReviews = reviews.filter(r => r.purpose === 'assessment' && r.text.includes('Off is correct'));
  assert.ok(assessmentReviews.length >= 1 && assessmentReviews.length <= 2);
  for (const input of assessmentReviews) {
    assert.deepEqual(input.evidence.map(e => e.stable_id).sort(), ['evidence:off', 'evidence:on']);
    assert.ok(!input.evidence.some(e => e.stable_id === 'evidence:next'), 'new-question packets cannot support the original assessment');
    assert.equal(input.assessmentContext!.registered_question.prompt, f.old.prompt);
    assert.equal(input.assessmentContext!.registered_question.question_id, f.old.question_id);
    assert.deepEqual(input.assessmentContext!.current_answer_parts, [answer]);
    assert.ok(input.assessmentContext!.prior_target_coverage.some(c => c.label === 'On' && c.proven));
    assert.doesNotMatch(JSON.stringify(input.assessmentContext), /Factory follows|Explain Factory|Ask the remaining/);
  }
  const runtimeTrace = JSON.parse(await readFile(join(f.root, 'traces', result.assistant_message.trace_id! + '.json'), 'utf8'));
  assert.match(runtimeTrace.assessment_review_failures[0].feedback, /UNSUPPORTED_ON_FACTORY_DETAIL/);
  assert.equal(runtimeTrace.assessment_review_failures[0].attempt, 1);
  assert.equal(runtimeTrace.assessment_review_failures[0].question_id, f.old.question_id);
  assert.equal(runtimeTrace.assessment_review_failures[0].review.issues[0].claim, 'UNSUPPORTED_ON_FACTORY_DETAIL');
  assert.ok(runtimeTrace.submission_budget.used <= 3);
  assert.equal(runtimeTrace.submission_budget.limit, 3);
  assert.equal(saved.study.current_step, 0);
  if (mode === 'success') {
    assert.deepEqual(runtimeTrace.submission_budget, { used: 2, limit: 3 });
    assert.equal(assessmentReviews.length, 2, 'finalization uses the already charged review cache');
    assert.equal(saved.study.target_assessments!.length, 2);
    assert.deepEqual(saved.study.target_assessments![0], baseline.target_assessments![0]);
    assert.equal(saved.study.teaching_question!.prompt, 'Explain Factory.');
    assert.equal(saved.messages.filter(m => m.teaching_question?.prompt === 'Explain Factory.').length, 1);
    const old = saved.messages.find(m => m.teaching_question?.question_id === f.old.question_id)!.teaching_question!;
    assert.equal(old.answer_attempts!.length, 2);
  } else {
    assert.deepEqual(runtimeTrace.submission_budget, { used: mode === 'still-unsupported' ? 2 : 1, limit: 3 });
    assert.equal(assessmentReviews.length, 1, 'unchanged failed assessment is cached through the final gate');
    assert.deepEqual(saved.study, baseline);
    assert.equal(result.assistant_message.teaching_question, undefined);
    assert.equal(result.assistant_message.context_eligible, false);
    assert.doesNotMatch(result.assistant_message.content, /Off is correct|UNSUPPORTED_ON_FACTORY_DETAIL|Explain Factory/);
    assert.match(result.assistant_message.content, /原题保留|原题仍然有效/);
    assert.match(result.assistant_message.content, /重试/);
    assert.equal(saved.study.teaching_question!.question_id, f.old.question_id);
    assert.equal(saved.messages.filter(m => m.role === 'user' && m.content === answer + request).length, 1);
    // Exercise the advertised retry against the retained original question and same user message.
    recover = true;
    const retry = (await f.service.run({ ...f.base, content: answer + request, reviewEvidence: true,
      replaceMessageId: result.user_message.message_id }))!;
    const recovered = await f.load();
    assert.equal(retry.user_message.message_id, result.user_message.message_id);
    assert.equal(recovered.messages.filter(m => m.role === 'user' && m.content === answer + request).length, 1);
    assert.equal(recovered.study.target_assessments!.length, 2);
    assert.deepEqual(recovered.study.target_assessments![0], baseline.target_assessments![0]);
    assert.equal(recovered.study.teaching_question!.prompt, 'Explain Factory.');
    assert.equal(recovered.messages.filter(m => m.teaching_question?.prompt === 'Explain Factory.').length, 1);
  }
});

test('R6 registered two/three-registration premises reach assessment review losslessly, excluding unrelated chat', async t => {
  const frozen = JSON.parse(await readFile(resolve(process.cwd(), '../eval/cases/assessment-context-repair-quality.json'), 'utf8'));
  for (const id of ['two-registrations-vs-three-in-test', 'actual-three-registrations-but-two-key-answer']) await t.test(id, async t => {
    const row = frozen.cases.find((c: { id: string }) => c.id === id);
    const received: Parameters<typeof reviewAnswerEvidence>[0][] = [];
    const f = await fixture(t, async input => {
      const result = grade(input, input.answer === 'On answer.');
      return input.answer === 'On answer.' ? result : { ...result, feedback: row.assessment_feedback };
    }, async input => {
      if (input.purpose !== 'assessment' || input.text.includes('On is correct')) return supported(input);
      received.push(input);
      // The expected result is scripted. This checks gating and premise transport only.
      return id === 'two-registrations-vs-three-in-test' ? supported(input) : { ...await supported(input), supported: false,
        issues: [{ claim: '只出现 FOO、Bar 两个键', reason: 'Controlled negative premise result.', kind: 'contradicted', subject: 'assessment_judgment' }] };
    }, row.registered_question.prompt);
    await f.store.updateProject(f.base.projectId, f.base.owner.owner_id, p => {
      p.messages.unshift(createMessage('user', 'UNRELATED_TEST_SETUP: on("baz:baT!", fn) happened in another scenario.'));
    });
    const baseline = structuredClone((await f.load()).study);
    const answer = row.current_answer_parts[0];
    scripted(t, async o => {
      await interpret(o, answer);
      await tool(o, 'assess_understanding').execute('grade', { question_id: f.old.question_id });
      for (let i = 0; i < 3; i++) {
        try { await tool(o, 'submit_conversation_reply').execute(`review:${i}`, { kind: 'assessment' }); break; }
        catch (error) { assert.equal((error as { code: string }).code, 'reply_evidence_repair_required'); }
      }
    });
    await f.service.run({ ...f.base, content: answer, reviewEvidence: true });
    assert.ok(received.length >= 1 && received.length <= 2);
    for (const input of received) {
      const context = input.assessmentContext!;
      assert.equal(context.registered_question.prompt, row.registered_question.prompt);
      assert.deepEqual(context.current_answer_parts, [answer]);
      assert.equal(context.registered_question.question_id, f.old.question_id);
      assert.doesNotMatch(JSON.stringify(context), /UNRELATED_TEST_SETUP|another scenario/);
      const source = (await f.load()).messages.find(m => m.message_id === context.source_message_id)!;
      assert.equal(source.role, 'user');
      assert.equal(source.content, answer);
    }
    if (id === 'two-registrations-vs-three-in-test') assert.equal((await f.load()).study.target_assessments!.length, 2);
    else assert.deepEqual((await f.load()).study, baseline);
  });
});
