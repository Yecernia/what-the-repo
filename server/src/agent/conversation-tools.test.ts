import assert from "node:assert/strict";
import test from "node:test";
import { createMessage, createProject, emptyProfile } from "../domain/conversation.js";
import { conversationSummaryFromSource } from '../domain/conversation-summary.js';
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { createConversationTools, type ConversationToolContext } from "./conversation-tools.js";
import { applyConfirmedLearningAction } from "./learning-actions.js";

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
    currentUserMessage: "我想学习这个仓库",
    modelRuntime: null as never,
    workerRuns: [],
    ...overrides,
  };
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
    "list_value_points",
    "propose_learning_action",
    "query_code_evidence",
    "read_source_excerpt",
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
  const tool = createConversationTools(ctx).find((item) => item.name === "propose_learning_action");
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
  assert.match(payload.for_reply, /confirmation card under your reply/);
  assert.doesNotMatch(text, /action_id|learning-action:/);
});

test("learning action proposal rejects fabricated targets", async () => {
  const ctx = context();
  const tool = createConversationTools(ctx).find((item) => item.name === "propose_learning_action");
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
  const tool = createConversationTools(ctx).find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  const result = await tool.execute("proposal", {
    action: "advance_learning_step",
    target_kind: "learning_step",
    target_id: "learning:first",
  });
  const text = String((result.content[0] as { text: string }).text);
  const payload = JSON.parse(text) as {
    confirmation_required: boolean;
    for_reply: string;
    proposal: { skipped_understanding_check: boolean };
  };
  // The explicit request in this message is applied after the turn, so no card confirmation is needed.
  assert.equal(payload.confirmation_required, false);
  assert.match(payload.for_reply, /recorded as skipped \(not mastered\)/);
  assert.equal(payload.proposal.skipped_understanding_check, true);
  // The tutor never receives the card ID, so it cannot repeat it to the learner.
  assert.doesNotMatch(text, /action_id|learning-action:/);
  assert.match(ctx.pendingLearningAction.value?.description ?? "", /主动跳过/);
  assert.equal(ctx.pendingLearningAction.value?.skip_understanding_check, true);
  assert.deepEqual(ctx.project.study.mastered, []);

  applyConfirmedLearningAction(ctx.project, ctx.pendingLearningAction.value!);
  assert.equal(ctx.project.study.current_step, 1);
  assert.deepEqual(ctx.project.study.mastered, []);
  assert.deepEqual(ctx.project.study.skipped_steps, ["learning:first"]);
});

test("mastered advance keeps the existing mastered progress behavior", async () => {
  const ctx = context({
    assessment: {
      value: {
        verdict: "mastered",
        masteredItems: ["入口职责"],
        evidenceIds: [evidence.stable_id],
      },
    },
  });
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
  const tool = createConversationTools(ctx).find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  await tool.execute("proposal", {
    action: "advance_learning_step",
    target_kind: "learning_step",
    target_id: "learning:mastered",
  });
  const action = ctx.pendingLearningAction.value;
  assert.ok(action);
  assert.equal(action.skip_understanding_check, false);
  applyConfirmedLearningAction(ctx.project, action);
  assert.deepEqual(ctx.project.study.mastered, ["入口职责"]);
  assert.deepEqual(ctx.project.study.skipped_steps, []);
  assert.equal(ctx.project.study.phase, "completed");
});

test("a pass from an earlier turn still offers the advance as mastered, and the tutor cannot skip for the learner", async () => {
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
  const tool = createConversationTools(ctx).find((item) => item.name === "propose_learning_action");
  assert.ok(tool);
  const advance = { action: "advance_learning_step", target_kind: "learning_step", target_id: "learning:passed" };
  // Without a pass and without the learner asking to skip, the tutor may not offer a skip on their behalf.
  await assert.rejects(tool.execute("proposal", advance), /has not been passed and the learner did not ask to skip/);
  assert.ok(!ctx.pendingLearningAction.value, "no card is created");

  // The pass recorded in an earlier turn is remembered for this step.
  ctx.project.study.step_passed = { step_id: "learning:passed", mastered_items: ["入口职责"], evidence_ids: [evidence.stable_id] };
  await tool.execute("proposal", advance);
  // Read through a fresh reference: the assertion above narrowed the earlier one to empty.
  const pending: ConversationToolContext["pendingLearningAction"] = ctx.pendingLearningAction;
  const action = pending.value;
  assert.ok(action);
  assert.equal(action.skip_understanding_check, false);
  applyConfirmedLearningAction(ctx.project, action);
  assert.deepEqual(ctx.project.study.mastered, ["入口职责"]);
  assert.equal(ctx.project.study.phase, "completed");
  assert.equal(ctx.project.study.step_passed, null, "the next step is assessed afresh");
});

test("assessment sees the learner's earlier replies in this step and remembers a pass", async () => {
  let seen: { answer: string; earlierAnswers?: string[] } | null = null;
  const ctx = context({
    workerServices: {
      assess: (async (input: { answer: string; earlierAnswers?: string[] }) => {
        seen = input;
        return { completed: true, feedback: "对", verdict: "mastered", masteredItems: ["入口职责"], misconceptions: [],
          acceptedEvidenceIds: [evidence.stable_id], trace: { usage: null, evidence_ids: [] } };
      }) as never,
    },
  });
  ctx.project.study.phase = "explaining";
  ctx.project.study.total_steps = 1;
  ctx.project.study.dynamic_learning_plan = [{
    step_id: "learning:cumulative", order: 1, title: "理解入口", objective: "说清入口职责。",
    component_ids: ["component:entry"], evidence_refs: [evidence.stable_id], completion_check: "能说明入口职责。",
  }];
  const route = createMessage("assistant", "路线已开始");
  route.learning_action = { status: "executed" } as never;
  ctx.project.messages.push(createMessage("user", "上一步之前的话"), route,
    createMessage("user", "只有一个 README"), createMessage("user", "缺入口和配置"), createMessage("user", "上面就是我的回答"));
  ctx.currentUserMessage = "上面就是我的回答";
  ctx.exposedEvidence.set(evidence.stable_id, evidence as never);
  const tool = createConversationTools(ctx).find((item) => item.name === "assess_understanding");
  assert.ok(tool);
  await tool.execute("assess", { evidence_ids: [evidence.stable_id] });
  // Only replies since the step began are passed, without repeating the current message.
  assert.deepEqual(seen!.earlierAnswers, ["只有一个 README", "缺入口和配置"]);
  assert.deepEqual(ctx.project.study.step_passed,
    { step_id: "learning:cumulative", mastered_items: ["入口职责"], evidence_ids: [evidence.stable_id] });
});
