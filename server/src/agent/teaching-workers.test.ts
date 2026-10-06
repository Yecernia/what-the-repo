import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from 'node:fs';
import { createModels, type Api, type Model, type Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createMessage, createProject, emptyProfile } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { generateLearningRoute, runUnderstandingAssessment } from "./teaching-workers.js";
import type { PiModelRuntime } from "./types.js";
import { applyTargetAssessment, assessmentFeedbackScope, priorTargetCoverageForAssessment, targetsForStep } from './target-coverage.js';
import type { TeachingFeedbackScope, TeachingQuestion, TeachingQuestionResult, TeachingTargetResult } from './teaching-question.js';

const evidence: SnapshotEvidence = {
  stable_id: "fact:file:entry",
  label: "src/entry.ts",
  path: "src/entry.ts",
  start_line: 1,
  end_line: 3,
  kind: "file",
};

function snapshot(): EvidenceSnapshot {
  return {
    snapshot_id: "snapshot:teaching-worker",
    summary: { file_count: 1, symbol_count: 1, call_count: 0, component_count: 1 },
    graph: {
      semantic_mode: "provider_supported",
      nodes: [{
        id: "component:entry",
        label: "入口服务",
        name: "入口服务",
        responsibility: "接收请求并调用核心逻辑。",
        grouping_rationale: "入口相关事实。",
        architecture_layer_id: "layer:application",
        architecture_layer_name: "应用层",
        members: [evidence],
        member_count: 1,
        evidence: [evidence],
        certainty: "verified",
        review_status: "reviewed",
        fan_in: 0,
        fan_out: 0,
      }],
      edges: [],
      layers: [],
      unassigned_component_ids: [],
    },
    value_points: [],
    languages: [],
    learning_plan: { snapshot_id: "snapshot:teaching-worker", selected_value_point: null, steps: [] },
  };
}

function runtime(name: string, response: unknown): PiModelRuntime {
  const faux = fauxProvider({ provider: name });
  const models = createModels();
  models.setProvider(faux.provider);
  // These are synthetic contract responses, not real-model semantic verification.
  const responses = Array.isArray(response) ? response : [response];
  let responseIndex = 0;
  faux.setResponses(Array.from({ length: 8 }, () => (context: Context) => {
    const payload = contextPayload(context);
    const item = responses[Math.min(responseIndex++, responses.length - 1)];
    const message = typeof item === 'function' ? item(context) : structuredClone(item);
    if (payload.current_question) for (const block of (message as { content: Array<{ type: string; name?: string; arguments?: Record<string, unknown> }> }).content) {
      if (block.type !== 'toolCall' || block.name !== 'submit_result' || !block.arguments?.target_results) continue;
      const value = block.arguments;
      const questionResult = syntheticQuestionResult(payload, value.target_results as TeachingTargetResult[]);
      value.question_result ??= questionResult;
      if (payload.task_phase === 'semantic_assessment') {
        value.question_requirements = (value.question_result as TeachingQuestionResult).requirements;
        for (const field of ['question_result', 'feedback_scope', 'mastered_items', 'evidence_ids', 'verdict']) delete value[field];
      }
    }
    return message;
  }) as never[]);
  return { models, model: faux.getModel() as Model<Api> };
}

function syntheticQuestionResult(payload: ReturnType<typeof contextPayload>, results: TeachingTargetResult[]): TeachingQuestionResult {
  const choice = payload.current_question.prompt === 'Choose any one target';
  const requirements = results.map(result => {
    const prior = (payload.qualified_prior_question_support ?? []).find((record: { question_id: string; message_id: string; proven_target_ids: string[] }) =>
      record.question_id === payload.current_question.question_id && record.proven_target_ids.includes(result.target_id));
    const outcome = result.outcome === 'proven' || (prior && result.outcome !== 'contradicted') ? 'satisfied'
      : result.outcome === 'contradicted' ? 'contradicted' : choice ? 'not_selected' : 'missing';
    return { prompt_span: payload.current_question.prompt, target_ids: [result.target_id], outcome,
      answer_spans: result.answer_spans, prior_answer_message_ids: prior && result.outcome !== 'proven' && outcome === 'satisfied' ? [prior.message_id] : [],
      evidence_ids: outcome === 'satisfied' || outcome === 'contradicted' ? [evidence.stable_id] : [], reason: 'Synthetic fixture requirement' };
  }) as TeachingQuestionResult['requirements'];
  return { complete: requirements.every(requirement => ['satisfied', 'not_selected'].includes(requirement.outcome))
    && requirements.some(requirement => requirement.outcome === 'satisfied'), requirements };
}

function selectedRuntime(role: "learning-route" | "understanding-assessment", selected: PiModelRuntime): PiModelRuntime {
  return { ...runtime("unused-chat-model", () => assert.fail("a configured teaching role must not call the chat model")), roleRuntimes: { [role]: selected } };
}

const store = {
  readSourceLines: async () => ({ lines: ["export function entry() {", "  return core();", "}"], truncated: false }),
} as unknown as ProductStore;

function initialFeedbackScope(questionIds: string[], provenIds: string[], stepIds = questionIds): TeachingFeedbackScope {
  return { prior_proven_target_ids: [], current_proven_target_ids: provenIds,
    question_covered_target_ids: questionIds.filter(id => provenIds.includes(id)),
    question_remaining_target_ids: questionIds.filter(id => !provenIds.includes(id)),
    step_remaining_target_ids: stepIds.filter(id => !provenIds.includes(id)), follow_up_target_ids: [] };
}

test("understanding assessment returns a judgment without a study mutation candidate", async () => {
  const project = createProject("owner:assessment", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.snapshot_id = "snapshot:teaching-worker";
  project.study.phase = "assessing";
  project.study.total_steps = 1;
  project.study.dynamic_learning_plan = [{
    step_id: "learning:entry",
    order: 1,
    title: "理解入口流程",
    objective: "说明入口怎样调用核心逻辑。",
    completion_check: "能说清目标、流程和证据。",
    learning_targets: ['入口调用'],
    component_ids: ["component:entry"],
    evidence_refs: [evidence.stable_id],
  }];
  const result = await runUnderstandingAssessment({
    question: { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'learning:entry', prompt: '入口调用什么？', target_items: ['入口调用'], evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 },
    answer: "入口接收请求后调用 core。",
    evidence: [evidence],
    project,
    snapshot: snapshot(),
    store,
    modelRuntime: selectedRuntime("understanding-assessment", runtime("assessment-valid", fauxAssistantMessage(fauxToolCall("submit_result", {
      answer_relevant: true, verdict: "mastered",
      feedback: "目标和流程正确。",
      mastered_items: ["理解入口流程"],
      misconceptions: [],
      evidence_ids: [evidence.stable_id],
      target_results: [{ target_id: targetsForStep(project.study.dynamic_learning_plan[0]!)[0]!.target_id,
        outcome: 'proven', reason: 'Correct call', answer_spans: ['调用 core'], evidence_ids: [evidence.stable_id] }],
      feedback_scope: initialFeedbackScope(targetsForStep(project.study.dynamic_learning_plan[0]!).map(target => target.target_id),
        targetsForStep(project.study.dynamic_learning_plan[0]!).map(target => target.target_id)),
    })))),
  });
  assert.equal(result.completed, true);
  assert.equal(result.verdict, "mastered");
  assert.equal(result.trace.provider, "assessment-valid");
  assert.deepEqual(result.masteredItems, ["入口调用"], 'mastery labels are derived from validated target IDs');
  assert.equal("nextStudy" in result, false);
  assert.equal(project.study.current_step, 0);
});

test("understanding assessment rejects mastered results supported only by fabricated evidence", async () => {
  const project = createProject("owner:assessment-invalid", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.snapshot_id = "snapshot:teaching-worker";
  project.study.phase = "assessing";
  project.study.total_steps = 1;
  project.study.dynamic_learning_plan = [{
    step_id: "learning:entry", order: 1, title: "理解入口流程", objective: "说明入口调用。",
    completion_check: "能说明证据。", learning_targets: ['entry'], component_ids: ["component:entry"], evidence_refs: [evidence.stable_id],
  }];
  const before = structuredClone(project.study);
  const result = await runUnderstandingAssessment({
    question: { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'learning:entry', prompt: 'Entry?', target_items: ['entry'], evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 },
    answer: "入口会调用核心逻辑。", evidence: [evidence], project, snapshot: snapshot(), store,
    modelRuntime: selectedRuntime("understanding-assessment", runtime("assessment-fabricated", Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall("submit_result", {
      answer_relevant: true, verdict: "mastered", feedback: "已掌握。", mastered_items: ["理解入口流程"], misconceptions: [], evidence_ids: ["fact:invented"],
      target_results: [{ target_id: targetsForStep(project.study.dynamic_learning_plan![0]!)[0]!.target_id,
        outcome: 'proven', reason: 'Correct call', answer_spans: ['调用核心逻辑'], evidence_ids: ['fact:invented'] }],
      feedback_scope: initialFeedbackScope(targetsForStep(project.study.dynamic_learning_plan![0]!).map(target => target.target_id),
        targetsForStep(project.study.dynamic_learning_plan![0]!).map(target => target.target_id)),
    }))))),
  });
  assert.equal(result.completed, false);
  assert.deepEqual(result.acceptedEvidenceIds, []);
  assert.equal(result.trace.stop_reason, "assessment_validation_failed");
  assert.equal(result.trace.state_candidate, false);
  assert.deepEqual(project.study, before);
});

test("learning route may return an honest empty result", async () => {
  const project = createProject("owner:route", "https://github.com/example/repo", "repo", "free:test");
  project.messages = [createMessage('user', 'Only spend 20 minutes on routing; skip database internals.')];
  const profile = { ...emptyProfile(), memory_summary: 'Current preference: examples first' };
  project.analysis.snapshot_id = "snapshot:teaching-worker";
  const result = await generateLearningRoute({
    project,
    snapshot: snapshot(),
    target: { kind: "repository", stable_id: null, label: "example/repo" },
    request: "Please help me learn this repository",
    profile,
    memories: [{ memoryId: 'm', ownerId: project.owner_id, scope: 'user', key: 'language', value: 'Go', confidence: 1, sourceMessageIds: [], createdAt: '', updatedAt: '' }],
    store,
    modelRuntime: selectedRuntime("learning-route", runtime("route-empty", (context: Context) => {
      const user = context.messages.find(row => row.role === "user")!;
      const text = JSON.stringify(contextPayload(context));
      assert.equal(JSON.parse(text).display_language, "en", "the Chinese project must not override the English request");
      assert.equal(JSON.parse(text).recent_conversation[0].content, project.messages[0].content);
      assert.equal(JSON.parse(text).learner.memory_summary, profile.memory_summary);
      assert.equal(JSON.parse(text).memories[0].value, 'Go');
      assert.ok(JSON.parse(text).current_study);
      return fauxAssistantMessage(fauxToolCall("submit_result", { steps: [] }));
    })),
  });
  assert.equal(result.completed, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.trace.state_candidate, false);
  assert.equal(result.trace.provider, "route-empty");
});

test('invalid middle route bindings are rejected rather than silently dropped', async () => {
  const project = createProject('owner:bad-route', 'https://github.com/example/repo', 'repo', 'free:test');
  const step = (component: string) => ({ title: 'Read entry flow', objective: 'Explain how entry calls core', completion_check: 'Explain the call', learning_targets: ['Explain the call'], component_ids: [component], evidence_ids: [evidence.stable_id] });
  const result = await generateLearningRoute({ project, snapshot: snapshot(), target: { kind: 'component', stable_id: 'component:entry', label: 'Entry' }, request: 'Teach the entry flow', profile: emptyProfile(), store,
    modelRuntime: runtime('invalid-middle-route', Array.from({ length: 4 }, () => fauxAssistantMessage(fauxToolCall('submit_result', { steps: [step('component:entry'), step('missing'), step('component:entry')] })))) });
  assert.equal(result.completed, false); assert.deepEqual(result.steps, []);
  assert.match(result.trace.stop_reason, /route_validation_failed/);
});

test('valid route keeps all steps with consecutive order and explicit targets', async () => {
  const project = createProject('owner:good-route', 'https://github.com/example/repo', 'repo', 'free:test');
  const step = { title: 'Read entry flow', objective: 'Explain how entry calls core', completion_check: 'Explain the call', learning_targets: ['Explain the call'], component_ids: ['component:entry'], evidence_ids: [evidence.stable_id] };
  const result = await generateLearningRoute({ project, snapshot: snapshot(), target: { kind: 'component', stable_id: 'component:entry', label: 'Entry' }, request: 'Teach the entry flow', profile: emptyProfile(), store,
    modelRuntime: runtime('valid-route-order', fauxAssistantMessage(fauxToolCall('submit_result', { steps: [step, step] }))) });
  assert.equal(result.completed, true); assert.deepEqual(result.steps.map(row => row.order), [1, 2]);
});

test('assessment sees complete long function and only registered targets; unrelated chat cannot pass', async () => {
  const project = createProject('owner:narrow', 'https://github.com/example/repo', 'repo', 'free:test');
  project.analysis.snapshot_id = 'snapshot:teaching-worker';
  project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Double', objective: 'Entire step', completion_check: 'Hidden broad rubric', learning_targets: ['Result', 'Fallback'], evidence_refs: [evidence.stable_id], component_ids: ['component:entry'] }];
  const longEvidence = { ...evidence, start_line: 10, end_line: 46 };
  const question = { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'step', prompt: 'What does double return?', target_items: ['Result'], evidence: [longEvidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 };
  const result = await runUnderstandingAssessment({ question, project, snapshot: snapshot(), evidence: [longEvidence], answer: 'Tell me about something else', store: { readSourceLines: async (_p: string, _s: string, _path: string, start: number, end: number) => ({ lines: Array.from({ length: end - start + 1 }, (_, i) => start + i === 45 ? 'return x * 2;' : '// context'), truncated: false }) } as unknown as ProductStore,
    modelRuntime: runtime('narrow-question', (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const user = context.messages.find(row => row.role === 'user')!;
      const text = typeof user.content === 'string' ? user.content : (user.content as Array<{ text: string }>).map(row => row.text).join('');
      const payload = JSON.parse(text); assert.deepEqual(payload.current_question.targets.map((target: { label: string }) => target.label), ['Result']); assert.equal(payload.current_step, undefined); assert.ok(payload.evidence[0].excerpt.includes('return x * 2;'));
      return fauxAssistantMessage(fauxToolCall('submit_result', { answer_relevant: false, verdict: 'mastered', feedback: 'Not an answer', mastered_items: [], misconceptions: [], evidence_ids: [evidence.stable_id],
        target_results: [{ target_id: payload.current_question.targets[0].target_id, outcome: 'not_addressed', reason: 'Unrelated chat', answer_spans: [], evidence_ids: [] }],
        feedback_scope: initialFeedbackScope(payload.current_question.targets.map((target: { target_id: string }) => target.target_id), [], targetsForStep(project.study.dynamic_learning_plan![0]!).map(target => target.target_id)) }));
    }) });
  assert.equal(result.completed, true); assert.equal(result.verdict, 'unclear');
});

test('missing source body cannot yield mastery from a graph label', async () => {
  const project = createProject('owner:missing-body', 'https://github.com/example/repo', 'repo', 'free:test');
  project.analysis.snapshot_id = 'snapshot:teaching-worker';
  project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Entry', objective: 'Entry', completion_check: 'Entry?', component_ids: ['component:entry'], evidence_refs: [evidence.stable_id] }];
  const question = { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'step', prompt: 'Entry?', target_items: ['Entry?'], evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 };
  const result = await runUnderstandingAssessment({ question, project, snapshot: snapshot(), evidence: [evidence], answer: 'core()', store: { readSourceLines: async () => { throw new Error('missing source'); } } as unknown as ProductStore,
    modelRuntime: runtime('missing-body', Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall('submit_result', { answer_relevant: true, verdict: 'mastered', feedback: 'Correct', mastered_items: ['Entry'], misconceptions: [], evidence_ids: [evidence.stable_id],
      target_results: [{ target_id: targetsForStep(project.study.dynamic_learning_plan![0]!)[0]!.target_id, outcome: 'proven', reason: 'Call', answer_spans: ['core()'], evidence_ids: [evidence.stable_id] }],
      feedback_scope: initialFeedbackScope(targetsForStep(project.study.dynamic_learning_plan![0]!).map(target => target.target_id), targetsForStep(project.study.dynamic_learning_plan![0]!).map(target => target.target_id)) })))) });
  assert.equal(result.completed, false); assert.deepEqual(result.acceptedEvidenceIds, []);
});

function targetAssessmentFixture(ids = ['A', 'B', 'C', 'D']) {
  const project = createProject('owner:targets', 'https://github.com/example/repo', 'repo', 'free:test');
  project.analysis.snapshot_id = 'snapshot:teaching-worker';
  project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Targets', objective: 'Targets', completion_check: 'Explain targets',
    learning_target_defs: ids.map(id => ({ target_id: id, label: 'Target ' + id })),
    evidence_refs: [evidence.stable_id], component_ids: ['component:entry'] }];
  const question: TeachingQuestion = { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0,
    step_id: 'step', prompt: 'Choose any one target', target_items: ids.map(id => 'Target ' + id), target_ids: ids,
    evidence: [evidence], answers: ['old whole message with independent follow-up'], answer_message_ids: ['old'],
    created_message_id: 'lesson', assessment_sequence: 0 };
  const answer = 'A calls core.';
  const source = createMessage('user', answer + '\nAlso explain the independent example.'); source.message_id = 'current'; project.messages.push(source);
  return { project, question, answer, originalMessage: source.content, sourceMessageId: source.message_id,
    answerParts: [answer], evidence: [evidence], snapshot: snapshot(), store };
}
function targetResult(id: string, outcome: TeachingTargetResult['outcome']): TeachingTargetResult {
  return { target_id: id, outcome, reason: 'The current answer addresses ' + id,
    answer_spans: ['proven', 'contradicted'].includes(outcome) ? ['calls core'] : [],
    evidence_ids: ['proven', 'contradicted'].includes(outcome) ? [evidence.stable_id] : [] };
}
function targetSubmission(results: TeachingTargetResult[]) {
  return { answer_relevant: true, verdict: 'mastered', feedback: 'The selected branch is correct.',
    mastered_items: ['Target A'], misconceptions: [], evidence_ids: [evidence.stable_id], target_results: results,
    feedback_scope: initialFeedbackScope(results.map(result => result.target_id), results.filter(result => result.outcome === 'proven').map(result => result.target_id)) };
}

test('TA09 faux worker pipeline accepts a lawful selected branch without certifying unchosen targets', async () => {
  const input = targetAssessmentFixture();
  const before = structuredClone(input.project.study);
  const value = targetSubmission([targetResult('A', 'proven'), ...['B', 'C', 'D'].map(id => targetResult(id, 'not_addressed'))]);
  const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('target-lawful-choice', (context: Context) => {
    assert.match(context.systemPrompt ?? '', /explicit choice in the prompt/);
    const user = context.messages.find(message => message.role === 'user')!;
    const payload = JSON.parse(typeof user.content === 'string' ? user.content : (user.content as Array<{ text: string }>).map(part => part.text).join(''));
    assert.ok(!('answer_to_current_question' in payload));
    assert.deepEqual(payload.current_answer_parts, [input.answer]);
    assert.deepEqual(payload.current_question.targets.map((target: { target_id: string }) => target.target_id), ['A', 'B', 'C', 'D']);
    assert.ok(!('earlier_answers_to_this_question' in payload), 'unqualified old attempts are absent');
    return fauxAssistantMessage(fauxToolCall('submit_result', value));
  }) });
  assert.equal(result.completed, true); assert.equal(result.verdict, 'mastered');
  assert.deepEqual(result.targetResults, value.target_results); assert.deepEqual(input.project.study, before);
});

test('TA13 faux worker submission validator rejects target escape, missing proofs and historical-answer quotations', async t => {
  for (const variant of ['unknown', 'duplicate', 'missing-target', 'missing-span', 'invented-span', 'history-span', 'missing-evidence', 'unread-evidence']) await t.test(variant, async () => {
    const input = targetAssessmentFixture(['A', 'B']);
    const results = [targetResult('A', 'proven'), targetResult('B', 'not_addressed')];
    if (variant === 'unknown') results[0]!.target_id = 'C';
    if (variant === 'duplicate') results[1]!.target_id = 'A';
    if (variant === 'missing-target') results.pop();
    if (variant === 'missing-span') results[0]!.answer_spans = [];
    if (variant === 'invented-span') results[0]!.answer_spans = ['A dispatches a request.'];
    if (variant === 'history-span') results[0]!.answer_spans = ['old whole message'];
    if (variant === 'missing-evidence') results[0]!.evidence_ids = [];
    if (variant === 'unread-evidence') results[0]!.evidence_ids = ['global:unread'];
    const value = targetSubmission(results);
    let requests = 0;
    const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('target-invalid-' + variant, [
      () => { requests++; return fauxAssistantMessage(fauxToolCall('submit_result', value)); },
      (context: Context) => { requests++; assert.match(JSON.stringify(context.messages), /target_results/); return fauxAssistantMessage(fauxToolCall('submit_result', value)); },
    ]) });
    assert.equal(requests, 2); assert.equal(result.completed, false);
    assert.equal(result.trace.diagnostics!.rejectedSubmissions, 2);
    assert.equal(input.project.study.step_passed, undefined);
  });
});

test('TA13 valid current spans cannot be assembled across independently assessed parts', async () => {
  const input = targetAssessmentFixture(['A']);
  input.answerParts = ['A calls', 'core.'];
  const invalid = targetResult('A', 'proven'); invalid.answer_spans = ['A calls\ncore.'];
  const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('target-cross-part-span',
    Array.from({ length: 2 }, () => fauxAssistantMessage(fauxToolCall('submit_result', targetSubmission([invalid]))))) });
  assert.equal(result.completed, false);
});

test('TA13 preflight rejects wrong question/source scope before requesting a model', async t => {
  for (const variant of ['snapshot', 'revision', 'step', 'target', 'same-turn', 'source', 'missing-bound-evidence']) await t.test(variant, async () => {
    const input = targetAssessmentFixture(['A']);
    if (variant === 'snapshot') input.question.snapshot_id = 'other';
    if (variant === 'revision') input.question.route_revision++;
    if (variant === 'step') input.question.step_id = 'other';
    if (variant === 'target') input.question.target_ids = ['unknown'];
    if (variant === 'same-turn') input.question.created_message_id = input.sourceMessageId;
    if (variant === 'source') input.originalMessage = 'invented original';
    if (variant === 'missing-bound-evidence') input.evidence = [];
    const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('target-preflight-' + variant,
      () => assert.fail('invalid scope must not request a model')) });
    assert.equal(result.completed, false); assert.equal(result.trace.stop_reason, 'assessment_input_scope_mismatch');
    assert.equal(result.trace.usage.outputTokens, 0);
  });
});

test('TA19 earlier worker input contains only source-bound assessed fragments and excludes the edited current message', async () => {
  const input = targetAssessmentFixture(['A']);
  const old = createMessage('user', 'Earlier exact answer.\nAn independent request.'); old.message_id = 'old'; input.project.messages.unshift(old);
  input.question.answer_attempts = [
    { message_id: 'old', original_message_id: 'old', answer_parts: ['Earlier exact answer.'] },
    { message_id: 'current', original_message_id: 'current', answer_parts: ['A calls core.'] },
    { message_id: 'missing', original_message_id: 'missing', answer_parts: ['Fabricated history'] },
  ];
  const result = await runUnderstandingAssessment({ ...input,
    modelRuntime: runtime('target-earlier-parts', (context: Context) => {
      const user = context.messages.find(message => message.role === 'user')!;
      const payload = JSON.parse(typeof user.content === 'string' ? user.content : (user.content as Array<{ text: string }>).map(part => part.text).join(''));
      assert.ok(!('earlier_answers_to_this_question' in payload));
      assert.deepEqual(payload.qualified_prior_question_support, [], 'source-bound attempts without committed proof are not authority');
      assert.ok(!JSON.stringify(payload).includes('never send'));
      return fauxAssistantMessage(fauxToolCall('submit_result', targetSubmission([targetResult('A', 'proven')])));
    }) });
  assert.equal(result.completed, true);
});

test('TA24 feedback repair cannot rewrite target proofs and receives structured-worker corrective feedback', async () => {
  const input = targetAssessmentFixture(['A']); const fixed = [targetResult('A', 'proven')];
  const qr = syntheticQuestionResult({ current_question: input.question }, fixed);
  let requests = 0;
  const result = await runUnderstandingAssessment({ ...input,
    feedbackRepair: { feedback: 'Correct. Click confirm.', offendingSpans: ['Click confirm.'], verdict: 'mastered', answerRelevant: true,
      masteredItems: ['Target A'], misconceptions: [], evidenceIds: [evidence.stable_id], targetResults: fixed,
      questionResult: qr, feedbackScope: { ...initialFeedbackScope(['A'], ['A']), question_complete: qr.complete, question_requirements: qr.requirements } },
    modelRuntime: runtime('target-feedback-lock', [
      () => { requests++; return fauxAssistantMessage(fauxToolCall('submit_result', targetSubmission([targetResult('A', 'not_addressed')]))); },
      (context: Context) => { requests++; assert.match(JSON.stringify(context.messages), /additional|unexpected|schema/i);
        return fauxAssistantMessage(fauxToolCall('submit_result', { feedback: 'The selected branch is correct.' })); },
    ]) });
  assert.equal(requests, 2); assert.equal(result.completed, true); assert.deepEqual(result.targetResults, fixed);
  assert.deepEqual(result.questionResult, qr, 'extra judgment fields are schema-rejected; fixed judgments are recombined by the program');
});

type CumulativeWorkerInput = ReturnType<typeof targetAssessmentFixture>;
function displayedWorkerQuestion(input: CumulativeWorkerInput, question: TeachingQuestion) {
  const source = createMessage('user', 'Ask this question'); source.message_id = question.created_message_id;
  source.analysis_snapshot_id = question.snapshot_id;
  if (!input.project.messages.some(message => message.message_id === source.message_id)) input.project.messages.push(source);
  const displayed = createMessage('assistant', question.prompt); displayed.message_id = 'display:' + question.question_id;
  displayed.teaching_question = structuredClone(question);
  displayed.teaching_context = { snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id };
  input.project.messages.push(displayed);
}
function cumulativeWorkerFixture(stepIds = ['A', 'B'], questionIds = ['A', 'B']): CumulativeWorkerInput {
  const input = targetAssessmentFixture(stepIds);
  input.question.target_ids = questionIds;
  input.question.target_items = questionIds.map(id => 'Target ' + id);
  input.question.prompt = 'Explain the bound targets';
  input.question.answers = [];
  input.question.answer_message_ids = [];
  input.project.messages = [];
  displayedWorkerQuestion(input, input.question);
  return input;
}
function currentWorkerAnswer(input: CumulativeWorkerInput, messageId: string, answer: string) {
  const original = answer + '\nKeep me on this step.';
  const existing = input.project.messages.find(message => message.message_id === messageId && message.role === 'user');
  if (existing) existing.content = original;
  else { const user = createMessage('user', original); user.message_id = messageId; input.project.messages.push(user); }
  input.sourceMessageId = messageId; input.answer = answer; input.answerParts = [answer]; input.originalMessage = original;
}
function currentTargetResult(id: string, outcome: TeachingTargetResult['outcome'], answer: string): TeachingTargetResult {
  const value = targetResult(id, outcome);
  value.answer_spans = ['proven', 'contradicted'].includes(outcome) ? [answer] : [];
  return value;
}
function contextPayload(context: Context) {
  const user = context.messages.find(message => message.role === 'user')!;
  return JSON.parse(typeof user.content === 'string' ? user.content
    : (user.content as Array<{ text: string }>).find(part => part.text?.trimStart().startsWith('{'))!.text);
}
function currentScope(input: CumulativeWorkerInput, current: TeachingTargetResult[]) {
  const prior = priorTargetCoverageForAssessment(input.project, input.question, input.project.study.dynamic_learning_plan![0]!, input.sourceMessageId);
  const questionResult = syntheticQuestionResult({ current_question: input.question,
    qualified_prior_question_support: Object.values(prior.coverage).filter(target => target.proven).map(target => ({ question_id: target.question_id,
      message_id: target.message_id, proven_target_ids: [target.target_id] })) }, current);
  return assessmentFeedbackScope(prior, input.question, current, questionResult);
}
async function fauxCumulativeAssessment(input: CumulativeWorkerInput, current: TeachingTargetResult[],
  inspect?: (context: Context) => void) {
  const scope = currentScope(input, current);
  const result = await runUnderstandingAssessment({ ...input,
    modelRuntime: runtime('cumulative-context', (context: Context) => {
      inspect?.(context);
      return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current),
        verdict: current.some(result => result.outcome === 'contradicted') ? 'misconception'
          : scope.question_complete ? 'mastered' : 'partial',
        feedback_scope: scope }));
    }) });
  assert.equal(result.completed, true);
  assert.deepEqual(result.feedbackScope, scope);
  return result;
}
function applyCumulativeResult(input: CumulativeWorkerInput, results: TeachingTargetResult[]) {
  return applyTargetAssessment(input.project, input.question, input.sourceMessageId, input.answerParts, results);
}

test('R4-1 faux worker context carries qualified A into same-question or cross-question B feedback without recertifying A', async t => {
  for (const crossQuestion of [false, true]) await t.test(crossQuestion ? 'cross-question' : 'same-question', async () => {
    const input = cumulativeWorkerFixture(['A', 'B', 'C']);
    currentWorkerAnswer(input, 'm1', 'A calls core.');
    const first = [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')];
    const assessedA = await fauxCumulativeAssessment(input, first);
    applyCumulativeResult(input, assessedA.targetResults);
    if (crossQuestion) {
      input.question = { ...structuredClone(input.question), question_id: 'q2', target_ids: ['B'], target_items: ['Target B'],
        created_message_id: 'second-lesson', answer_attempts: [], assessment_sequence: 0 };
      displayedWorkerQuestion(input, input.question);
    }
    currentWorkerAnswer(input, 'm2', 'B removes one handler.');
    const current = crossQuestion ? [currentTargetResult('B', 'proven', input.answer)]
      : [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)];
    const assessedB = await fauxCumulativeAssessment(input, current, context => {
      const payload = contextPayload(context);
      const priorA = [...payload.current_question.targets, ...payload.step_targets].find((target: { target_id: string }) => target.target_id === 'A');
      assert.equal(priorA.prior_status, 'proven');
      const support = payload.qualified_prior_question_support.find((row: { message_id: string }) => row.message_id === 'm1');
      assert.deepEqual([support.question_id, support.message_id, support.sequence], ['q', 'm1', 1]);
      assert.ok(!payload.qualified_prior_question_support.some((row: { message_id: string }) => row.message_id === 'm2'));
      assert.match(context.systemPrompt ?? '', /program preserves/);
    });
    assert.deepEqual(assessedB.feedbackScope!.current_proven_target_ids, ['B']);
    assert.equal(assessedB.verdict, 'mastered',
      'the current-answer verdict does not manufacture a gap in cumulative question coverage');
    assert.deepEqual(assessedB.feedbackScope!.question_remaining_target_ids, []);
    assert.deepEqual(assessedB.feedbackScope!.step_remaining_target_ids, ['C']);
    assert.equal(assessedB.targetResults.some(result => result.target_id === 'A' && result.outcome === 'proven'), false);
    const applied = applyCumulativeResult(input, assessedB.targetResults);
    assert.equal(applied.coverage.A!.message_id, 'm1'); assert.equal(applied.coverage.B!.message_id, 'm2');
    assert.equal(applied.stepPassed, false);
  });
});

test('R7-2 derived scope does not require the model to repair duplicate coverage fields', async () => {
  const input = cumulativeWorkerFixture();
  currentWorkerAnswer(input, 'm1', 'A calls core.');
  const first = [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')];
  applyCumulativeResult(input, (await fauxCumulativeAssessment(input, first)).targetResults);
  currentWorkerAnswer(input, 'm2', 'B removes one handler.');
  const current = [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)];
  const scope = currentScope(input, current);
  let requests = 0;
  const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('cumulative-scope-retry', [
    () => { requests++; return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current),
      feedback: 'A was already established; this answer supplies B.', feedback_scope: { ...scope, question_remaining_target_ids: ['A'], follow_up_target_ids: ['A'] } })); },
    (context: Context) => { requests++; assert.match(JSON.stringify(context.messages), /feedback_scope_mismatch.*question_remaining_target_ids/);
      assert.match(JSON.stringify(context.messages), /feedback_scope_already_proven/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current),
        feedback: 'A was already established; this answer establishes B. This question is now covered.', feedback_scope: scope })); },
  ]) });
  assert.equal(requests, 1); assert.equal(result.completed, true);
  assert.deepEqual(result.feedbackScope!.question_remaining_target_ids, []);
  assert.deepEqual(result.feedbackScope!.prior_proven_target_ids, ['A']);
  assert.equal(applyCumulativeResult(input, result.targetResults).stepPassed, true);
});

test('R7-2 model-free derived coverage ignores obsolete faux duplicate scope calculations', async () => {
  const input = cumulativeWorkerFixture(); currentWorkerAnswer(input, 'm1', 'A calls core.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')]);
  currentWorkerAnswer(input, 'm2', 'B removes one handler.');
  const current = [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)];
  const invalid = { ...currentScope(input, current), follow_up_target_ids: ['A'] };
  let requests = 0;
  const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('cumulative-scope-exhausted', Array.from({ length: 3 }, () =>
    () => { requests++; return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current), feedback_scope: invalid })); })) });
  assert.equal(requests, 1); assert.equal(result.completed, true);
  assert.deepEqual(result.feedbackScope!.follow_up_target_ids, []);
  assert.equal(input.project.study.target_assessments!.length, 1, 'failed feedback commits no new proof');
});

test('R4-1 faux worker feedback reopens A only after contradiction and closes it after a qualified current correction', async () => {
  const input = cumulativeWorkerFixture(); currentWorkerAnswer(input, 'm1', 'A calls core and B removes one handler.');
  applyCumulativeResult(input, (await fauxCumulativeAssessment(input,
    ['A', 'B'].map(id => currentTargetResult(id, 'proven', input.answer)))).targetResults);
  currentWorkerAnswer(input, 'm2', 'A never calls core.');
  const current = [currentTargetResult('A', 'contradicted', input.answer), targetResult('B', 'not_addressed')];
  const revoked = await fauxCumulativeAssessment(input, current);
  assert.deepEqual(revoked.feedbackScope!.prior_proven_target_ids, ['A', 'B']);
  assert.deepEqual(revoked.feedbackScope!.question_remaining_target_ids, ['A']);
  assert.equal(applyCumulativeResult(input, revoked.targetResults).stepPassed, false);
  currentWorkerAnswer(input, 'm3', 'A does call core.');
  const restored = await fauxCumulativeAssessment(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'not_addressed')], context => {
    const priorA = contextPayload(context).current_question.targets.find((target: { target_id: string }) => target.target_id === 'A');
    assert.equal(priorA.prior_status, 'unproven'); assert.deepEqual(priorA.prior_source_message_ids, []);
  });
  assert.deepEqual(restored.feedbackScope!.prior_proven_target_ids, ['B']);
  assert.deepEqual(restored.feedbackScope!.question_remaining_target_ids, []);
  assert.equal(applyCumulativeResult(input, restored.targetResults).stepPassed, true);
});

test('R4-1 faux worker retry/edit excludes the replaced source proof even when the old text is unchanged', async () => {
  const input = cumulativeWorkerFixture(); currentWorkerAnswer(input, 'm1', 'A calls core.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')]);
  const inspect = (context: Context) => {
    const payload = contextPayload(context);
    assert.ok(payload.current_question.targets.every((target: { prior_status: string }) => target.prior_status === 'unproven'));
    assert.ok(!('earlier_answers_to_this_question' in payload));
  };
  await fauxCumulativeAssessment(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')], inspect);
  currentWorkerAnswer(input, 'm1', 'B removes one handler.');
  const edited = await fauxCumulativeAssessment(input, [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)], inspect);
  assert.deepEqual(edited.feedbackScope!.question_remaining_target_ids, ['A']);
  assert.equal(applyCumulativeResult(input, edited.targetResults).stepPassed, false);
  assert.equal(input.project.study.target_assessments!.length, 1);
});

test('R4-1 owner feedback repair locks cumulative scope and does not absorb the turn candidate as historical proof', async () => {
  const input = cumulativeWorkerFixture(); currentWorkerAnswer(input, 'm1', 'A calls core.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')]);
  currentWorkerAnswer(input, 'm2', 'B removes one handler.');
  const current = [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)];
  const scope = currentScope(input, current);
  applyCumulativeResult(input, current); // The main tool now holds this qualified candidate.
  let requests = 0;
  const result = await runUnderstandingAssessment({ ...input,
    feedbackRepair: { feedback: 'Good. Click confirm.', offendingSpans: ['Click confirm.'], verdict: 'mastered', answerRelevant: true,
      masteredItems: ['Target A'], misconceptions: [], evidenceIds: [evidence.stable_id], targetResults: current, feedbackScope: scope,
      questionResult: { complete: scope.question_complete!, requirements: scope.question_requirements! } },
    modelRuntime: runtime('cumulative-owner-repair', [
      (context: Context) => { requests++; const payload = contextPayload(context);
        assert.deepEqual(payload.current_question.targets.filter((target: { prior_status: string }) => target.prior_status === 'proven').map((target: { target_id: string }) => target.target_id), ['A']);
        return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current),
          feedback_scope: { ...scope, prior_proven_target_ids: ['A', 'B'] } })); },
      (context: Context) => { requests++; assert.match(JSON.stringify(context.messages), /additional|unexpected|schema/i);
        return fauxAssistantMessage(fauxToolCall('submit_result', { feedback: 'The selected branch is correct.' })); },
    ]) });
  assert.equal(requests, 2); assert.equal(result.completed, true); assert.deepEqual(result.feedbackScope, scope);
});

test('R6-2 frozen narrow question is complete after the correct supplement while composite target stays unproven (faux)', async () => {
  const frozen = JSON.parse(readFileSync(new URL('../../../eval/teaching-contract/r6-question-scope.json', import.meta.url), 'utf8'));
  const input = cumulativeWorkerFixture(['ON', 'OFF'], ['ON', 'OFF']);
  input.project.study.dynamic_learning_plan![0]!.learning_target_defs = ['ON', 'OFF'].map((target_id, index) => ({ target_id, label: frozen.question.target_items[index] }));
  input.question.prompt = frozen.question.prompt; input.question.target_items = frozen.question.target_items;
  input.project.messages = []; displayedWorkerQuestion(input, input.question);
  currentWorkerAnswer(input, 'm1', frozen.first_partial_answer);
  applyCumulativeResult(input, [currentTargetResult('ON', 'proven', input.answer), targetResult('OFF', 'unproven')]);
  currentWorkerAnswer(input, 'm2', frozen.correct_complement);
  const current = [targetResult('ON', 'not_addressed'), targetResult('OFF', 'unproven')];
  const qr: TeachingQuestionResult = { complete: true, requirements: [
    { prompt_span: "on('foo', a)、on('foo', b)", target_ids: ['ON'], outcome: 'satisfied', answer_spans: [],
      prior_answer_message_ids: ['m1'], evidence_ids: [evidence.stable_id], reason: 'Prior registered-question ON proof' },
    { prompt_span: "off('foo')，即不传第二个参数", target_ids: ['OFF'], outcome: 'satisfied', answer_spans: [frozen.correct_complement],
      prior_answer_message_ids: [], evidence_ids: [evidence.stable_id], reason: 'Actual no-handler branch is complete; handler branch was unasked' },
  ] };
  const scope = assessmentFeedbackScope(priorTargetCoverageForAssessment(input.project, input.question,
    input.project.study.dynamic_learning_plan![0]!, 'm2'), input.question, current, qr);
  const result = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('r6-frozen-narrow-faux', (context: Context) => {
    const payload = contextPayload(context);
    assert.equal(payload.current_question.prompt, frozen.question.prompt);
    assert.ok(!('prior_target_coverage' in payload));
    assert.equal(payload.current_question.targets.find((target: { target_id: string }) => target.target_id === 'ON').prior_status, 'proven');
    return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(current), verdict: 'mastered', question_result: qr,
      feedback: '本题已答完整。传入 handler 的语义属于本步后续内容。', feedback_scope: scope }));
  }) });
  assert.equal(result.completed, true); assert.equal(result.verdict, 'mastered');
  assert.deepEqual(result.feedbackScope!.question_remaining_target_ids, []);
  assert.deepEqual(result.feedbackScope!.step_remaining_target_ids, ['OFF']);
  assert.equal(applyTargetAssessment(input.project, input.question, 'm2', input.answerParts, current, undefined, qr).stepPassed, false);
});

test('R6-3 evidence owner repair changes only prose and retains question conditions and judgment (faux)', async () => {
  const input = targetAssessmentFixture(['A']); const fixed = [targetResult('A', 'proven')];
  const qr = syntheticQuestionResult({ current_question: input.question }, fixed);
  const scope = { ...initialFeedbackScope(['A'], ['A']), question_complete: qr.complete, question_requirements: qr.requirements };
  const result = await runUnderstandingAssessment({ ...input, feedbackRepair: { feedback: 'Correct. Also an unsupported mechanism.',
    offendingSpans: [], verdict: 'mastered', answerRelevant: true, masteredItems: ['Target A'], misconceptions: [],
    evidenceIds: [evidence.stable_id], targetResults: fixed, questionResult: qr, feedbackScope: scope,
    evidenceIssues: [{ claim: 'unsupported mechanism', reason: 'Outside current assessment packet', kind: 'unsupported' }] },
    modelRuntime: runtime('r6-evidence-owner-faux', (context: Context) => {
      const payload = contextPayload(context);
      assert.equal(payload.evidence_review_findings[0].reason, 'Outside current assessment packet');
      assert.equal(payload.current_question.prompt, input.question.prompt);
      return fauxAssistantMessage(fauxToolCall('submit_result', { feedback: 'The selected branch is correct.' }));
    }) });
  assert.equal(result.completed, true); assert.deepEqual(result.questionResult, qr); assert.deepEqual(result.targetResults, fixed);
  assert.deepEqual(result.acceptedEvidenceIds, [evidence.stable_id]); assert.equal(result.verdict, 'mastered');
});

test('R6-2 worker rejects a contradictory requirement paired with merely unproven composite target (faux)', async () => {
  const input = targetAssessmentFixture(['A']);
  const results = [targetResult('A', 'unproven')];
  const qr: TeachingQuestionResult = { complete: false, requirements: [{ prompt_span: input.question.prompt, target_ids: ['A'],
    outcome: 'contradicted', answer_spans: ['calls core'], prior_answer_message_ids: [], evidence_ids: [evidence.stable_id], reason: 'Declared faux contradiction' }] };
  const scope = assessmentFeedbackScope(priorTargetCoverageForAssessment(input.project, input.question,
    input.project.study.dynamic_learning_plan![0]!, input.sourceMessageId), input.question, results, qr);
  let requests = 0;
  const response = () => { requests++; return fauxAssistantMessage(fauxToolCall('submit_result', { ...targetSubmission(results),
    verdict: 'misconception', question_result: qr, feedback_scope: scope })); };
  const assessed = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('r6-contradicted-constituent-faux', [response, response]) });
  assert.equal(assessed.completed, false); assert.equal(requests, 2);
  assert.equal(input.project.study.target_assessments?.length ?? 0, 0);
});

test('R6-2 worker bounds prior exact proof records and discloses omitted history (faux)', async () => {
  const input = cumulativeWorkerFixture(['A'], ['A']);
  for (const id of ['m1', 'm2']) {
    currentWorkerAnswer(input, id, 'calls core ' + 'x'.repeat(16_000));
    applyCumulativeResult(input, [currentTargetResult('A', 'proven', 'calls core')]);
  }
  currentWorkerAnswer(input, 'm3', 'A calls core.');
  const assessed = await fauxCumulativeAssessment(input, [currentTargetResult('A', 'proven', input.answer)], context => {
    const payload = contextPayload(context);
    assert.equal(payload.qualified_prior_question_support.length, 1);
    assert.equal(payload.prior_support_omitted_count, 1);
    assert.ok(JSON.stringify(payload.qualified_prior_question_support).length < 24_100);
    assert.ok(!('earlier_answers_to_this_question' in payload));
    assert.ok(!('earlier_context_omitted_count' in payload));
  });
  assert.equal(assessed.completed, true);
});

function phasedRuntime(name: string, respond: (payload: ReturnType<typeof contextPayload>, context: Context) => unknown): PiModelRuntime {
  const faux = fauxProvider({ provider: name }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 6 }, () => (context: Context) => respond(contextPayload(context), context)) as never[]);
  return { models, model: faux.getModel() as Model<Api> };
}

test('one assessment receives the full target, learner sources and code while narrow completion stays separate (faux)', async () => {
  const input = cumulativeWorkerFixture(['A', 'AB'], ['A']);
  currentWorkerAnswer(input, 'A', 'Before clearing, registration appends.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer)]);
  const label = 'Explain clearing to a new empty array, retaining the key, and later registration appending to that same array';
  input.project.study.dynamic_learning_plan![0]!.learning_target_defs![1]!.label = label;
  input.question = { ...structuredClone(input.question), question_id: 'q2', created_message_id: 'ask-q2',
    prompt: 'After clearing, explain value and key membership', target_ids: ['AB'], target_items: [label], answer_attempts: [] };
  displayedWorkerQuestion(input, input.question);
  input.project.messages.push(createMessage('assistant', 'TUTOR_MECHANISM_MUST_NOT_BECOME_LEARNER_PROOF'));
  for (const id of ['B', 'C']) {
    currentWorkerAnswer(input, id, id === 'B' ? 'Clearing writes a new empty array and keeps the key.'
      : 'Clearing writes a new empty array and keeps the key. Later registration appends to that same new array.');
    const phases: string[] = [];
    const result = await runUnderstandingAssessment({ ...input, modelRuntime: phasedRuntime('r7-entire-target-' + id, payload => {
      phases.push(payload.task_phase);
      assert.equal(payload.task_phase, 'semantic_assessment');
      assert.equal(payload.current_question.prompt, input.question.prompt);
      assert.equal(payload.current_question.targets[0].label, label);
      assert.deepEqual(payload.current_answer_parts, input.answerParts);
      assert.equal(payload.source_message_id, id);
      assert.deepEqual(payload.evidence[0].excerpt, ['export function entry() {', '  return core();', '}']);
      assert.equal(payload.evidence[0].incomplete, false);
      assert.deepEqual(payload.qualified_prior_question_support[0].answer_parts, ['Before clearing, registration appends.']);
      assert.ok(!JSON.stringify(payload).includes('TUTOR_MECHANISM'));
      // The model outcome is controlled: this verifies transport and reduction, not reasoning accuracy.
      return fauxAssistantMessage(fauxToolCall('submit_result', {
        answer_relevant: true, feedback: id === 'B' ? 'Later registration is separate remaining learning.' : 'The explanation covers the full target.', misconceptions: [],
        question_requirements: [{ prompt_span: input.question.prompt, target_ids: ['AB'], outcome: 'satisfied', answer_spans: [input.answer],
          prior_answer_message_ids: [], evidence_ids: [evidence.stable_id], reason: 'The actual prompt is answered' }],
        target_results: [currentTargetResult('AB', id === 'B' ? 'unproven' : 'proven', input.answer)],
      }));
    }) });
    assert.equal(result.completed, true); assert.equal(result.verdict, 'mastered'); assert.equal(result.questionResult!.complete, true);
    assert.equal(result.targetResults[0]!.outcome, id === 'B' ? 'unproven' : 'proven');
    assert.deepEqual(phases, ['semantic_assessment']);
    assert.equal(result.trace.diagnostics!.requestCount, 1);
    assert.equal(result.trace.assessment_stages!.length, 1);
    applyTargetAssessment(input.project, input.question, id, input.answerParts, result.targetResults, undefined, result.questionResult);
    const prior = priorTargetCoverageForAssessment(input.project, input.question, input.project.study.dynamic_learning_plan![0]!);
    assert.equal(prior.coverage.A!.proven, true); assert.equal(prior.coverage.A!.message_id, 'A');
    assert.equal(prior.coverage.AB!.proven, id === 'C');
  }
});

test('assessment preserves the first structural rejection and rejects fabricated learner spans without another judge (faux)', async t => {
  for (const repaired of [false, true]) await t.test(repaired ? 'structural repair' : 'still invalid', async () => {
    const input = targetAssessmentFixture(['A']); let semanticRequests = 0;
    const result = await runUnderstandingAssessment({ ...input, modelRuntime: phasedRuntime('assessment-source-failures-' + repaired, payload => {
      assert.equal(payload.task_phase, 'semantic_assessment');
      semanticRequests++;
      return fauxAssistantMessage(fauxToolCall('submit_result', { answer_relevant: true, feedback: 'Correct', misconceptions: [],
        question_requirements: syntheticQuestionResult(payload, [targetResult('A', 'proven')]).requirements,
        target_results: [{ ...targetResult('A', 'proven'), answer_spans: repaired && semanticRequests > 1 ? ['calls core'] : ['invented'] }] }));
    }) });
    assert.equal(result.completed, repaired); assert.equal(semanticRequests, 2);
    assert.equal(result.trace.assessment_stages!.length, 1);
    assert.equal(result.trace.assessment_stages![0]!.submissions!.length, 2);
    assert.equal(result.trace.assessment_stages![0]!.submissions![0]!.validation_errors[0]!.code, 'exact_current_span');
    assert.equal(result.trace.assessment_stages![0]!.completed, repaired);
    assert.equal(result.trace.diagnostics!.requestCount, 2);
    assert.equal(input.project.study.target_assessments?.length ?? 0, 0);
  });
});

test('R7-2 compact context gives historical A and current B separate responsibilities without duplicating originals (faux)', async () => {
  const input = cumulativeWorkerFixture(); currentWorkerAnswer(input, 'm1', 'HISTORICAL_A calls core.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer), targetResult('B', 'unproven')]);
  currentWorkerAnswer(input, 'm2', 'CURRENT_B removes one handler.');
  const current = [targetResult('A', 'not_addressed'), currentTargetResult('B', 'proven', input.answer)];
  let suppliedSupports: unknown;
  const result = await fauxCumulativeAssessment(input, current, context => {
    const payload = contextPayload(context); const text = JSON.stringify(payload);
    suppliedSupports = structuredClone(payload.qualified_prior_question_support);
    assert.equal(text.split('HISTORICAL_A calls core.').length - 1, 1);
    assert.equal(text.split('CURRENT_B removes one handler.').length - 1, 1);
    for (const field of ['original_user_answer', 'answer_to_current_question', 'original_user_message', 'earlier_answers_to_this_question', 'prior_target_coverage'])
      assert.ok(!(field in payload), field);
    const targetA = payload.current_question.targets.find((target: { target_id: string }) => target.target_id === 'A');
    assert.equal(targetA.prior_status, 'proven'); assert.deepEqual(targetA.prior_source_message_ids, ['m1']);
    assert.match(targetA.current_result_duty, /not_addressed/);
    const source = payload.qualified_prior_question_support[0];
    assert.deepEqual(source.proven_target_ids, ['A']); assert.ok(!('target_results' in source)); assert.ok(!('question_result' in source));
  });
  assert.equal(result.questionResult!.complete, true); assert.equal(result.targetResults[0]!.outcome, 'not_addressed');
  assert.deepEqual(result.reviewContext!.qualified_prior_question_supports, suppliedSupports,
    'feedback review must use the same authorized historical sources supplied to the owner');
  assert.deepEqual(result.reviewContext!.current_answer_parts, ['CURRENT_B removes one handler.']);
  assert.deepEqual(result.reviewContext!.target_results, result.targetResults);
  const frozenReviewContext = structuredClone(result.reviewContext);
  const applied = applyCumulativeResult(input, result.targetResults); assert.equal(applied.coverage.A!.message_id, 'm1');
  assert.deepEqual(result.reviewContext, frozenReviewContext, 'applying the new result cannot retroactively change its prior review context');
});

test('R7-2 compact context cannot turn an old source into current spans and still exposes current contradiction (faux)', async () => {
  const input = cumulativeWorkerFixture(['A'], ['A']); currentWorkerAnswer(input, 'm1', 'OLD_A calls core.');
  applyCumulativeResult(input, [currentTargetResult('A', 'proven', input.answer)]);
  currentWorkerAnswer(input, 'm2', 'CURRENT_A never calls core.');
  const invalid = { ...targetResult('A', 'proven'), answer_spans: ['OLD_A calls core.'], prior_answer_message_ids: ['m1'] };
  const denied = await runUnderstandingAssessment({ ...input, modelRuntime: runtime('r7-compact-source-negative',
    fauxAssistantMessage(fauxToolCall('submit_result', targetSubmission([invalid])))) });
  assert.equal(denied.completed, false);
  assert.equal(denied.trace.assessment_stages![0]!.submissions![0]!.validation_errors[0]!.code, 'exact_current_span');
  const contradiction = [currentTargetResult('A', 'contradicted', input.answer)];
  const corrected = await fauxCumulativeAssessment(input, contradiction, context => {
    const payload = contextPayload(context); assert.deepEqual(payload.current_answer_parts, [input.answer]);
    assert.equal(payload.current_question.targets[0].prior_status, 'proven');
  });
  assert.equal(corrected.verdict, 'misconception'); assert.equal(applyCumulativeResult(input, corrected.targetResults).coverage.A!.proven, false);
});
