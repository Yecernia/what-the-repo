import { assessmentTestReviewContext } from './assessment-test-context.js';
import type { runUnderstandingAssessment } from './teaching-workers.js';
import assert from "node:assert/strict";
import test from "node:test";
import { createMessage, createProject, emptyProfile } from "../domain/conversation.js";
import { conversationSummaryFromSource } from '../domain/conversation-summary.js';
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { createConversationTools, type ConversationToolContext } from "./conversation-tools.js";
import { applyConfirmedLearningAction } from "./learning-actions.js";
import { restoreDisplayedTeachingQuestion } from './conversation-reply.js';
import { applyTargetAssessment, targetsForStep } from './target-coverage.js';
import type { TeachingQuestion } from './teaching-question.js';
import { CONFIRMED_LESSON_TASK, confirmedLessonSourceId } from '../domain/confirmed-lesson.js';
import { createLearningActionProposal, completeLearningAction } from './learning-actions.js';

const evidence = {
  stable_id: "fact:file:entry",
  label: "src/entry.ts",
  path: "src/entry.ts",
  start_line: 1,
  end_line: 3,
  kind: "file",
};

function snapshot(): EvidenceSnapshot {
  return {
    snapshot_id: "snapshot:tools",
    summary: { file_count: 1, symbol_count: 1, call_count: 0, component_count: 1 },
    graph: {
      semantic_mode: "provider_supported",
      nodes: [{
        id: "component:entry",
        label: "入口",
        name: "入口",
        responsibility: "接收请求并返回结果。",
        grouping_rationale: "同一入口职责。",
        architecture_layer_id: "layer:application",
        architecture_layer_name: "应用层",
        architecture_layer_rationale: "对外接收请求。",
        members: [evidence],
        member_count: 1,
        evidence: [evidence],
        certainty: "verified",
        review_status: "reviewed",
        fan_in: 0,
        fan_out: 0,
      }],
      edges: [],
      layers: [{
        id: "layer:application",
        name: "应用层",
        responsibility: "接收外部请求。",
        component_ids: ["component:entry"],
        evidence: [evidence],
        certainty: "verified",
      }],
      unassigned_component_ids: [],
    },
    value_points: [{
      stable_id: "value:entry",
      kind: "value_point",
      title: "入口职责边界",
      claim: "入口负责协调。",
      problem: null,
      implementation: null,
      tradeoffs: null,
      transfer_conditions: null,
      certainty: "supported",
      evidence: [evidence],
      connectivity: 1,
    }],
    languages: [],
    learning_plan: { snapshot_id: "snapshot:tools", selected_value_point: null, steps: [] },
  };
}

function context(overrides: Partial<ConversationToolContext> = {}): ConversationToolContext {
  const project = createProject("owner:tools", "https://github.com/example/tools", "tools", "free:test");
  project.analysis.snapshot_id = "snapshot:tools";
  project.analysis.stage = "done";
  return {
    project,
    snapshot: snapshot(),
    profile: emptyProfile(),
    agentMemories: [],
    store: { readSourceLines: async () => ({ lines: ["export function entry() {}"], truncated: false }) } as unknown as ProductStore,
    selected: [],
    exposedEvidence: new Map(),
    exposedPaths: new Set(),
    toolsUsed: [],
    pendingLearningAction: { value: null },
    assessment: { value: null },
    candidates: { project: null },
    currentUserMessage: "我想学习这个仓库",
    modelRuntime: null as never,
    workerRuns: [],
    ...overrides,
  };
}

function recordFixturePass(ctx: ConversationToolContext) {
  const step = ctx.project.study.dynamic_learning_plan![ctx.project.study.current_step]!;
  const targets = targetsForStep(step);
  const answer = createMessage('user', '入口职责', { message_id: 'proof-answer' });
  ctx.project.messages.push(answer);
  const question: TeachingQuestion = { question_id: 'proof-question', snapshot_id: 'snapshot:tools', route_revision: 0,
    step_id: step.step_id, prompt: step.completion_check, target_items: targets.map(target => target.label), target_ids: targets.map(target => target.target_id),
    evidence: [evidence], answers: [], answer_message_ids: [], created_message_id: 'proof-lesson', assessment_sequence: 0 };
  ctx.project.messages.unshift(createMessage('user', 'Start', { message_id: question.created_message_id, analysis_snapshot_id: question.snapshot_id }),
    createMessage('assistant', question.prompt, { analysis_snapshot_id: question.snapshot_id, teaching_question: structuredClone(question),
      teaching_context: { snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id } }));
  applyTargetAssessment(ctx.project, question, answer.message_id, [answer.content], targets.map(target => ({ target_id: target.target_id,
    outcome: 'proven', reason: 'Controlled prior qualified proof.', answer_spans: [answer.content], evidence_ids: [evidence.stable_id] })));
}

test('learning context retrieves fact-only references without a full graph and exposes them to source reads', async () => {
  const fact = { ...evidence, stable_id: 'fact:symbol:hidden', path: 'src/hidden.ts' };
  const requests: unknown[] = [];
  const ctx = context({ store: {
    readPublicSnapshotEvidence: async (request: unknown) => { requests.push(request); return [fact]; },
    readSourceLines: async () => ({ lines: ['function hidden() {}'], truncated: false }),
  } as unknown as ProductStore });
  ctx.project.analysis.canonical_snapshot_key = 'canonical';
  ctx.project.study.dynamic_learning_plan = [{ step_id: 'step:1', order: 0, title: 'Hidden',
    objective: 'Read the implementation', evidence_refs: [fact.stable_id, evidence.stable_id, 'missing'],
    component_ids: [], completion_check: 'Explain it' }];
  const tools = createConversationTools(ctx);
  const result = await tools.find(tool => tool.name === 'get_learning_context')!.execute('learn', {});
  const body = JSON.parse((result.content[0] as { text: string }).text);
  // A plain status accompanies the internal fields so the tutor can describe progress without phase values.
  assert.equal(body.plain_status, 'No learning target has been chosen and there is no route yet.');
  assert.deepEqual(requests, [{ publicKey: 'canonical', snapshotId: 'snapshot:tools', evidenceIds: [fact.stable_id, 'missing'] }]);
  assert.deepEqual(body.current_step_evidence.map((row: typeof fact) => row.stable_id), [fact.stable_id, evidence.stable_id]);
  assert.equal(ctx.exposedEvidence.get(fact.stable_id), fact);
  assert.ok(ctx.exposedPaths.has(fact.path));
  await tools.find(tool => tool.name === 'read_source_excerpt')!.execute('read', { path: fact.path });
});

test("online conversation tools keep explanation in Primary and expose one action proposal tool", () => {
  const names = createConversationTools(context()).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "assess_understanding",
    "get_component_context",
    "get_learner_profile",
    "get_learning_context",
    "get_project_overview",
    "get_static_file_facts",
    "interpret_teaching_turn",
    "list_value_points",
    "propose_learning_action",
    "query_code_evidence",
    "read_source_excerpt",
    "register_teaching_question",
    "submit_conversation_reply",
  ]);
});

test('learner tool reloads preferences and respects a pause after tools were constructed', async () => {
  const profile = emptyProfile();
  const tool = createConversationTools(context({ getLearner: async () => ({ profile, memories: [] }) }))
    .find(row => row.name === 'get_learner_profile')!;
  profile.explanation_preference = '最新偏好';
  const latest = await tool.execute('latest', {});
  assert.equal(JSON.parse((latest.content[0] as { text: string }).text).explicit.explanation_preference, '最新偏好');
  profile.enabled = false;
  const paused = await tool.execute('paused', {});
  const result = JSON.parse((paused.content[0] as { text: string }).text);
  assert.equal(result.enabled, false); assert.equal(result.explicit, undefined);
});

test("static file facts require exposed paths and page unresolved sites from the store", async () => {
  const reads: unknown[][] = [];
  const ctx = context({ store: { readStaticFile: async (...args: unknown[]) => {
    reads.push(args);
    return { path: evidence.path, language: "typescript", syntax_completed: true, semantic_completed: false,
      diagnostics: [], imports: [], calls: Array.from({ length: 60 }, (_, line) => ({
        id: `call:${line}`, callee: "missing", line: line + 1, column: 0, callerStableId: null, argumentCount: 0, status: "unresolved",
      })) };
  } } as unknown as ProductStore });
  const tools = createConversationTools(ctx);
  const facts = tools.find(tool => tool.name === "get_static_file_facts")!;
  await assert.rejects(facts.execute("unknown", { path: evidence.path, kind: "calls" }), /Expose this file path with an evidence or component tool first/);
  assert.equal(reads.length, 0);
  await tools.find(tool => tool.name === "get_component_context")!.execute("component", { component_id: "component:entry" });
  const result = await facts.execute("page", { path: evidence.path, kind: "calls", limit: 20 });
  const page = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(reads, [[ctx.project.project_id, "snapshot:tools", evidence.path]]);
  assert.equal(page.items.length, 20);
  assert.equal(page.next_offset, 20);
  assert.equal(page.total, 60);
  assert.equal(page.items[0].status, "unresolved");
  assert.equal(page.semantic_completed, false);
});

test("conversation source reads require exposed evidence and stay bound to the snapshot", async () => {
  const reads: unknown[][] = [];
  const ctx = context({
    store: { readSourceLines: async (...args: unknown[]) => {
      reads.push(args);
      return { lines: ["first", "second", "third"], truncated: false };
    } } as unknown as ProductStore,
  });
  const tools = createConversationTools(ctx);
  const source = tools.find((tool) => tool.name === "read_source_excerpt")!;
  await assert.rejects(source.execute("unexposed", { path: evidence.path }), /Expose this file path with an evidence or component tool first/);
  assert.equal(reads.length, 0);
  await tools.find((tool) => tool.name === "get_component_context")!.execute("component", { component_id: "component:entry" });
  for (const path of ["../entry.ts", "/src/entry.ts", "src/missing.ts"]) {
    await assert.rejects(source.execute("unsafe", { path }), /Expose this file path with an evidence or component tool first/);
  }
  assert.equal(reads.length, 0);
  const result = await source.execute("source", { path: evidence.path, offset: 1, limit: 2 });
  const payload = JSON.parse(String((result.content[0] as { text: string }).text));
  assert.deepEqual(reads, [[ctx.project.project_id, "snapshot:tools", evidence.path, 1, 3]]);
  assert.equal(payload.content, "first\nsecond");
  assert.equal(payload.truncated, true);
  assert.equal(payload.next_offset, 3);
  assert.equal(payload.evidence[0].start_line, 1); assert.equal(payload.evidence[0].end_line, 2);
  assert.ok(ctx.exposedEvidence.has(payload.evidence[0].stable_id));
});

test('canonical evidence, source and static facts use captured identity without opening the full view', async () => {
  let fullReads = 0;
  const requests: unknown[][] = [];
  const staticFile = { path: evidence.path, language: 'typescript', syntax_completed: true,
    semantic_completed: true, diagnostics: [], imports: [], calls: [] };
  const ctx = context({ snapshot: null, snapshotId: 'snapshot:tools', publicSnapshotKey: 'canonical',
    getSnapshot: async () => { fullReads++; throw new Error('unexpected full view'); },
    store: {
      queryPublicSnapshot: async (input: unknown) => {
        requests.push(['query', input]);
        return { nodes: [{ node_key: 'node:key', node_id: 'component:entry', name: '入口',
          responsibility: '接收请求', layer_name: '应用层', certainty: 'verified' }], edges: [],
          evidence: [{ ...evidence, evidence_id: evidence.stable_id }],
          evidence_links: [{ owner_kind: 'node', owner_key: 'node:key', evidence_id: evidence.stable_id }],
          next_cursor: null, truncated: false };
      },
      readSourceLines: async (...args: unknown[]) => {
        requests.push(['source', ...args]); return { lines: ['export function entry() {}'], truncated: false };
      },
      readStaticFile: async (...args: unknown[]) => { requests.push(['static', ...args]); return staticFile; },
    } as unknown as ProductStore,
  });
  const tools = createConversationTools(ctx);
  const run = (name: string, params: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(name, params);
  await assert.rejects(run('read_source_excerpt', { path: evidence.path }), /Expose this file path with an evidence or component tool first/);
  await assert.rejects(run('get_static_file_facts', { path: evidence.path, kind: 'calls' }), /Expose this file path with an evidence or component tool first/);
  assert.equal(requests.length, 0);
  const query = await run('query_code_evidence', { text: 'entry' });
  assert.equal(JSON.parse((query.content[0] as { text: string }).text).nodes.length, 1);
  assert.ok(ctx.exposedPaths.has(evidence.path));
  await run('read_source_excerpt', { path: evidence.path });
  const facts = await run('get_static_file_facts', { path: evidence.path, kind: 'calls' });
  assert.equal(JSON.parse((facts.content[0] as { text: string }).text).path, evidence.path);
  assert.equal(fullReads, 0);
  assert.deepEqual(requests.map(row => row[0]), ['query', 'source', 'static']);
  assert.deepEqual(requests[1]!.slice(1, 4), [ctx.project.project_id, 'snapshot:tools', evidence.path]);
  assert.deepEqual(requests[2]!.slice(1), [ctx.project.project_id, 'snapshot:tools', evidence.path]);
  const changed = new Error('snapshot_changed');
  ctx.assertSnapshotBinding = async () => { throw changed; };
  await assert.rejects(run('query_code_evidence', { text: 'entry' }), error => error === changed);
  assert.equal(requests.length, 3, 'changed binding is rejected before indexed reads');
});

test('canonical static facts match the full-view inline result and complex tools share one reader', async () => {
  const file = { path: evidence.path, language: 'typescript', syntax_completed: true,
    semantic_completed: true, diagnostics: [], imports: [], calls: [] };
  const full = snapshot();
  full.static_analysis = { files: [file] } as unknown as typeof full.static_analysis;
  const direct = context({ snapshot: full, exposedPaths: new Set([evidence.path]) });
  const directTool = createConversationTools(direct).find(tool => tool.name === 'get_static_file_facts')!;
  const oldResult = await directTool.execute('old', { path: evidence.path, kind: 'calls' });
  let reads = 0;
  let memo: Promise<EvidenceSnapshot> | undefined;
  const lazy = context({ snapshot: null, snapshotId: full.snapshot_id, publicSnapshotKey: 'canonical',
    exposedPaths: new Set([evidence.path]),
    getSnapshot: () => memo ??= Promise.resolve().then(() => { reads++; return full; }),
    store: { readStaticFile: async () => file } as unknown as ProductStore,
  });
  const tools = createConversationTools(lazy);
  const newResult = await tools.find(tool => tool.name === 'get_static_file_facts')!
    .execute('new', { path: evidence.path, kind: 'calls' });
  assert.deepEqual(JSON.parse((newResult.content[0] as { text: string }).text),
    JSON.parse((oldResult.content[0] as { text: string }).text));
  assert.equal(reads, 0);
  const [overview, component, learning] = await Promise.all([
    tools.find(tool => tool.name === 'get_project_overview')!.execute('overview', {}),
    tools.find(tool => tool.name === 'get_component_context')!.execute('component', { component_id: 'component:entry' }),
    tools.find(tool => tool.name === 'get_learning_context')!.execute('learning', {}),
  ]);
  assert.ok(overview.content.length && component.content.length && learning.content.length);
  assert.equal(reads, 1);
});

test('canonical static facts fall back to the full view only for an absent per-file index', async () => {
  const file = { path: evidence.path, language: 'typescript', syntax_completed: true,
    semantic_completed: true, diagnostics: [], imports: [], calls: [] };
  const full = snapshot();
  full.static_analysis = { files: [file] } as unknown as typeof full.static_analysis;
  let reads = 0;
  const ctx = context({ snapshot: null, snapshotId: full.snapshot_id, publicSnapshotKey: 'canonical',
    exposedPaths: new Set([evidence.path]),
    getSnapshot: async () => { reads++; return full; },
    store: { readStaticFile: async () => null } as unknown as ProductStore,
  });
  const result = await createConversationTools(ctx).find(tool => tool.name === 'get_static_file_facts')!
    .execute('legacy', { path: evidence.path, kind: 'calls' });
  assert.equal(JSON.parse((result.content[0] as { text: string }).text).path, evidence.path);
  assert.equal(reads, 1);
});

test('overview and value points share a summary and preserve payload and evidence exposure', async () => {
  const full = snapshot();
  const originalPoint = full.value_points[0]!;
  full.value_points = Array.from({ length: 10 }, (_, pointIndex) => ({
    ...originalPoint, stable_id: `value:${pointIndex}`, tradeoffs: `tradeoff:${pointIndex}`,
    evidence: Array.from({ length: 8 }, (_, evidenceIndex) => ({
      ...evidence, stable_id: `fact:file:${pointIndex}:${evidenceIndex}`,
      path: `src/file-${pointIndex}-${evidenceIndex}.ts`,
    })),
  }));
  const projected = conversationSummaryFromSource(full)!;
  let summaryReads = 0;
  let fullReads = 0;
  let pending: Promise<typeof projected> | undefined;
  const oldContext = context({ snapshot: full });
  const newContext = context({ snapshot: null,
    getSnapshot: async () => { fullReads++; throw new Error('unexpected full view'); },
    getSummary: () => pending ??= Promise.resolve().then(() => { summaryReads++; return projected; }),
  });
  const oldTools = createConversationTools(oldContext);
  const newTools = createConversationTools(newContext);
  const oldOverview = await oldTools.find(tool => tool.name === 'get_project_overview')!.execute('old-overview', {});
  const oldValues = await oldTools.find(tool => tool.name === 'list_value_points')!.execute('old-values', { limit: 8 });
  const [newOverview, newValues] = await Promise.all([
    newTools.find(tool => tool.name === 'get_project_overview')!.execute('new-overview', {}),
    newTools.find(tool => tool.name === 'list_value_points')!.execute('new-values', { limit: 8 }),
  ]);
  const body = (result: typeof newOverview) => JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(body(newOverview), body(oldOverview));
  assert.deepEqual(body(newValues), body(oldValues));
  assert.equal(body(newOverview).value_points[0].evidence.length, 4);
  assert.equal(body(newValues).value_points[0].evidence.length, 6);
  assert.equal(body(newOverview).value_points.length, 8);
  assert.equal(body(newValues).value_points.length, 8);
  assert.equal(body(newValues).value_points[2].tradeoffs, 'tradeoff:2');
  const limited = await newTools.find(tool => tool.name === 'list_value_points')!
    .execute('limited', { limit: 3 });
  assert.deepEqual(body(limited).value_points.map((point: { stable_id: string }) => point.stable_id),
    ['value:0', 'value:1', 'value:2']);
  assert.deepEqual([...newContext.exposedEvidence.keys()], [...oldContext.exposedEvidence.keys()]);
  assert.deepEqual([...newContext.exposedPaths], [...oldContext.exposedPaths]);
  assert.equal(summaryReads, 1);
  assert.equal(fullReads, 0);
});

test('missing or failed summaries never silently widen overview to the full view', async () => {
  let fullReads = 0;
  const ctx = context({ snapshot: null,
    getSnapshot: async () => { fullReads++; return snapshot(); },
    getSummary: async () => null,
  });
  const overview = createConversationTools(ctx).find(tool => tool.name === 'get_project_overview')!;
  await assert.rejects(overview.execute('missing', {}), /project analysis has not finished/);
  assert.equal(fullReads, 0);
  const failed = new Error('summary unavailable');
  ctx.getSummary = async () => { throw failed; };
  await assert.rejects(overview.execute('failed', {}), error => error === failed);
  assert.equal(fullReads, 0);
});

test("propose_learning_action creates a pending card without changing study state", async () => {
  const ctx = context();
  const before = structuredClone(ctx.project.study);
  const tools = createConversationTools(ctx);
  await tools.find(item => item.name === "interpret_teaching_turn")!.execute("interpret", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  const tool = tools.find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  const result = await tool.execute("proposal", {
    action: "start_learning_route",
    target_kind: "value_point",
    target_id: "value:entry",
  });
  const text = String((result.content[0] as { text: string }).text);
  const payload = JSON.parse(text) as { confirmation_required: boolean; for_reply: string };
  assert.equal(payload.confirmation_required, true);
  assert.equal(ctx.pendingLearningAction.value?.status, "pending");
  assert.deepEqual(ctx.project.study, before);
  // The interface renders the card; the tutor only learns what to say about it, never the card ID.
  assert.match(payload.for_reply, /program receipt supplies/);
  assert.doesNotMatch(text, /action_id|learning-action:/);
});

test("learning action proposal rejects fabricated targets", async () => {
  const ctx = context();
  const tools = createConversationTools(ctx);
  await tools.find(item => item.name === "interpret_teaching_turn")!.execute("interpret", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  const tool = tools.find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  await assert.rejects(
    tool.execute("proposal", {
      action: "switch_learning_target",
      target_kind: "component",
      target_id: "component:missing",
    }),
    /does not match the current snapshot or route/,
  );
});

test("explicit advance can create a skip card without an assessment", async () => {
  const ctx = context();
  ctx.currentUserMessage = "我明确要直接进入下一步，跳过检查";
  ctx.project.study.phase = "explaining";
  ctx.project.study.current_step = 0;
  ctx.project.study.total_steps = 2;
  ctx.project.study.dynamic_learning_plan = [{
    step_id: "learning:first",
    order: 1,
    title: "理解入口",
    objective: "说清入口职责。",
    component_ids: ["component:entry"],
    evidence_refs: [evidence.stable_id],
    completion_check: "能说明入口职责。",
  }, {
    step_id: "learning:second",
    order: 2,
    title: "理解返回路径",
    objective: "说清返回路径。",
    component_ids: ["component:entry"],
    evidence_refs: [evidence.stable_id],
    completion_check: "能说明返回路径。",
  }];
  const tools = createConversationTools(ctx);
  await tools.find(item => item.name === "interpret_teaching_turn")!.execute("interpret", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  const tool = tools.find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  await assert.rejects(tool.execute("missing-mode", { action: "advance_learning_step" }), /Specify advance_mode/);
  const result = await tool.execute("proposal", {
    action: "advance_learning_step",
    target_kind: "learning_step",
    target_id: "learning:first",
    advance_mode: "skip",
  });
  const text = String((result.content[0] as { text: string }).text);
  const payload = JSON.parse(text) as {
    confirmation_required: boolean;
    for_reply: string;
    proposal: { skipped_understanding_check: boolean };
  };
  // The model selects a skip, but only the learner confirming this card can apply it.
  assert.equal(payload.confirmation_required, true);
  assert.equal(ctx.project.study.current_step, 0);
  assert.equal(ctx.pendingLearningAction.value?.execution_policy, "confirm");
  assert.match(payload.for_reply, /program receipt supplies/);
  assert.equal(payload.proposal.skipped_understanding_check, true);
  // The tutor never receives the card ID, so it cannot repeat it to the learner.
  assert.doesNotMatch(text, /action_id|learning-action:/);
  assert.match(ctx.pendingLearningAction.value?.description ?? "", /主动跳过/);
  assert.equal(ctx.pendingLearningAction.value?.skip_understanding_check, true);
  await assert.rejects(tool.execute("change-mode", { action: "advance_learning_step", advance_mode: "complete" }), /only one card per turn/);
  assert.deepEqual(ctx.project.study.mastered, []);

  applyConfirmedLearningAction(ctx.project, ctx.pendingLearningAction.value!);
  assert.equal(ctx.project.study.current_step, 1);
  assert.deepEqual(ctx.project.study.mastered, []);
  assert.deepEqual(ctx.project.study.skipped_steps, ["learning:first"]);
});

test("mastered advance keeps the existing mastered progress behavior", async () => {
  const ctx = context();
  ctx.project.study.phase = "explaining";
  ctx.project.study.total_steps = 1;
  ctx.project.study.dynamic_learning_plan = [{
    step_id: "learning:mastered",
    order: 1,
    title: "理解入口",
    objective: "说清入口职责。",
    component_ids: ["component:entry"],
    evidence_refs: [evidence.stable_id],
    completion_check: "能说明入口职责。",
  }];
  recordFixturePass(ctx);
  const tools = createConversationTools(ctx);
  await tools.find(item => item.name === "interpret_teaching_turn")!.execute("interpret", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  const tool = tools.find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  await tool.execute("proposal", {
    action: "advance_learning_step",
    target_kind: "learning_step",
    target_id: "learning:mastered",
    advance_mode: "complete",
  });
  const action = ctx.pendingLearningAction.value;
  assert.ok(action);
  assert.equal(action.skip_understanding_check, false);
  applyConfirmedLearningAction(ctx.project, action);
  assert.deepEqual(ctx.project.study.mastered, ["能说明入口职责。"]);
  assert.deepEqual(ctx.project.study.skipped_steps, []);
  assert.equal(ctx.project.study.phase, "completed");
});

test("normal completion needs a current pass and remains distinct from the model selecting a skip", async () => {
  const ctx = context();
  ctx.currentUserMessage = "我没有看到确认卡片";
  ctx.project.study.phase = "explaining";
  ctx.project.study.total_steps = 1;
  ctx.project.study.dynamic_learning_plan = [{
    step_id: "learning:passed",
    order: 1,
    title: "理解入口",
    objective: "说清入口职责。",
    component_ids: ["component:entry"],
    evidence_refs: [evidence.stable_id],
    completion_check: "能说明入口职责。",
  }];
  const tools = createConversationTools(ctx);
  await tools.find(item => item.name === "interpret_teaching_turn")!.execute("interpret", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  const tool = tools.find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  const advance = { action: "advance_learning_step", advance_mode: "complete", target_kind: "learning_step", target_id: "learning:passed" };
  // Completion cannot borrow skip authority or infer it from the original message.
  await assert.rejects(tool.execute("proposal", advance), /Normal completion requires verified mastery/);
  assert.ok(!ctx.pendingLearningAction.value, "no card is created");

  // The pass recorded in an earlier turn is remembered for this step.
  recordFixturePass(ctx);
  const refreshed = createConversationTools(ctx);
  await refreshed.find(item => item.name === "interpret_teaching_turn")!.execute("interpret-prior-pass", { parts: [{ kind: "control", text: ctx.currentUserMessage }] });
  await refreshed.find(item => item.name === "propose_learning_action")!.execute("proposal", advance);
  // Read through a fresh reference: the assertion above narrowed the earlier one to empty.
  const pending: ConversationToolContext["pendingLearningAction"] = ctx.pendingLearningAction;
  const action = pending.value;
  assert.ok(action);
  assert.equal(action.skip_understanding_check, false);
  applyConfirmedLearningAction(ctx.project, action);
  assert.deepEqual(ctx.project.study.mastered, ["能说明入口职责。"]);
  assert.equal(ctx.project.study.phase, "completed");
  assert.equal(ctx.project.study.step_passed, null, "the next step is assessed afresh");
});

test("registered questions accumulate only their own answers and distinguish question correctness from step completion", async () => {
  const inputs: Array<Parameters<typeof runUnderstandingAssessment>[0]> = [];
  let verdict = 'mastered';
  const ctx = context({ source_message_id: 'ask', workerServices: { assess: (async (input: Parameters<typeof runUnderstandingAssessment>[0]) => {
    inputs.push(input); const result = { completed: true, feedback: 'feedback', verdict, masteredItems: ['target'], misconceptions: verdict === 'misconception' ? ['wrong direction'] : [], acceptedEvidenceIds: [evidence.stable_id],
      targetResults: input.question.target_ids!.map(target_id => ({ target_id, outcome: verdict === 'mastered' ? 'proven' : verdict === 'misconception' ? 'contradicted' : 'not_addressed',
        reason: verdict === 'misconception' ? 'wrong direction' : 'Controlled current answer.', answer_spans: verdict === 'unclear' ? [] : [input.answer], evidence_ids: verdict === 'unclear' ? [] : [evidence.stable_id] })), trace: { usage: null, evidence_ids: [] } };
    return { ...result, reviewContext: assessmentTestReviewContext(input, result as never) };
  }) as never } });
  ctx.project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Entry', objective: 'Entry', component_ids: ['component:entry'], evidence_refs: [evidence.stable_id], completion_check: 'Both', learning_targets: ['first', 'second'] }];
  ctx.project.study.phase = 'explaining';
  ctx.exposedEvidence.set(evidence.stable_id, evidence);
  let tools = createConversationTools(ctx);
  let register = tools.find(tool => tool.name === 'register_teaching_question')!;
  let assess = tools.find(tool => tool.name === 'assess_understanding')!;
  function commitPreview() { ctx.project.study = structuredClone(ctx.candidates!.project!.study); }
  async function answerTurn() {
    const prior = ctx.project.messages.find(message => message.message_id === ctx.source_message_id);
    if (prior) prior.content = ctx.currentUserMessage!;
    else ctx.project.messages.push(createMessage('user', ctx.currentUserMessage!, { message_id: ctx.source_message_id }));
    ctx.assessment.value = null; tools = createConversationTools(ctx);
    register = tools.find(tool => tool.name === 'register_teaching_question')!;
    assess = tools.find(tool => tool.name === 'assess_understanding')!;
    await tools.find(tool => tool.name === 'interpret_teaching_turn')!.execute('interpret', { parts: [{ kind: 'answer', text: ctx.currentUserMessage }] });
  }
  await assert.rejects(assess.execute('unregistered', { question_id: 'none' }), /registered current question/);
  const registration = await register.execute('q1', { prompt: 'First?', target_items: ['first'], evidence_ids: [evidence.stable_id] });
  const q1 = JSON.parse((registration.content[0] as { text: string }).text).question;
  assert.equal(ctx.project.study.teaching_question, undefined, 'registration is only a candidate');
  // Simulate the service's atomic save of a displayed lesson before the next turn.
  function display(question: typeof q1) {
    ctx.project.study.teaching_question = question;
    ctx.project.messages.push(createMessage('user', 'teach', { message_id: question.created_message_id, analysis_snapshot_id: question.snapshot_id }),
      createMessage('assistant', question.prompt, { teaching_question: structuredClone(question),
        teaching_context: { snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id } }));
  }
  display(q1);
  await assert.rejects(assess.execute('same-turn', { question_id: q1.question_id }), /wait for the learner answer/);
  ctx.source_message_id = 'answer1'; ctx.currentUserMessage = 'first answer';
  await answerTurn();
  const beforeAssessment = structuredClone(ctx.project.study);
  const result = await assess.execute('a1', { question_id: q1.question_id });
  assert.deepEqual(ctx.project.study, beforeAssessment, 'tools only prepare isolated candidate study');
  commitPreview();
  const body = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(body.question_correct, true); assert.equal(body.step_completed, false);
  assert.deepEqual(body.remaining_targets.map((target: { label: string }) => target.label), ['second']); assert.equal(ctx.project.study.step_passed, null);
  await assert.rejects(assess.execute('resample-same-turn', { question_id: q1.question_id }), /judgment is locked/);
  assert.equal(inputs.length, 1, 'a prepared assessment cannot be resampled within the same turn');
  await answerTurn(); // A new API attempt with the same original message may retry safely.
  await assess.execute('retry', { question_id: q1.question_id });
  commitPreview();
  assert.equal(ctx.project.study.teaching_question!.answer_attempts!.length, 1);
  ctx.currentUserMessage = 'edited first answer';
  await answerTurn();
  await assess.execute('edited', { question_id: q1.question_id });
  commitPreview();
  assert.deepEqual(ctx.project.study.teaching_question!.answer_attempts!.map(attempt => attempt.answer_parts), [['edited first answer']]);
  verdict = 'unclear'; ctx.source_message_id = 'chat'; ctx.currentUserMessage = 'unrelated topic';
  await answerTurn();
  await assess.execute('chat', { question_id: q1.question_id }); assert.equal(ctx.project.study.teaching_question!.answer_attempts!.length, 1);
  const second = await register.execute('q2', { prompt: 'Second?', target_items: ['second'], evidence_ids: [evidence.stable_id] });
  const q2 = JSON.parse((second.content[0] as { text: string }).text).question;
  display(q2);
  verdict = 'mastered'; ctx.source_message_id = 'answer2'; ctx.currentUserMessage = 'second answer';
  await answerTurn();
  await assess.execute('a2', { question_id: q2.question_id });
  commitPreview();
  assert.ok(ctx.project.study.step_passed);
  ctx.assessment.value = null; ctx.currentUserMessage = 'ordinary chat';
  assert.ok(ctx.project.study.step_passed, 'unassessed chat retains eligibility');
  verdict = 'misconception'; ctx.source_message_id = 'wrong'; ctx.currentUserMessage = 'wrong';
  await answerTurn();
  await assess.execute('wrong', { question_id: q2.question_id });
  commitPreview();
  assert.equal(ctx.project.study.step_passed, null); assert.deepEqual(ctx.project.study.misconceptions, ['wrong direction']);
  await assert.rejects(tools.find(tool => tool.name === 'propose_learning_action')!.execute('advance', { action: 'advance_learning_step', advance_mode: 'complete' }), /Normal completion requires verified mastery/);
});

test('legacy broad completion checks cannot be certified by registering a narrower question', async () => {
  const ctx = context({ source_message_id: 'ask' });
  ctx.project.study.dynamic_learning_plan = [{ step_id: 'legacy', order: 1, title: 'Entry', objective: 'Entry', component_ids: ['component:entry'], evidence_refs: [evidence.stable_id], completion_check: 'Explain both branches and their evidence.' }];
  ctx.exposedEvidence.set(evidence.stable_id, evidence);
  const register = createConversationTools(ctx).find(tool => tool.name === 'register_teaching_question')!;
  await assert.rejects(register.execute('narrow', { prompt: 'Which branch?', target_items: ['Explain both branches and their evidence.'], evidence_ids: [evidence.stable_id] }), /legacy step/);
  const registered = await register.execute('full', { prompt: 'Explain both branches and their evidence.', target_items: ['Explain both branches and their evidence.'], evidence_ids: [evidence.stable_id] });
  assert.equal(ctx.project.study.teaching_question, undefined);
  assert.equal(JSON.parse((registered.content[0] as { text: string }).text).question.prompt, 'Explain both branches and their evidence.');
});

test('canonicalized legacy question text remains recoverable with its original targets and display provenance', async () => {
  const prompt = 'Explain `entry.ts`?';
  const ctx = context({ source_message_id: 'ask-canonical', reply: { value: null } });
  ctx.store.listSourceFiles = async () => [evidence.path];
  ctx.project.study.phase = 'explaining';
  ctx.project.study.dynamic_learning_plan = [{ step_id: 'legacy', order: 1, title: 'Entry', objective: 'Entry',
    component_ids: ['component:entry'], evidence_refs: [evidence.stable_id], completion_check: prompt }];
  const user = createMessage('user', 'Start current step', { analysis_snapshot_id: 'snapshot:tools' });
  user.message_id = ctx.source_message_id!;
  ctx.project.messages = [user];
  ctx.exposedEvidence.set(evidence.stable_id, evidence);
  await createConversationTools(ctx).find(tool => tool.name === 'submit_conversation_reply')!.execute('lesson', {
    kind: 'lesson', text: 'Here is the entry.', question: { prompt, target_items: [prompt], evidence_ids: [evidence.stable_id] },
  });
  const question = ctx.reply!.value!.question!;
  assert.equal(question.prompt, 'Explain `src/entry.ts`?');
  const displayed = createMessage('assistant', `Here is the entry.\n\n${question.prompt}`, {
    teaching_context: { snapshot_id: 'snapshot:tools', route_revision: 0, step_id: 'legacy' },
    teaching_question: structuredClone(question),
  });
  ctx.project.messages.push(displayed);
  ctx.project.study.teaching_question = null;
  assert.equal(restoreDisplayedTeachingQuestion(ctx.project, ctx.project.messages, 'answer-canonical'), true);
  assert.equal(ctx.project.study.teaching_question!.prompt, question.prompt);
  assert.deepEqual(ctx.project.study.teaching_question!.target_items, [prompt]);
});

test('a confirmed program lesson cannot grade history, propose actions or defer its question', async () => {
  const ctx = context({ confirmedLesson: true, currentUserMessage: CONFIRMED_LESSON_TASK, reply: { value: null } });
  const before = structuredClone(ctx.project.study);
  const tools = createConversationTools(ctx);
  const tool = (name: string) => tools.find(tool => tool.name === name)!;
  await assert.rejects(tool('interpret_teaching_turn').execute('answer', { parts: [{ kind: 'answer', text: CONFIRMED_LESSON_TASK }] }), /program-initiated/);
  await assert.rejects(tool('assess_understanding').execute('grade', { question_id: 'old-question' }), /no learner answer/);
  await assert.rejects(tool('propose_learning_action').execute('advance', { action: 'advance_learning_step', advance_mode: 'skip' }), /already confirmed/);
  await assert.rejects(tool('submit_conversation_reply').execute('defer', { kind: 'answer', text: 'A deferred lesson.', question_policy: 'defer' }), /must submit kind=lesson/);
  assert.equal(ctx.pendingLearningAction.value, null);
  assert.equal(ctx.assessment.value, null);
  assert.deepEqual(ctx.project.study, before);
  await tool('submit_conversation_reply').execute('failed', { kind: 'unavailable' });
  assert.equal(ctx.reply!.value!.kind, 'unavailable');
  assert.match(ctx.reply!.value!.text, /已确认的学习步骤保留/);
  assert.deepEqual(ctx.candidates!.project!.study, before);
});

test('a question from a confirmed system source is recoverable only with its executed action provenance', async () => {
  const ctx = context({ confirmedLesson: true, currentUserMessage: CONFIRMED_LESSON_TASK, reply: { value: null } });
  ctx.project.study.phase = 'explaining';
  ctx.project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Entry', objective: 'Entry',
    component_ids: [], evidence_refs: [evidence.stable_id], completion_check: 'Explain entry.', learning_targets: ['Entry'] }];
  const action = createLearningActionProposal(ctx.project, ctx.snapshot!, { action: 'start_learning_route', targetKind: 'repository', request: 'Teach entry.' });
  completeLearningAction(ctx.project, action);
  action.outcome!.lesson_run_id = 'confirmed-lesson-first-run';
  const card = createMessage('assistant', 'Confirmed.', { learning_action: action });
  ctx.source_message_id = confirmedLessonSourceId(action.action_id);
  const source = createMessage('system', CONFIRMED_LESSON_TASK, { message_id: ctx.source_message_id,
    original_run_id: action.outcome!.lesson_run_id, analysis_snapshot_id: 'snapshot:tools',
    lesson_request: { action_id: action.action_id, snapshot_id: 'snapshot:tools', route_revision: 0, step_id: 'step' } });
  ctx.project.messages = [card, source];
  ctx.exposedEvidence.set(evidence.stable_id, evidence);
  await createConversationTools(ctx).find(tool => tool.name === 'submit_conversation_reply')!.execute('lesson', {
    kind: 'lesson', text: 'Here is the entry.', question: { prompt: 'Explain entry.', target_items: ['Entry'], evidence_ids: [evidence.stable_id] },
  });
  const question = ctx.reply!.value!.question!;
  ctx.project.messages.push(createMessage('assistant', `Here is the entry.\n\n${question.prompt}`, {
    teaching_question: structuredClone(question), teaching_context: { snapshot_id: 'snapshot:tools', route_revision: 0, step_id: 'step' },
  }));
  assert.equal(restoreDisplayedTeachingQuestion(ctx.project, ctx.project.messages, 'next-learner-answer'), true);
  assert.equal(ctx.project.study.teaching_question!.question_id, question.question_id);
  for (const tamper of ['action', 'source', 'binding'] as const) {
    const altered = structuredClone(ctx.project);
    altered.study.teaching_question = null;
    if (tamper === 'action') altered.messages[0]!.learning_action!.status = 'pending';
    if (tamper === 'source') altered.messages[1]!.content = 'An arbitrary system message.';
    if (tamper === 'binding') altered.messages[1]!.lesson_request!.step_id = 'other-step';
    assert.equal(restoreDisplayedTeachingQuestion(altered, altered.messages, 'next-learner-answer'), false, tamper);
    assert.equal(altered.study.teaching_question, null, tamper);
  }
});


test('assessment failures and irrelevant judgments lock the same turn before the worker runs', async () => {
  for (const outcome of ['failed', 'irrelevant', 'thrown'] as const) {
    let calls = 0;
    const ctx = context({ source_message_id: 'current', currentUserMessage: 'Current answer.', reply: { value: null },
      workerServices: { assess: (async () => {
        calls++;
        if (outcome === 'thrown') throw new Error('Controlled worker failure.');
        return { completed: outcome === 'irrelevant', answerRelevant: outcome === 'irrelevant' ? false : undefined,
          feedback: outcome === 'irrelevant' ? 'This is a follow-up.' : null, verdict: outcome === 'irrelevant' ? 'unclear' : null,
          targetResults: [], reviewContext: null, trace: { usage: null, evidence_ids: [] } };
      }) as never } });
    ctx.project.study.phase = 'explaining';
    ctx.project.study.dynamic_learning_plan = [{ step_id: 'step', order: 1, title: 'Entry', objective: 'Entry',
      component_ids: [], evidence_refs: [evidence.stable_id], completion_check: 'Explain entry.', learning_targets: ['Entry'] }];
    recordFixturePass(ctx);
    const savedQuestion = ctx.project.messages.find(message => message.teaching_question)!.teaching_question!;
    ctx.project.study.teaching_question = structuredClone(savedQuestion);
    ctx.project.messages.push(createMessage('user', ctx.currentUserMessage, { message_id: 'current' }));
    const before = structuredClone(ctx.project.study);
    const tools = createConversationTools(ctx);
    const tool = (name: string) => tools.find(tool => tool.name === name)!;
    await tool('interpret_teaching_turn').execute('partition', { parts: [{ kind: 'answer', text: ctx.currentUserMessage }] });
    await assert.rejects(tool('assess_understanding').execute('first', { question_id: savedQuestion.question_id }));
    await assert.rejects(tool('assess_understanding').execute('repeat', { question_id: savedQuestion.question_id }), /attempt.*locked/);
    await assert.rejects(tool('interpret_teaching_turn').execute('repartition', { parts: [{ kind: 'explain', text: ctx.currentUserMessage }] }), /cannot change/);
    assert.equal(calls, 1, outcome + ' may not launch another worker');
    assert.deepEqual(ctx.project.study, before);
    if (outcome === 'irrelevant') {
      await tool('submit_conversation_reply').execute('follow-up', { kind: 'answer', text: 'Here is the requested follow-up.' });
      assert.equal(ctx.reply!.value!.kind, 'answer');
    } else {
      await assert.rejects(tool('submit_conversation_reply').execute('bypass', { kind: 'answer', text: 'The answer is correct.' }), /Assess the answer/);
      await tool('submit_conversation_reply').execute('unavailable', { kind: 'unavailable' });
      assert.equal(ctx.reply!.value!.kind, 'unavailable');
    }
  }
});
