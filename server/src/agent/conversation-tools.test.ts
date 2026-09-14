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

test("online conversation tools keep explanation in Primary and expose one action proposal tool", () => {
  const names = createConversationTools(context()).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "assess_understanding",
    "get_component_context",
    "get_learner_profile",
    "get_learning_context",
    "get_project_overview",
    "list_value_points",
    "propose_learning_action",
    "query_code_evidence",
    "read_source_excerpt",
  ]);
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
