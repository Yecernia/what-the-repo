import assert from "node:assert/strict";
import test from "node:test";
import { createProject, emptyProfile } from "../domain/conversation.js";
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
    selected: null,
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
  await assert.rejects(facts.execute("unknown", { path: evidence.path, kind: "calls" }), /请先通过证据/);
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
  await assert.rejects(source.execute("unexposed", { path: evidence.path }), /请先通过证据/);
  assert.equal(reads.length, 0);
  await tools.find((tool) => tool.name === "get_component_context")!.execute("component", { component_id: "component:entry" });
  for (const path of ["../entry.ts", "/src/entry.ts", "src/missing.ts"]) {
    await assert.rejects(source.execute("unsafe", { path }), /请先通过证据/);
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
  await assert.rejects(run('read_source_excerpt', { path: evidence.path }), /请先通过证据/);
  await assert.rejects(run('get_static_file_facts', { path: evidence.path, kind: 'calls' }), /请先通过证据/);
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
  const payload = JSON.parse(String((result.content[0] as { text: string }).text)) as { confirmation_required: boolean };
  assert.equal(payload.confirmation_required, true);
  assert.equal(ctx.pendingLearningAction.value?.status, "pending");
  assert.deepEqual(ctx.project.study, before);
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
    /学习动作或目标与当前快照、路线不匹配/,
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
  const payload = JSON.parse(String((result.content[0] as { text: string }).text)) as {
    confirmation_required: boolean;
    proposal: { skipped_understanding_check: boolean };
  };
  assert.equal(payload.confirmation_required, true);
  assert.equal(payload.proposal.skipped_understanding_check, true);
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
