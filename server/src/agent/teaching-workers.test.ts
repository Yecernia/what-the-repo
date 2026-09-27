import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createMessage, createProject, emptyProfile } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { generateLearningRoute, runUnderstandingAssessment } from "./teaching-workers.js";
import type { PiModelRuntime } from "./types.js";

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
  faux.setResponses(Array.isArray(response) ? response as never[] : [response as never]);
  return { models, model: faux.getModel() as Model<Api> };
}

function selectedRuntime(role: "learning-route" | "understanding-assessment", selected: PiModelRuntime): PiModelRuntime {
  return { ...runtime("unused-chat-model", () => assert.fail("a configured teaching role must not call the chat model")), roleRuntimes: { [role]: selected } };
}

const store = {
  readSourceLines: async () => ({ lines: ["export function entry() {", "  return core();", "}"], truncated: false }),
} as unknown as ProductStore;

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
    })))),
  });
  assert.equal(result.completed, true);
  assert.equal(result.verdict, "mastered");
  assert.equal(result.trace.provider, "assessment-valid");
  assert.deepEqual(result.masteredItems, ["理解入口流程"]);
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
    completion_check: "能说明证据。", component_ids: ["component:entry"], evidence_refs: [evidence.stable_id],
  }];
  const before = structuredClone(project.study);
  const result = await runUnderstandingAssessment({
    question: { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'learning:entry', prompt: 'Entry?', target_items: ['entry'], evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 },
    answer: "入口会调用核心逻辑。", evidence: [evidence], project, snapshot: snapshot(), store,
    modelRuntime: selectedRuntime("understanding-assessment", runtime("assessment-fabricated", fauxAssistantMessage(fauxToolCall("submit_result", {
      answer_relevant: true, verdict: "mastered", feedback: "已掌握。", mastered_items: ["理解入口流程"], misconceptions: [], evidence_ids: ["fact:invented"],
    })))),
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
    modelRuntime: selectedRuntime("learning-route", runtime("route-empty", (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const user = context.messages.find(row => row.role === "user")!;
      const text = typeof user.content === "string" ? user.content
        : (user.content as Array<{ type: string; text: string }>).filter(row => row.type === "text").map(row => row.text).join("");
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
  project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Double', objective: 'Entire step', completion_check: 'Hidden broad rubric', learning_targets: ['Result', 'Fallback'], evidence_refs: [evidence.stable_id], component_ids: ['component:entry'] }];
  const longEvidence = { ...evidence, start_line: 10, end_line: 46 };
  const question = { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'step', prompt: 'What does double return?', target_items: ['Result'], evidence: [longEvidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 };
  const result = await runUnderstandingAssessment({ question, project, snapshot: snapshot(), evidence: [longEvidence], answer: 'Tell me about something else', store: { readSourceLines: async (_p: string, _s: string, _path: string, start: number, end: number) => ({ lines: Array.from({ length: end - start + 1 }, (_, i) => start + i === 45 ? 'return x * 2;' : '// context'), truncated: false }) } as unknown as ProductStore,
    modelRuntime: runtime('narrow-question', (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const user = context.messages.find(row => row.role === 'user')!;
      const text = typeof user.content === 'string' ? user.content : (user.content as Array<{ text: string }>).map(row => row.text).join('');
      const payload = JSON.parse(text); assert.deepEqual(payload.current_question.target_items, ['Result']); assert.equal(payload.current_step, undefined); assert.ok(payload.evidence[0].excerpt.includes('return x * 2;'));
      return fauxAssistantMessage(fauxToolCall('submit_result', { answer_relevant: false, verdict: 'mastered', feedback: 'Not an answer', mastered_items: [], misconceptions: [], evidence_ids: [evidence.stable_id] }));
    }) });
  assert.equal(result.completed, true); assert.equal(result.verdict, 'unclear');
});

test('missing source body cannot yield mastery from a graph label', async () => {
  const project = createProject('owner:missing-body', 'https://github.com/example/repo', 'repo', 'free:test');
  project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Entry', objective: 'Entry', completion_check: 'Entry?', component_ids: ['component:entry'], evidence_refs: [evidence.stable_id] }];
  const question = { question_id: 'q', snapshot_id: 'snapshot:teaching-worker', route_revision: 0, step_id: 'step', prompt: 'Entry?', target_items: ['Entry?'], evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'm', assessment_sequence: 0 };
  const result = await runUnderstandingAssessment({ question, project, snapshot: snapshot(), evidence: [evidence], answer: 'core()', store: { readSourceLines: async () => { throw new Error('missing source'); } } as unknown as ProductStore,
    modelRuntime: runtime('missing-body', fauxAssistantMessage(fauxToolCall('submit_result', { answer_relevant: true, verdict: 'mastered', feedback: 'Correct', mastered_items: ['Entry'], misconceptions: [], evidence_ids: [evidence.stable_id] }))) });
  assert.equal(result.completed, false); assert.deepEqual(result.acceptedEvidenceIds, []);
});
