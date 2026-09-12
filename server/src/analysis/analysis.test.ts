import { emptyAnalysis, recordAnalysisProgress } from "../domain/conversation.js";
import type { AnalysisProgressUpdate } from "./progress.js";
import { loadProductSkill } from "../agent/skill-registry.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { TreeSitterAnalyzer } from "./tree-sitter.js";
import { buildSnapshot, type BuiltSnapshot } from "./graph.js";
import {
  applyHierarchyOperations,
  buildCandidateHierarchy,
} from "./hierarchy.js";
import {
  applyArchitectureResult,
  applySemanticResult,
  applyValueDiscoveryResult,
  enrichSnapshotWithPi,
  architectureComponentBatches,
  componentLanguageError,
  runRecordedSemanticBatch,
  selectRepairComponentIds,
  initialLayerCandidates,
  layerSemanticView,
  layerBatchInput,
  prepareLayerBatchInput,
  layerRelationSummary,
  validateLayerSubmission,
  consolidateLayers,
  semanticBatchInputIdentity,
  type ComponentPatch,
  type LayerWorkerResult,
} from "./semantic-worker.js";
import { createSemanticBatch, digestSemanticBatch } from "../domain/semantic-batch.js";
import { createRepositoryExplorationTools } from "../agent/repository-exploration-tools.js";
import { componentBatchInput, prepareComponentBatchInput, validateComponentSubmission } from "./architecture-components.js";
import { compactLayerRelations, componentLayerCandidates, globalLayerInputBudget, runLayerBatch } from "./architecture-layers.js";
import { normalizeGlobalLayerResult } from "./architecture-layer-plan.js";
import { COMPONENT_FACT_RESULT, GLOBAL_LAYER_RESULT, type GlobalLayerResult } from "./semantic-contracts.js";
import { Compile } from "typebox/compile";
import { semanticInputBudget } from "./semantic-input-budget.js";
import { COMPONENT_WORKER_RESULT, LAYER_WORKER_RESULT, MAX_COMPONENTS_PER_SCOPE, MAX_SECOND_LEVEL_ITEMS, type ComponentWorkerResult } from "./semantic-contracts.js";
import { enrichSnapshotSafely, semanticTerminalFailureCode } from "./coordinator.js";
import { WorkerExecutionError } from "../agent/worker-failure.js";
import { discoverValues, fitValueDiscoveryInput, valueDiscoveryInput } from "./value-discovery.js";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { PiModelRuntime } from "../agent/types.js";
import type { LspRunResult } from "./facts.js";
import type { RepositoryResearch } from "../domain/snapshot.js";
import type { WebResearchClient } from "../agent/web-research-tools.js";
import {
  applySnapshotLanguageOverlay,
  extractSnapshotLanguageOverlay,
  stripSnapshotLanguage,
} from "../domain/snapshot-language.js";

const emptyOfficialReview = { candidates: [], no_candidates_reason: "No official design claims in this synthetic fixture." };

const emptyWebResearch: WebResearchClient = { search: async () => [], readPage: async () => null };

test("coordinator semantic entry forwards the configured research client", async () => {
  const snapshot = buildSnapshot({ snapshotId: "research-forwarding", repository: "example/project", commitSha: "a".repeat(40), files: [], sourceRoot: "" });
  let received: WebResearchClient | undefined;
  await enrichSnapshotSafely(snapshot, {} as PiModelRuntime, undefined, async (input, _runtime, _signal, _language, _batch, web) => {
    received = web;
    return { snapshot: input, stopReason: "completed", workerRuns: [] };
  }, "zh-CN", undefined, emptyWebResearch);
  assert.equal(received, emptyWebResearch);
});

test("value input preserves original official concepts without preselecting a design pattern", () => {
  const research: RepositoryResearch = {
    research_version: "test",
    repository: "deepseek-ai/deepseek-harness",
    commit_sha: "a".repeat(40),
    description: "Everything is a Plugin.",
    homepage: "https://deepseek.com/harness",
    topics: [],
    stars: null,
    forks: null,
    readme: {
      url: "https://github.com/deepseek-ai/deepseek-harness#readme",
      title: "README",
      content: "It is built on an **everything-is-a-plugin** architecture.",
      source_kind: "readme",
    },
    official_pages: [{
      url: "https://deepseek.com/harness",
      title: "DeepSeek Harness",
      content: "一切皆插件。模型、工具、技能、会话、沙箱、存储、循环、调度和 UI 均由插件提供。",
      source_kind: "official",
    }],
    web_search_results: [],
    community_signals: [],
  };
  const snapshot = buildSnapshot({ snapshotId: 'generic-concepts', repository: research.repository, commitSha: research.commit_sha, files: [], sourceRoot: '', research });
  const input = valueDiscoveryInput(snapshot, 'zh-CN');
  assert.equal(input.research?.description, research.description);
  assert.equal(input.research?.readme, research.readme!.content);
  assert.deepEqual(input.research?.official_pages.map(page => page.content), research.official_pages.map(page => page.content));
  assert.equal('architecture_theses' in input, false);
  snapshot.research!.description = 'A log-structured storage engine';
  assert.equal(valueDiscoveryInput(snapshot, 'en').research?.description, 'A log-structured storage engine');
});

test("semantic provider failure keeps the deterministic snapshot usable", async () => {
  const snapshot = buildSnapshot({
    snapshotId: "snap:semantic-fallback",
    repository: "example/docs",
    commitSha: "c".repeat(40),
    files: [],
    sourceRoot: "",
  });
  const runtime = {} as PiModelRuntime;
  const result = await enrichSnapshotSafely(
    snapshot,
    runtime,
    undefined,
    async () => { throw new Error("unsupported_model"); },
  );
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.stopReason, "semantic_provider_configuration");
  assert.deepEqual(result.workerRuns, []);
});

test("empty structured semantic output is recorded as failed instead of succeeded", async () => {
  let completed = 0;
  let failedOutput: unknown;
  const failures: Array<{ reason: string; status?: "failed" | "cancelled" }> = [];
  const output = {
    value: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    stopReason: "structured_output_missing",
    skillId: "architecture-understanding",
    skillVersion: "test",
    evalSuite: "test",
    validationErrors: [],
  };
  const result = await runRecordedSemanticBatch({
    descriptor: {
      batch_id: "batch:empty-output",
      job_id: "job:empty-output",
      snapshot_id: "snapshot:empty-output",
      phase: "architecture_components",
      ordinal: 0,
      input: { component_ids: ["component:1"] },
    },
    context: {
      jobId: "job:empty-output",
      recorder: {
        load: async () => null,
        start: async () => undefined,
        complete: async () => { completed += 1; },
        fail: async (_batchId, reason, status, value) => { failures.push({ reason, status }); failedOutput = value; },
      },
    },
    run: async () => output,
  });
  assert.equal(result, output);
  assert.equal(failedOutput, output);
  assert.equal(completed, 0);
  assert.deepEqual(failures, [{ reason: "structured_output_missing", status: "failed" }]);
});

test("architecture batching covers every component beyond one model request", () => {
  const nodes = Array.from({ length: 81 }, (_, index) => ({
    id: `component:${index}`,
    label: `Component ${index}`,
    name: `Component ${index}`,
    responsibility: "",
    grouping_rationale: "",
    architecture_layer_id: null,
    architecture_layer_name: null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "degraded",
    members: [],
    member_count: 0,
    evidence: [],
    certainty: "degraded",
    review_status: "unreviewed",
    fan_in: index === 0 ? 0 : 1,
    fan_out: index === 80 ? 0 : 1,
  }));
  const edges = Array.from({ length: 80 }, (_, index) => ({
    id: `relation:${index}`,
    source: `component:${index}`,
    target: `component:${index + 1}`,
    relation_kind: "calls",
    label: "calls",
    description: "",
    certainty: "degraded",
    evidence: [],
    weight: 1,
  }));
  const batches = architectureComponentBatches({ graph: { nodes, edges } });
  const flattened = batches.flat();
  assert.ok(batches.every((batch) => batch.length <= 32));
  assert.equal(flattened.length, 81);
  assert.equal(new Set(flattened).size, 81);
  assert.deepEqual(new Set(flattened), new Set(nodes.map((node) => node.id)));
});

test("repair selection only keeps bounded partial misses", () => {
  assert.deepEqual(selectRepairComponentIds([
    {
      missing: ["component:missing-1", "component:missing-2"],
      trace: {
        stop_reason: "completed:coverage:8/10",
        requested_component_count: 10,
        covered_component_count: 8,
      },
    },
    {
      missing: ["component:whole-batch"],
      trace: {
        stop_reason: "structured_output_missing:coverage:0/10",
        requested_component_count: 10,
        covered_component_count: 0,
      },
    },
  ], 20), ["component:missing-1", "component:missing-2"]);

  assert.deepEqual(selectRepairComponentIds([
    {
      missing: ["component:too-many-1", "component:too-many-2"],
      trace: {
        stop_reason: "completed:coverage:2/4",
        requested_component_count: 4,
        covered_component_count: 2,
      },
    },
  ], 20), []);

  assert.deepEqual(selectRepairComponentIds([
    {
      missing: ["component:a", "component:b"],
      trace: {
        stop_reason: "completed:coverage:8/10",
        requested_component_count: 10,
        covered_component_count: 8,
      },
    },
  ], 4), []);
});

function hierarchyNode(id: string, group: string, evidenceId = `evidence:${id}`) {
  const row = {
    stable_id: evidenceId,
    label: `${group}:1`,
    path: `${group}/file.ts`,
    start_line: 1,
    end_line: 2,
    kind: "file",
  };
  return {
    id,
    entity_kind: "component" as const,
    parent_entity_id: null,
    depth: 0,
    label: id,
    name: id,
    responsibility: "",
    grouping_rationale: "",
    architecture_layer_id: null,
    architecture_layer_name: null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "degraded",
    members: [row],
    member_count: 1,
    evidence: [row],
    certainty: "degraded",
    review_status: "unreviewed",
    fan_in: 0,
    fan_out: 0,
    attributes: { structural_group: group },
  };
}

function architectureSnapshot(componentCount: number): BuiltSnapshot {
  const base = buildSnapshot({
    snapshotId: `snap:architecture-${componentCount}`,
    repository: "example/architecture",
    commitSha: "b".repeat(40),
    files: [],
    sourceRoot: "",
  });
  const nodes = Array.from({ length: componentCount }, (_, index) => hierarchyNode(
    `component:${index}`,
    index % 3 === 0 ? "src/agent" : index % 3 === 1 ? "src/analysis" : "src/persistence",
  ));
  const edges = Array.from({ length: Math.max(0, componentCount - 1) }, (_, index) => ({
    id: `relation:architecture:${index}`,
    source: `component:${index}`,
    target: `component:${index + 1}`,
    relation_kind: "calls",
    label: "调用",
    description: "测试关系",
    certainty: "verified",
    evidence: [nodes[index]?.evidence[0] as (typeof nodes)[number]["evidence"][number]],
    weight: 1,
  }));
  return {
    ...base,
    graph: {
      ...base.graph,
      nodes,
      edges,
      layers: [],
      hierarchy: { root_entity_ids: nodes.map((node) => node.id), max_depth: 0 },
    },
  };
}

test("value catalog keeps every original component and makes semantic changes part of cache identity", () => {
  const snapshot = architectureSnapshot(97);
  snapshot.graph.nodes.push({ ...hierarchyNode("layer:test", "display"), entity_kind: "system" });
  snapshot.graph.nodes[96]!.responsibility = "没有连接但仍然有价值的独立能力";
  const original = JSON.stringify(snapshot);
  const input = valueDiscoveryInput(snapshot, "zh-CN");
  assert.equal(input.component_catalog.total_components, 97);
  assert.equal(input.component_catalog.components.length, 97);
  assert.ok(input.component_catalog.components.some((row) => row.component_id === "component:96" && row.responsibility.includes("独立")));
  assert.ok(!input.component_catalog.components.some((row) => row.component_id === "layer:test"));
  assert.equal(JSON.stringify(snapshot), original);
  const large = { contextWindow: 1_000_000, maxTokens: 384_000 } as PiModelRuntime["model"];
  assert.equal(fitValueDiscoveryInput(input, large, "system", []).input.component_catalog.status, "complete");
  snapshot.graph.nodes[96]!.responsibility = "修改后的职责";
  assert.notEqual(JSON.stringify(input), JSON.stringify(valueDiscoveryInput(snapshot, "zh-CN")));
});

test("value catalog capacity falls back to full paged access rather than a component subset", () => {
  const input = valueDiscoveryInput(architectureSnapshot(97), "zh-CN");
  const small = { contextWindow: 40_000, maxTokens: 1_000 } as PiModelRuntime["model"];
  const fallback = fitValueDiscoveryInput(input, small, "system", []);
  assert.equal(fallback.input.component_catalog.status, "tools");
  assert.equal(fallback.input.component_catalog.total_components, 97);
  assert.deepEqual(fallback.input.component_catalog.components, []);
  assert.equal(input.component_catalog.components.length, 97);
  assert.throws(() => fitValueDiscoveryInput(input, { ...small, contextWindow: 1_000 }, "system", []), /value_input_budget_exceeded/);
});

test("value discovery can cite all supplied catalog evidence and leaves architecture untouched", async () => {
  const skill = await loadProductSkill("repository-value-discovery");
  const snapshot = architectureSnapshot(1);
  const node = snapshot.graph.nodes[0]!;
  node.evidence = [];
  node.members = Array.from({ length: 9 }, (_, i) => ({ ...node.members[0]!, stable_id: `evidence:member-${i}`, path: `src/member-${i}.ts` }));
  node.member_count = 9;
  const original = JSON.stringify(snapshot);
  const faux = fauxProvider({ provider: "value-catalog-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([(context) => {
    assert.ok(context.systemPrompt?.includes(skill.skill.content), "the actual value request must receive the complete selected Skill and examples");
    assert.match(context.systemPrompt ?? "", /copy the official name verbatim/);
    assert.match(context.systemPrompt ?? "", /能力 seam/);
    return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [{
    title: "能力 seam", claim: "有界调度限制资源占用", problem: "任务可能争抢资源",
    implementation: "通过队列分配工作", tradeoffs: "需要等待", transfer_conditions: "适用于资源有限的任务",
    component_ids: [node.id], evidence_ids: ["evidence:member-7"],
  }] })); }]);
  const result = await discoverValues({ snapshot, modelRuntime: {
    models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api>,
  }, displayLanguage: "zh-CN", webResearch: emptyWebResearch });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.snapshot.value_points[0]?.evidence[0]?.stable_id, "evidence:member-7");
  assert.deepEqual(result.workerRun.component_catalog, { mode: "complete", total: 1, supplied: 1 });
  assert.equal(JSON.stringify(snapshot), original);
  assert.equal(result.snapshot.graph, snapshot.graph);
});

test("value details above the old presentation limit are accepted without another model request", async () => {
  const snapshot = architectureSnapshot(1), node = snapshot.graph.nodes[0]!;
  const implementation = "Cancellation has different consequences depending on whether a task is waiting or already executing. A waiting task can be removed from the pending queue and its promise rejected without destroying a worker thread, because no handler has started for that task. A task that is already running cannot generally be stopped merely by rejecting the promise: its handler could continue changing external state. The pool therefore terminates the worker that owns it, settles the task, and replenishes the minimum pool size when needed. The default placement policy reserves a worker for an abortable task instead of placing unrelated work beside it, reducing the risk that cancelling one task kills another. This is cancellation of execution, not transactional rollback. File writes, network requests, or other effects completed before termination are not undone, and replacement workers incur startup and initialization costs. Applications must still arrange idempotency or compensation for effects that must survive retries safely.";
  assert.ok(implementation.length > 700);
  const point = { title: "Cancellation and worker isolation", claim: "Cancellation and rollback are distinct guarantees.", problem: "Stopping work safely",
    implementation, tradeoffs: "Already completed effects remain; replacement workers cost time.", transfer_conditions: "Independent tasks with explicit effect handling",
    component_ids: [node.id], evidence_ids: [node.members[0]!.stable_id] };
  const faux = fauxProvider({ provider: "value-detail-first-submit" }), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [point] }))]);
  const result = await discoverValues({ snapshot, displayLanguage: "en", webResearch: emptyWebResearch,
    modelRuntime: { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> } });
  assert.equal(result.stopReason, "completed"); assert.equal(faux.state.callCount, 1);
  assert.equal(result.snapshot.value_points[0]!.implementation, implementation);
  assert.deepEqual(result.snapshot.value_points[0]!.evidence.map(row => row.stable_id), point.evidence_ids);
  assert.equal(result.snapshot.graph, snapshot.graph);
});

test("value entry repairs text beyond the safety ceiling and preserves every point and reference", async () => {
  const snapshot = architectureSnapshot(1), node = snapshot.graph.nodes[0]!;
  const before = JSON.stringify(snapshot);
  const point = { title: "Bounded work queue", claim: "Limits active work", problem: "Limited resources",
    implementation: "The queue admits work only when a worker has capacity. ".repeat(100),
    tradeoffs: "Pending work must wait for a worker. ".repeat(150),
    transfer_conditions: "Independent tasks sharing limited resources", component_ids: [node.id], evidence_ids: [node.members[0]!.stable_id] };
  const unchanged = { ...point, title: "Worker lifecycle", implementation: "Remove a failed worker and settle its tasks.", tradeoffs: "Replacing a worker takes time." };
  const faux = fauxProvider({ provider: "value-english-repair" }), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    context => {
      assert.ok(context.tools?.some(tool => tool.name === "repair_result_text"));
      return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [point, unchanged] }));
    },
    context => {
      const tool = context.messages.find(row => row.role === "toolResult" && row.toolName === "submit_result");
      assert.ok(tool && tool.role === "toolResult");
      const text = tool.content.find(row => row.type === "text")!.text;
      const fields = JSON.parse(text.slice(text.indexOf('[{"field_id"'))) as Array<{
        field_id: string; location: string; title: string; component_ids: string[]; current_text: string;
      }>;
      assert.equal(fields.length, 2);
      for (const field of fields) {
        assert.equal(field.title, point.title);
        assert.deepEqual(field.component_ids, point.component_ids);
        assert.ok(field.current_text === point.implementation || field.current_text === point.tradeoffs);
      }
      return fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: fields.map(field => ({ field_id: field.field_id,
        value: field.location.endsWith("/implementation") ? "The queue starts work when a worker has capacity." : "Pending work waits." })) }));
    },
  ]);
  const result = await discoverValues({ snapshot, displayLanguage: "en", webResearch: emptyWebResearch,
    modelRuntime: { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> } });
  assert.equal(result.stopReason, "completed"); assert.equal(faux.state.callCount, 2);
  assert.equal(JSON.stringify(snapshot), before); assert.equal(result.snapshot.graph, snapshot.graph);
  assert.equal(result.snapshot.value_points.length, 2);
  const expected = [{ ...point, implementation: "The queue starts work when a worker has capacity.", tradeoffs: "Pending work waits." }, unchanged];
  for (const [index, actual] of result.snapshot.value_points.entries()) {
    const { evidence_ids, ...textAndComponents } = expected[index]!;
    for (const [key, value] of Object.entries(textAndComponents)) assert.deepEqual(actual[key as keyof typeof actual], value);
    assert.deepEqual(actual.evidence.map(row => row.stable_id), evidence_ids);
  }
});

test("value entry retains multilingual sources while selecting the project output language", async () => {
  for (const language of ["zh-CN", "en"]) {
    const snapshot = architectureSnapshot(1);
    const node = snapshot.graph.nodes[0]!;
    const pages = [
      { url: "https://example.com/en/design", title: "Bounded work queue", content: "The queue caps active work.", source_kind: "community_search" as const },
      { url: "https://example.com/ja/design", title: "設計の制約", content: "実行中のタスク数を制限する。", source_kind: "community_search" as const },
    ];
    const faux = fauxProvider({ provider: "mixed-language-value" });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([(context) => {
      const message = context.messages.find(row => row.role === "user")!;
      const content = typeof message.content === "string" ? message.content : message.content.filter(row => row.type === "text").map(row => row.text).join("");
      const input = JSON.parse(content);
      assert.equal(input.display_language, language);
      assert.deepEqual(input.initial_web_search.results.map((row: { title: string }) => row.title), pages.map(row => row.title));
      return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [{
        ...(language === "en"
          ? { title: "Bounded work queue", claim: "Limits active work", problem: "Limited resources", implementation: "Schedules work through a queue", tradeoffs: "Tasks may wait", transfer_conditions: "Independent tasks sharing limited resources" }
          : { title: "有界工作队列", claim: "限制同时执行的任务", problem: "资源有限", implementation: "通过队列分配工作", tradeoffs: "任务需要等待", transfer_conditions: "适用于共享有限资源的独立任务" }),
        component_ids: [node.id], evidence_ids: [node.members[0]!.stable_id],
      }] }));
    }]);
    const result = await discoverValues({ snapshot, displayLanguage: language,
      modelRuntime: { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> },
      webResearch: { ...emptyWebResearch, search: async () => pages },
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.snapshot.value_points.length, 1);
    assert.equal(result.snapshot.value_points[0]?.title, language === "en" ? "Bounded work queue" : "有界工作队列");
    assert.equal(faux.state.callCount, 1);
  }
});

test("value batch replay retains evidence first exposed through a tool", async () => {
  const snapshot = architectureSnapshot(1);
  snapshot.research = { research_version: "fixture", repository: snapshot.repository, commit_sha: snapshot.commit_sha,
    description: null, homepage: null, topics: [], stars: null, forks: null, readme: null,
    official_pages: [], web_search_results: [], community_signals: [] };
  const node = snapshot.graph.nodes[0]!;
  node.evidence = [];
  node.members = Array.from({ length: 9 }, (_, i) => ({ ...node.members[0]!, stable_id: `evidence:member-${i}`, path: `src/member-${i}.ts` }));
  node.member_count = 9;
  const faux = fauxProvider({ provider: "value-replay-test" });
  const models = createModels(); models.setProvider(faux.provider);
  const runtime = { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> };
  const page = { url: "https://example.com/design", title: "Design notes", content: "Search snippet", source_kind: "community_search" as const };
  let searches = 0;
  let pageReads = 0;
  const webResearch: WebResearchClient = {
    search: async (query) => { assert.ok(query.includes(snapshot.repository)); searches++; return [page]; },
    readPage: async (url) => { assert.equal(url, page.url); pageReads++; return { ...page, content: "Full design explanation" }; },
  };
  faux.setResponses([
    (context) => {
      assert.equal(searches, 1, "initial search must execute before the first model request");
      const message = context.messages.find((row) => row.role === "user")!;
      const text = typeof message.content === "string" ? message.content : message.content.filter((row) => row.type === "text").map((row) => row.text).join("");
      const input = JSON.parse(text);
      assert.equal(input.initial_web_search.status, "results");
      assert.equal(input.initial_web_search.remaining_searches, 3);
      assert.equal(input.initial_web_search.results[0].url, page.url);
      return fauxAssistantMessage([
        fauxToolCall("get_repository_component", { component_id: node.id, member_offset: 8, limit: 1 }),
        fauxToolCall("read_web_page", { url: page.url }),
      ]);
    },
    fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [{
      title: "有界任务处理", claim: "限制工作规模", problem: "资源有限", implementation: "通过队列处理任务",
      tradeoffs: "需要排队等待", transfer_conditions: "适用于独立任务", component_ids: [node.id], evidence_ids: ["evidence:member-8"],
    }] })),
  ]);
  const saved = new Map<string, ReturnType<typeof createSemanticBatch>>();
  const batchContext = { jobId: "value-replay-fixture", recorder: {
    load: async (_job: string, batch: string) => saved.get(batch) ?? null,
    start: async (batch: ReturnType<typeof createSemanticBatch>) => { saved.set(batch.batch_id, batch); },
    complete: async (batch: string, output: unknown, outputDigest: string) => { Object.assign(saved.get(batch)!, { status: "succeeded", output, output_digest: outputDigest }); },
    fail: async () => { assert.fail("fixture batch should succeed"); },
  } };
  const run = () => discoverValues({ snapshot, modelRuntime: runtime, displayLanguage: "zh-CN", batchContext, webResearch });
  const first = await run();
  assert.equal(first.snapshot.value_points.length, 1);
  const replay = await run();
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(replay.snapshot.value_points, first.snapshot.value_points);
  assert.deepEqual(replay.workerRun.tools_used, first.workerRun.tools_used);
  assert.deepEqual(replay.workerRun.web_searches, first.workerRun.web_searches);
  assert.deepEqual(replay.workerRun.web_page_reads, first.workerRun.web_page_reads);
  assert.equal(replay.workerRun.web_page_reads?.[0]?.status, "read");
  assert.deepEqual(replay.snapshot.research, first.snapshot.research);
  assert.equal(replay.snapshot.research?.web_search_results[0]?.content, "Full design explanation");
  assert.equal(searches, 1);
  assert.equal(pageReads, 1);
  assert.deepEqual(snapshot.research.web_search_results, [], "research input remains unchanged");
});

test("mandatory value search distinguishes unavailable from empty and cancellation prevents model work", async () => {
  for (const status of ["empty", "unavailable", "cancelled"] as const) {
    const snapshot = architectureSnapshot(1);
    const controller = new AbortController();
    const faux = fauxProvider({ provider: `value-search-${status}` });
    const models = createModels(); models.setProvider(faux.provider);
    let searches = 0;
    faux.setResponses([(context) => {
      const message = context.messages.find((row) => row.role === "user")!;
      const text = typeof message.content === "string" ? message.content : message.content.filter((row) => row.type === "text").map((row) => row.text).join("");
      assert.equal(JSON.parse(text).initial_web_search.status, status);
      return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [] }));
    }]);
    const run = () => discoverValues({ snapshot, displayLanguage: "zh-CN", signal: controller.signal,
      modelRuntime: { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> },
      webResearch: { ...emptyWebResearch, search: async () => {
        searches++;
        if (status === "cancelled") controller.abort();
        if (status !== "empty") throw new Error("web_search_unavailable");
        return [];
      } },
    });
    if (status === "cancelled") {
      await assert.rejects(run(), /abort/i);
      assert.equal(faux.state.callCount, 0);
    } else {
      const result = await run();
      assert.equal(result.stopReason, "completed");
      assert.equal(result.workerRun.web_searches?.[0]?.status, status);
      assert.equal(result.workerRun.tools_used?.includes("search_web"), true);
      assert.equal(faux.state.callCount, 1);
    }
    assert.equal(searches, 1);
  }
});

function semanticConcurrencyFixture() {
  const snapshot = architectureSnapshot(3);
  const components = snapshot.graph.nodes.map((node, i) => ({ component_id: node.id,
    name: ["请求入口", "任务处理", "持久存储"][i]!, responsibility: "实现该组件负责的明确职责", grouping_rationale: "成员共同提供这一能力" }));
  const layers = components.map((row) => ({ name: row.name + "层", responsibility: row.responsibility,
    rationale: "按独立职责保留边界", scopes: [], direct_component_ids: [row.component_id] }));
  const values = { official_design_review: emptyOfficialReview, value_points: [{ title: "有界任务处理", claim: "通过明确分工处理任务", problem: "需要控制工作规模",
    implementation: "入口交给工作组件处理", tradeoffs: "需要维护交接协议", transfer_conditions: "适用于职责可以划分的任务",
    component_ids: [components[0]!.component_id], evidence_ids: [snapshot.graph.nodes[0]!.members[0]!.stable_id] }] };
  const faux = fauxProvider({ provider: "semantic-concurrency-test", models: [{ id: "fixture", contextWindow: 1_000_000, maxTokens: 384_000 }] });
  const models = createModels(); models.setProvider(faux.provider);
  const runtime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
  const request = (context: Parameters<FauxResponseFactory>[0]) => {
    const message = context.messages.find((row) => row.role === "user")!;
    const content = message.content;
    return JSON.parse(typeof content === "string" ? content : content.filter((row) => row.type === "text").map((row) => row.text).join(""));
  };
  return { snapshot, components, layers, values, faux, runtime, request };
}

test("separate architecture Skills use three configured models through the full semantic entry without extra calls", async () => {
  const f = semanticConcurrencyFixture();
  const observed: string[] = [];
  const budgetModels: string[] = [];
  let reservations = 0;
  const roleRuntimes: NonNullable<PiModelRuntime["roleRuntimes"]> = {};
  const mutable = { ...roleRuntimes };
  for (const role of ["component-explanation", "architecture-planning", "repository-value-discovery"] as const) {
    const provider = fauxProvider({ provider: role, models: [{ id: role, contextWindow: 1_000_000, maxTokens: 384_000 }] });
    const models = createModels(); models.setProvider(provider.provider);
    provider.setResponses([context => {
      observed.push(role);
      const input = f.request(context);
      if (role === "component-explanation") {
        assert.equal(input.mode, "components");
        assert.match(context.systemPrompt ?? "", /## Explain the supplied batch/);
        assert.doesNotMatch(context.systemPrompt ?? "", /## Organize the architecture/);
        assert.match(context.systemPrompt ?? "", /Supplied Skill reference: examples.md/);
        return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: f.components }));
      }
      assert.equal(observed[0], "component-explanation");
      if (role === "architecture-planning") {
        assert.equal(input.mode, "layers");
        assert.match(context.systemPrompt ?? "", /## Organize the architecture/);
        assert.doesNotMatch(context.systemPrompt ?? "", /## Explain the supplied batch/);
        assert.match(JSON.stringify(input), /实现该组件负责的明确职责/);
        return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "layers", layers: f.layers }));
      }
      return fauxAssistantMessage(fauxToolCall("submit_result", f.values));
    }]);
    mutable[role] = { models, model: provider.getModel() as Model<Api> };
  }
  const runtime: PiModelRuntime = { ...f.runtime, model: { ...f.runtime.model, contextWindow: 4_000, maxTokens: 1_024 },
    roleRuntimes: mutable, ownerId: "test-analysis",
    beforeWorkerRequest: async () => { reservations++; },
    providerBudget: { acquire: async input => { budgetModels.push(input.model); return { release: async () => {} }; } },
  };
  const original = JSON.stringify(f.snapshot);
  const result = await enrichSnapshotWithPi(f.snapshot, runtime, undefined, "zh-CN", undefined, emptyWebResearch);
  assert.equal(result.stopReason, "completed");
  assert.equal(f.faux.state.callCount, 0, "the default model must not receive role work");
  assert.equal(reservations, 3);
  assert.deepEqual([...observed].sort(), [...budgetModels].sort());
  assert.deepEqual(result.workerRuns.map(run => run.model).sort(), [...observed].sort());
  assert.equal(result.snapshot.graph.semantic_coverage?.provider_supported_components, 3);
  assert.equal(result.snapshot.value_points.length, 1);
  assert.equal(JSON.stringify(f.snapshot), original);
});

test("a local call limit stops the real semantic path before component repair, layers or value research", async () => {
  const f = semanticConcurrencyFixture();
  f.runtime.beforeWorkerRequest = async () => { throw new WorkerExecutionError("analysis_batch_call_limit_exceeded"); };
  let searches = 0;
  const failed: string[] = [];
  const result = await enrichSnapshotSafely(f.snapshot, f.runtime, undefined, enrichSnapshotWithPi, "zh-CN", {
    jobId: "limited", jobAttempt: 1, recorder: { load: async () => null, start: async () => {},
      complete: async () => { assert.fail("a failed worker cannot become a completed batch"); },
      fail: async (_batch, error) => { failed.push(error); },
    },
  }, { ...emptyWebResearch, search: async () => { searches++; return []; } });
  assert.equal(result.snapshot, f.snapshot);
  assert.equal(result.stopReason, "semantic_analysis_batch_call_limit_exceeded");
  assert.equal(semanticTerminalFailureCode(result.stopReason), "analysis_batch_call_limit_exceeded");
  assert.deepEqual(failed, ["analysis_batch_call_limit_exceeded"]);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(searches, 0);
});

test("an actual provider failure retains its cause across component aggregation", async () => {
  const f = semanticConcurrencyFixture();
  f.faux.setResponses([fauxAssistantMessage("unavailable", { stopReason: "error", errorMessage: "network" })]);
  const result = await enrichSnapshotWithPi(f.snapshot, f.runtime, undefined, "zh-CN", undefined, emptyWebResearch);
  assert.equal(result.stopReason, "architecture:provider_request_failed:coverage:0/3;values:skipped");
  assert.equal(semanticTerminalFailureCode(result.stopReason), "provider_unavailable");
  assert.equal(f.faux.state.callCount, 1);
});

test("transient component failure blocks publication work and resumes only the failed batch", async () => {
  const f = semanticConcurrencyFixture();
  const snapshot = architectureSnapshot(33);
  const batches = architectureComponentBatches(snapshot);
  assert.equal(batches.length, 2);
  const saved = new Map<string, ReturnType<typeof createSemanticBatch>>();
  const context = { jobId: "transport-recovery", jobAttempt: 1, recorder: {
    load: async (_job: string, batch: string) => saved.get(batch) ?? null,
    start: async (batch: ReturnType<typeof createSemanticBatch>) => { saved.set(batch.batch_id, batch); },
    complete: async (batch: string, output: unknown, digest: string) => { Object.assign(saved.get(batch)!, { status: "succeeded", output, output_digest: digest }); },
    fail: async (batch: string, error: string) => { Object.assign(saved.get(batch)!, { status: "failed", error }); },
  } };
  let firstAttempt = true;
  const calls = new Map<string, number>();
  const response: FauxResponseFactory = inputContext => {
    const input = f.request(inputContext);
    if (input.mode === "components") {
      const ids = input.required_component_ids as string[];
      const batch = ids.includes(batches[0]![0]!) ? "first" : "second";
      calls.set(batch, (calls.get(batch) ?? 0) + 1);
      if (firstAttempt && batch === "first") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "ECONNRESET" });
      return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: ids.map(id => ({
        component_id: id, name: "任务模块" + id.split(":").at(-1), responsibility: "负责处理已提交的任务", grouping_rationale: "成员共同完成任务处理",
      })) }));
    }
    assert.equal(firstAttempt, false, "no dependent layer or value calls may run with missing explanations");
    if (input.mode === "layers") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "layers",
      layers: Array.from({ length: 3 }, (_, index) => ({ name: "执行分区" + index, responsibility: "处理独立提交的任务", rationale: "独立执行职责边界",
        scopes: [], direct_component_ids: snapshot.graph.nodes.slice(index * 11, index * 11 + 11).map(node => node.id) })),
    }));
    return fauxAssistantMessage(fauxToolCall("submit_result", f.values));
  };
  f.faux.setResponses(Array.from({ length: 6 }, () => response));
  const failed = await enrichSnapshotWithPi(snapshot, f.runtime, undefined, "zh-CN", context, emptyWebResearch);
  assert.equal(failed.stopReason, "architecture:provider_transient_error:provider_connection_failed:coverage:0/32;values:skipped");
  assert.equal(failed.snapshot, snapshot);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(saved.get("component-batch-2")?.status, "succeeded");
  firstAttempt = false;
  const resumed = await enrichSnapshotWithPi(snapshot, f.runtime, undefined, "zh-CN", { ...context, jobAttempt: 2 }, emptyWebResearch);
  assert.equal(resumed.stopReason, "completed");
  assert.equal(resumed.snapshot.graph.semantic_coverage?.provider_supported_components, 33);
  assert.deepEqual(Object.fromEntries(calls), { first: 2, second: 1 });
  assert.equal(f.faux.state.callCount, 5);
});

test("official candidate review reaches the Agent and must bind to the actual selected value", async () => {
  const f = semanticConcurrencyFixture();
  const point = f.values.value_points[0]!;
  const review = { candidates: [{ name: "Bounded work", source: "README.md", decision: "included", selected_title: "不存在的标题",
    reason: "当前代码通过有界队列限制待处理任务", evidence_ids: point.evidence_ids }], no_candidates_reason: "" };
  f.faux.setResponses([
    context => {
      assert.match(context.systemPrompt ?? "", /An example is a research lead, not a forbidden answer/);
      assert.match(context.systemPrompt ?? "", /Review record/);
      return fauxAssistantMessage(fauxToolCall("submit_result", { ...f.values, official_design_review: review }));
    },
    context => {
      assert.match(JSON.stringify(context.messages.at(-1)), /value_candidate_binding/);
      return fauxAssistantMessage(fauxToolCall("submit_result", { ...f.values,
        official_design_review: { ...review, candidates: [{ ...review.candidates[0], selected_title: point.title }] } }));
    },
  ]);
  let saved: unknown;
  const result = await discoverValues({ snapshot: f.snapshot, modelRuntime: f.runtime, displayLanguage: "zh-CN", webResearch: emptyWebResearch,
    batchContext: { jobId: "official-review", recorder: { load: async () => null, start: async () => {}, fail: async () => assert.fail(),
      complete: async (id, output) => { if (id === "value-discovery") saved = output; } } },
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(f.faux.state.callCount, 2);
  assert.equal((saved as { value: { official_design_review: typeof review } }).value.official_design_review.candidates[0]?.selected_title, point.title);
  assert.equal(result.snapshot.value_points[0]?.title, point.title);
  assert.equal("official_design_review" in result.snapshot.value_points[0]!, false);
});

test("component failure cancels and settles its sibling without starting a queued batch", { timeout: 5_000 }, async () => {
  const f = semanticConcurrencyFixture();
  const snapshot = architectureSnapshot(97);
  let startSecond!: () => void;
  const secondStarted = new Promise<void>(resolve => { startSecond = resolve; });
  let started = 0;
  let stopped = 0;
  const reserved: string[] = [];
  f.runtime.beforeWorkerRequest = async identity => {
    reserved.push(identity!.batchId);
    if (identity!.batchId === "component-batch-1") {
      await secondStarted;
      throw new WorkerExecutionError("worker_internal_error");
    }
  };
  const response: FauxResponseFactory = async (_context, options) => {
    if (++started === 2) startSecond();
    if (!options?.signal?.aborted) await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    stopped++;
    return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
  };
  f.faux.setResponses([response, response]);
  await assert.rejects(enrichSnapshotWithPi(snapshot, f.runtime, undefined, "zh-CN", undefined, emptyWebResearch), /worker_internal_error/);
  assert.equal(stopped, 2);
  assert.deepEqual(reserved.sort(), ["component-batch-1", "component-batch-2", "component-batch-3"]);
  assert.equal(f.faux.state.callCount, 2);
});

test("value discovery asks the same Agent to correct unknown references before accepting the point", async () => {
  const f = semanticConcurrencyFixture();
  const invalid = { official_design_review: emptyOfficialReview, value_points: [{ ...f.values.value_points[0]!, component_ids: ["component:0", "component:unknown"], evidence_ids: ["evidence:component:0", "evidence:unknown"] }] };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", invalid)),
    (context) => {
      const feedback = context.messages.filter((row) => row.role === "toolResult").at(-1)!;
      assert.match(JSON.stringify(feedback.content), /value_reference_component/);
      assert.match(JSON.stringify(feedback.content), /value_reference_evidence/);
      return fauxAssistantMessage(fauxToolCall("submit_result", f.values));
    },
  ]);
  const result = await discoverValues({ snapshot: f.snapshot, modelRuntime: f.runtime, displayLanguage: "zh-CN", webResearch: emptyWebResearch });
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.snapshot.value_points.length, 1);
  assert.deepEqual(result.snapshot.value_points[0]?.component_ids, ["component:0"]);
  assert.deepEqual(result.workerRun.validation_errors, []);
});

test("unfixed value references fail the batch and cannot publish or replay a misleading partial point", async () => {
  const f = semanticConcurrencyFixture();
  const invalid = { official_design_review: emptyOfficialReview, value_points: [{ ...f.values.value_points[0]!, evidence_ids: ["evidence:component:0", "evidence:unknown"] }] };
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", invalid)), fauxAssistantMessage(fauxToolCall("submit_result", invalid))]);
  const failures: string[] = [];
  let saved: unknown = null;
  const result = await discoverValues({ snapshot: f.snapshot, modelRuntime: f.runtime, displayLanguage: "zh-CN", webResearch: emptyWebResearch,
    batchContext: { jobId: "invalid-value-fixture", recorder: {
      load: async () => null, start: async () => {},
      complete: async id => { assert.equal(id, "value-initial-search", "invalid value references must not be a completed batch"); },
      fail: async (_batch, error, _status, output) => { failures.push(error); saved = output; },
    } },
  });
  assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(failures, ["value_reference_validation_failed"]);
  assert.equal(result.stopReason, "value_reference_validation_failed");
  assert.equal(semanticTerminalFailureCode(result.stopReason), "structured_worker_failed");
  assert.deepEqual(result.snapshot.value_points, []);
  assert.deepEqual((saved as { value: unknown }).value, invalid, "retain the rejected answer for diagnosis");
});

test("all relation evidence IDs returned by tools can be cited without another lookup", async () => {
  const snapshot = architectureSnapshot(2);
  const edge = snapshot.graph.edges[0]!;
  edge.evidence = Array.from({ length: 15 }, (_, i) => ({ ...edge.evidence[0]!, stable_id: `relation-evidence:${i}` }));
  for (const toolName of ["get_repository_component", "query_repository_relations"]) {
    const repository = createRepositoryExplorationTools({ snapshot, readLines: async () => [] });
    const tool = repository.tools.find((row) => row.name === toolName)!;
    const result = await tool.execute("relations", toolName === "get_repository_component" ? { component_id: "component:0" } : { component_ids: ["component:0"] });
    const payload = JSON.parse(result.content.filter((row) => row.type === "text").map((row) => row.text).join(""));
    const relation = toolName === "get_repository_component" ? payload.relations.items[0] : payload.items[0];
    assert.equal(relation.evidence_ids.length, 12);
    assert.ok(relation.evidence_ids.every((id: string) => repository.state.exposedEvidence.has(id)), toolName);
    assert.equal(relation.evidence_total, 15);
  }
});

test("value language retry exhaustion still preserves valid references as degraded content", async () => {
  const f = semanticConcurrencyFixture();
  const english = { official_design_review: emptyOfficialReview, value_points: [{ ...f.values.value_points[0]!, title: "Bounded work", claim: "Limits active tasks", problem: "Limited memory", implementation: "Queue tasks", tradeoffs: "Tasks wait", transfer_conditions: "Independent work" }] };
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", english)), fauxAssistantMessage(fauxToolCall("submit_result", english))]);
  const result = await discoverValues({ snapshot: f.snapshot, modelRuntime: f.runtime, displayLanguage: "zh-CN", webResearch: emptyWebResearch });
  assert.equal(result.snapshot.value_points.length, 1);
  assert.equal(result.snapshot.value_points[0]?.certainty, "degraded");
  assert.match(result.stopReason, /language_mismatch_after_retry/);
  assert.equal(semanticTerminalFailureCode(result.stopReason), null);
});

test("exhausted value text repair cannot turn a complete architecture into a successful full analysis", async () => {
  const f = semanticConcurrencyFixture();
  let valueRequests = 0;
  const original = JSON.stringify(f.snapshot);
  const failures: string[] = [];
  const response: FauxResponseFactory = context => {
    const input = f.request(context);
    if (input.mode === "components") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: f.components }));
    if (input.mode === "layers") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "layers", layers: f.layers }));
    if (valueRequests++ === 0) return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [{ ...f.values.value_points[0], implementation: "这个机制的解释过长。".repeat(500) }] }));
    return fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: valueRequests - 1, corrections: [{ field_id: "f1", value: "修正后仍然过长的说明。".repeat(500) }] }));
  };
  f.faux.setResponses(Array.from({ length: 6 }, () => response));
  const result = await enrichSnapshotWithPi(f.snapshot, f.runtime, undefined, "zh-CN", {
    jobId: "value-text-failure", recorder: { load: async () => null, start: async () => {},
      complete: async id => { assert.notEqual(id, "value-discovery"); },
      fail: async (_id, reason) => { failures.push(reason); },
    },
  }, emptyWebResearch);
  assert.equal(f.faux.state.callCount, 6);
  assert.deepEqual(failures, ["text_repair_exhausted"]);
  assert.equal(result.snapshot.graph.semantic_coverage?.provider_supported_components, 3);
  assert.equal(result.snapshot.value_points.length, 0);
  assert.match(result.stopReason, /value_output_missing:text_repair_exhausted/);
  assert.equal(semanticTerminalFailureCode(result.stopReason), "structured_worker_failed");
  assert.equal(JSON.stringify(f.snapshot), original);
});

test("layers and values overlap after components and replay independently without replacing the graph", { timeout: 5_000 }, async () => {
  const f = semanticConcurrencyFixture();
  const original = JSON.stringify(f.snapshot);
  let resolveValueStarted!: () => void;
  const valueStarted = new Promise<void>((resolve) => { resolveValueStarted = resolve; });
  let layerReturned = false;
  const response: FauxResponseFactory = async (context) => {
    const input = f.request(context);
    if (input.mode === "components" || input.mode === "layers") {
      assert.match(context.systemPrompt ?? "", /retain that name verbatim/);
    }
    if (input.mode === "components") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: f.components }));
    if (input.mode === "layers") {
      await valueStarted;
      layerReturned = true;
      return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "layers", layers: f.layers }));
    }
    assert.equal(layerReturned, false, "value research must not wait for the finished layer plan");
    assert.equal(input.component_catalog.components.length, 3);
    resolveValueStarted();
    return fauxAssistantMessage(fauxToolCall("submit_result", f.values));
  };
  f.faux.setResponses([response, response, response]);
  const saved = new Map<string, ReturnType<typeof createSemanticBatch>>();
  const progress = emptyAnalysis();
  const updates: AnalysisProgressUpdate[] = [];
  let observedParallel = false;
  const context = { jobId: "parallel-fixture", onProgress: async (update: AnalysisProgressUpdate) => {
    updates.push(update);
    recordAnalysisProgress(progress, update.kind, update.status, undefined, { ...update, instance_id: update.kind });
    if (["planning_architecture", "discovering_values"].every(kind => progress.progress_events?.some(event => event.kind === kind && event.status === "running"))) observedParallel = true;
  }, recorder: {
    load: async (_job: string, batch: string) => saved.get(batch) ?? null,
    start: async (batch: ReturnType<typeof createSemanticBatch>) => { saved.set(batch.batch_id, batch); },
    complete: async (batch: string, output: unknown, outputDigest: string) => { Object.assign(saved.get(batch)!, { status: "succeeded", output, output_digest: outputDigest }); },
    fail: async () => { assert.fail("all fixture batches should succeed"); },
  } };
  const first = await enrichSnapshotWithPi(f.snapshot, f.runtime, undefined, "zh-CN", context, emptyWebResearch);
  assert.equal(first.stopReason, "completed");
  assert.equal(first.snapshot.value_points.length, 1);
  assert.deepEqual(first.snapshot.graph.nodes.filter((node) => node.entity_kind === "component").map((node) => node.name).sort(), f.components.map((row) => row.name).sort());
  assert.equal(JSON.stringify(f.snapshot), original);
  assert.equal(saved.size, 4);
  assert.ok(saved.has("value-initial-search"));
  assert.equal(observedParallel, true, "both real branches must be shown as running together");
  assert.ok(progress.progress_events?.every(event => event.status === "completed"));
  const componentProgress = progress.progress_events?.find(event => event.kind === "explaining_components");
  assert.equal(componentProgress?.completed_batches, componentProgress?.total_batches);
  updates.length = 0;
  const replay = await enrichSnapshotWithPi(f.snapshot, f.runtime, undefined, "zh-CN", context, emptyWebResearch);
  assert.equal(replay.stopReason, "completed");
  assert.deepEqual(replay.snapshot, first.snapshot);
  assert.equal(f.faux.state.callCount, 3);
  for (const kind of ["explaining_components", "planning_architecture", "discovering_values"]) {
    assert.deepEqual(updates.filter(update => update.kind === kind).map(update => update.status), ["reused"]);
  }
  assert.ok(updates.some(update => update.kind === "assembling_architecture" && update.status === "completed"));
  assert.ok(updates.some(update => update.kind === "merging_analysis" && update.status === "completed"));
});

test("cancelling parallel semantics settles both branches and preserves original facts", { timeout: 5_000 }, async () => {
  const f = semanticConcurrencyFixture();
  const controller = new AbortController();
  const original = JSON.stringify(f.snapshot);
  const response: FauxResponseFactory = async (context) => {
    const input = f.request(context);
    if (input.mode === "components") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: f.components }));
    if (input.component_catalog) controller.abort();
    if (!controller.signal.aborted) await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    return fauxAssistantMessage("已取消", { stopReason: "aborted" });
  };
  f.faux.setResponses([response, response, response]);
  const result = await enrichSnapshotWithPi(f.snapshot, f.runtime, controller.signal, "zh-CN", undefined, emptyWebResearch);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(JSON.stringify(f.snapshot), original);
  assert.ok(f.faux.state.callCount <= 3);
});

test("a fatal layer persistence error aborts and waits for in-flight value research", { timeout: 5_000 }, async () => {
  const f = semanticConcurrencyFixture();
  let resolveValueStarted!: () => void;
  const valueStarted = new Promise<void>((resolve) => { resolveValueStarted = resolve; });
  let valueStopped = false;
  const response: FauxResponseFactory = async (context, options) => {
    if (f.request(context).mode === "components") return fauxAssistantMessage(fauxToolCall("submit_result", { mode: "components", components: f.components }));
    resolveValueStarted();
    if (!options?.signal?.aborted) await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
    valueStopped = true;
    return fauxAssistantMessage("已取消", { stopReason: "aborted" });
  };
  f.faux.setResponses([response, response]);
  const context = { jobId: "parallel-fatal-fixture", recorder: {
    load: async () => null,
    start: async (batch: ReturnType<typeof createSemanticBatch>) => { if (batch.phase === "architecture_layers") { await valueStarted; throw new Error("fixture_batch_store_failure"); } },
    complete: async () => {}, fail: async () => {},
  } };
  await assert.rejects(enrichSnapshotWithPi(f.snapshot, f.runtime, undefined, "zh-CN", context, emptyWebResearch), /fixture_batch_store_failure/);
  assert.equal(valueStopped, true);
});

function optimizationInput() {
  const snapshot = architectureSnapshot(3);
  const patches = new Map<string, ComponentPatch>(snapshot.graph.nodes.map((node, index) => [node.id, {
    component_id: node.id, name: `语义组件${index}`, responsibility: `执行已解释职责${index}`,
    grouping_rationale: "成员共同实现可确认的职责", layer_rationale: "关系方向与成员支持此边界",
    layer_name: index < 2 ? "请求处理层" : "存储适配层",
  }]));
  const candidates = initialLayerCandidates(snapshot, patches);
  const groupFor = (componentId: string) => `g${candidates.findIndex((candidate) => candidate.componentIds.includes(componentId))}`;
  const value: LayerWorkerResult = {
    mode: "layers",
    groups: candidates.map((candidate, index) => ({ group_id: `g${index}`, name: candidate.name, responsibility: "承载相关职责", rationale: "由组件边界与依赖确认" })),
    mappings: candidates.map((candidate, index) => ({ candidate_id: candidate.id, group_id: `g${index}` })),
    scopes: [{ scope_id: "scope", layer_group_id: groupFor("component:0"), name: "请求处理职责", responsibility: "处理请求并完成执行", rationale: "两个组件共同完成请求处理", component_ids: ["component:0", "component:1"], evidence_ids: [snapshot.graph.nodes[0]!.evidence[0]!.stable_id] }],
    direct_component_ids: ["component:2"],
    component_reassignments: [],
  };
  return { snapshot, patches, candidates, value };
}

test("component requests only explain components and layer input uses the shared scope limits", () => {
  const { snapshot, candidates } = optimizationInput();
  const componentInput = componentBatchInput(snapshot, ["component:0"], "component", false, "zh-CN");
  assert.deepEqual(Object.keys(COMPONENT_WORKER_RESULT.properties), ["mode", "components"]);
  assert.equal("candidate_entities" in componentInput, false);
  assert.equal("operation_rules" in componentInput, false);
  assert.deepEqual(componentInput.required_component_ids, ["component:0"]);
  const layerInput = layerBatchInput(snapshot, candidates, "layer", "zh-CN", true);
  assert.equal(layerInput.scope_component_limit, (LAYER_WORKER_RESULT.properties.scopes.items.properties.component_ids as unknown as { maxItems: number }).maxItems);
  assert.equal(layerInput.scope_component_limit, MAX_COMPONENTS_PER_SCOPE);
  assert.equal(layerInput.max_second_level_items_per_layer, MAX_SECOND_LEVEL_ITEMS);
});

test("layer input and exploration share component semantics without cloning facts", async () => {
  const { snapshot, patches, candidates } = optimizationInput();
  const view = layerSemanticView(snapshot, patches, "zh-CN");
  assert.equal(snapshot.graph.nodes[0]!.name, "component:0");
  assert.equal(view.graph.nodes[0]!.name, "语义组件0");
  assert.equal(view.fact_graph, snapshot.fact_graph);
  assert.equal(view.graph.edges, snapshot.graph.edges);
  assert.equal(view.graph.nodes[0]!.members, snapshot.graph.nodes[0]!.members);
  const input = layerBatchInput(view, candidates, "layer", "zh-CN", true);
  const rows = input.scope_components as Array<{ name: string; component_id: string }>;
  assert.equal(rows.find((row) => row.component_id === "component:0")?.name, "语义组件0");
  assert.equal(rows.length, 3);
  const repository = createRepositoryExplorationTools({ snapshot: view, readLines: async () => [] });
  const tool = repository.tools.find((tool) => tool.name === "get_repository_component")!;
  const response = await tool.execute("call", { component_id: "component:0" });
  assert.match(JSON.stringify(response.content), /语义组件0/);
});

test("global layer contract retains complete explicit ownership and graph facts", () => {
  const { snapshot, patches } = optimizationInput();
  const units = componentLayerCandidates(snapshot);
  const value: GlobalLayerResult = { mode: "layers", layers: [
    { name: "请求处理层", responsibility: "处理和编排请求", rationale: "成员协作完成请求",
      scopes: [{ name: "请求执行", responsibility: "执行请求并协调结果", rationale: "共享请求处理职责",
        component_ids: ["component:0", "component:1"], evidence_ids: [snapshot.graph.nodes[0]!.evidence[0]!.stable_id] }], direct_component_ids: [] },
    { name: "存储适配层", responsibility: "保存并读取结果", rationale: "独立的数据存储边界", scopes: [], direct_component_ids: ["component:2"] },
  ] };
  assert.equal(Compile(GLOBAL_LAYER_RESULT).Check(value), true);
  const normalized = normalizeGlobalLayerResult(value);
  assert.deepEqual(validateLayerSubmission(normalized, snapshot, units, true, "zh-CN"), []);
  assert.equal(normalized.scopes[0]!.layer_group_id, normalized.groups[0]!.group_id);
  const before = digestSemanticBatch(snapshot);
  const graph = applyArchitectureResult(snapshot, {
    components: [...patches.values()], scopes: normalized.scopes.map(scope => ({
      name: scope.name, responsibility: scope.responsibility, grouping_rationale: scope.rationale,
      component_ids: scope.component_ids, evidence_ids: scope.evidence_ids,
    })), direct_component_ids: normalized.direct_component_ids,
  });
  assert.equal(digestSemanticBatch(snapshot), before);
  const components = graph.graph.nodes.filter(n => n.entity_kind === "component");
  assert.deepEqual(components.map(n => n.id).sort(), units.map(n => n.id).sort());
  for (const node of components) assert.deepEqual(node.members, snapshot.graph.nodes.find(n => n.id === node.id)!.members);
  for (const edge of snapshot.graph.edges) assert.deepEqual(graph.graph.edges.find(e => e.id === edge.id), edge);
  assert.equal(graph.graph.nodes.filter(n => n.entity_kind === "domain").length, 1);
  const direct = components.find(n => n.id === "component:2")!;
  // Small repositories retain their existing flat display instead of forcing a layer box.
  assert.notEqual(graph.graph.nodes.find(n => n.id === direct.parent_entity_id)?.entity_kind, "domain");

  const missing = structuredClone(value); missing.layers[1]!.direct_component_ids = [];
  assert.ok(validateLayerSubmission(normalizeGlobalLayerResult(missing), snapshot, units, true, "zh-CN").some(e => e.startsWith("missing_component:")));
  const duplicate = structuredClone(value); duplicate.layers[1]!.direct_component_ids.push("component:0");
  assert.ok(validateLayerSubmission(normalizeGlobalLayerResult(duplicate), snapshot, units, true, "zh-CN").some(e => e.startsWith("duplicate_component:")));
  const foreign = structuredClone(value); foreign.layers[0]!.scopes[0]!.evidence_ids = [snapshot.graph.nodes[2]!.evidence[0]!.stable_id];
  assert.ok(validateLayerSubmission(normalizeGlobalLayerResult(foreign), snapshot, units, true, "zh-CN").some(e => e.startsWith("scope_evidence:")));
});

test("layer text repair preserves nested assignments and still rejects unrelated evidence", async () => {
  for (const componentAssignments of [true, false]) {
    const { snapshot, patches, candidates, value } = optimizationInput();
    const units = componentAssignments ? componentLayerCandidates(snapshot) : candidates;
    const global: GlobalLayerResult = { mode: "layers", layers: [{
      name: value.groups[0]!.name, responsibility: value.groups[0]!.responsibility,
      rationale: value.groups[0]!.rationale,
      scopes: value.scopes.map(({ scope_id, layer_group_id, ...scope }) => scope),
      direct_component_ids: value.direct_component_ids,
    }] };
    const valid = componentAssignments ? global : value;
    const broken = structuredClone(valid);
    const layer = "layers" in broken ? broken.layers[0]! : broken.groups[0]!;
    const scope = "layers" in broken ? broken.layers[0]!.scopes[0]! : broken.scopes[0]!;
    layer.responsibility = "长".repeat(401);
    scope.rationale = "长".repeat(501);
    if (componentAssignments) scope.evidence_ids = [snapshot.graph.nodes[2]!.evidence[0]!.stable_id];
    const faux = fauxProvider({ provider: `layer-partial-text-${componentAssignments}` });
    const models = createModels(); models.setProvider(faux.provider);
    let fullEvidenceCorrection = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_result", broken)),
      fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: [
        { field_id: "f1", value: value.groups[0]!.responsibility },
        { field_id: "f2", value: value.scopes[0]!.rationale },
      ] })),
      () => { fullEvidenceCorrection = true; return fauxAssistantMessage(fauxToolCall("submit_result", valid)); },
    ]);
    const before = structuredClone(snapshot.graph);
    const result = await runLayerBatch({ snapshot, patches, candidates: units, batchId: "layer-global-final", ordinal: 1,
      includeScopes: true, componentAssignments, displayLanguage: "zh-CN", modelRuntime: { models, model: faux.getModel() as Model<Api> } });
    assert.equal(fullEvidenceCorrection, componentAssignments);
    assert.equal(result.scopes.length, value.scopes.length);
    assert.deepEqual(result.scopes[0]!.component_ids, value.scopes[0]!.component_ids);
    assert.deepEqual(result.scopes[0]!.evidence_ids, value.scopes[0]!.evidence_ids);
    assert.equal(result.scopes[0]!.grouping_rationale, value.scopes[0]!.rationale);
    assert.deepEqual(result.directComponentIds, value.direct_component_ids);
    assert.deepEqual(snapshot.graph, before);
  }
});

test("deferred component planning needs no preliminary layer but preserves text validation", () => {
  const { patches } = optimizationInput();
  const value = { mode: "components" as const, components: [...patches.values()].map(({ layer_name: _name, layer_rationale: _reason, ...patch }) => patch) };
  assert.equal(Compile(COMPONENT_FACT_RESULT).Check(value), true);
  assert.equal(Compile(COMPONENT_WORKER_RESULT).Check(value), false);
  assert.deepEqual(validateComponentSubmission(value, [...patches.keys()], "zh-CN"), []);
  value.components[0]!.responsibility = "untranslated English responsibility";
  assert.ok(validateComponentSubmission(value, [...patches.keys()], "zh-CN").length);
});

test("direct assignment input and reserved capacity preserve all components and relations", async () => {
  const { snapshot, patches } = optimizationInput();
  const view = layerSemanticView(snapshot, patches, "zh-CN"), units = componentLayerCandidates(snapshot);
  const input = await prepareLayerBatchInput(view, units, "layer-global-final", "zh-CN", true, true);
  assert.deepEqual(input.input.required_component_ids, units.map(n => n.id));
  assert.equal(input.input.candidates, undefined);
  assert.equal(input.input.component_manifest, undefined);
  assert.ok((input.input.components as Record<string, unknown>[]).every(row => !("layer_rationale" in row) && !("layer_candidate_id" in row)));
  assert.equal(layerRelationSummary(view, units).relations.reduce((sum, row) => sum + row.relation_count, 0), snapshot.graph.edges.length);
  const runtime = { model: { contextWindow: 1_000_000, maxTokens: 384_000 } } as PiModelRuntime;
  const ordinary = await globalLayerInputBudget(view, units, "zh-CN", runtime, true);
  const reserved = await globalLayerInputBudget(view, units, "zh-CN", runtime, true, true);
  assert.equal(reserved?.fits, true);
  assert.equal(reserved!.estimatedInputTokens - ordinary!.estimatedInputTokens, units.length * 980 * 1.5);
  const small = { model: { contextWindow: 64_000, maxTokens: 32_000 } } as PiModelRuntime;
  assert.equal((await globalLayerInputBudget(view, units, "zh-CN", small, true, true))?.fits, false);
  const large = architectureSnapshot(97);
  assert.equal(await globalLayerInputBudget(large, componentLayerCandidates(large), "zh-CN", runtime, true, true), null);
  assert.throws(() => layerBatchInput(large, componentLayerCandidates(large), "global", "zh-CN", true, true), /scope_invalid/);
});

test("direct global assignment replays its own cache without entering intermediate merges", async () => {
  const { snapshot, patches } = optimizationInput();
  const runtime = { model: { id: "offline", provider: "test", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 384_000 } } as PiModelRuntime;
  const units = componentLayerCandidates(snapshot), view = layerSemanticView(snapshot, patches, "zh-CN");
  const prepared = await prepareLayerBatchInput(view, units, "layer-global-final", "zh-CN", true, true);
  const value = normalizeGlobalLayerResult({ mode: "layers", layers: [{ name: "请求协作层", responsibility: "承载请求协作职责", rationale: "共同参与请求处理", scopes: [], direct_component_ids: units.map(n => n.id) }] });
  const output = { value, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 }, stopReason: "completed", skillVersion: "test", validationErrors: [], skillId: "architecture-planning", evalSuite: "test" };
  const batch = createSemanticBatch({ job_id: "offline", batch_id: "layer-global-final", snapshot_id: snapshot.snapshot_id, phase: "architecture_layers", ordinal: 20_000, input: semanticBatchInputIdentity(prepared.input, runtime, "architecture-planning", await loadProductSkill("architecture-planning")) }, 1, null, null, new Date().toISOString());
  const loaded: string[] = [];
  const recorder = { load: async (_job: string, id: string) => { loaded.push(id); return { ...batch, status: "succeeded" as const, output }; },
    start: async () => { throw new Error("must replay without paid calls"); }, complete: async () => {}, fail: async () => {} };
  const result = await consolidateLayers({ snapshot, patches, componentAssignments: true, displayLanguage: "zh-CN", modelRuntime: runtime, batchContext: { jobId: "offline", recorder } });
  assert.deepEqual(loaded, ["layer-global-final"]);
  assert.equal(result.degraded, false);
  assert.equal(result.workerRuns[0]?.layer_assignment_mode, "components");
  assert.deepEqual(result.directComponentIds, units.map(n => n.id));
  const legacy = await prepareLayerBatchInput(view, initialLayerCandidates(snapshot, patches), "layer-global-final", "zh-CN", true);
  assert.notEqual(digestSemanticBatch(semanticBatchInputIdentity(legacy.input, runtime, "architecture-planning")), batch.input_digest);
  loaded.length = 0;
  const tooSmall = { ...runtime, model: { ...runtime.model, contextWindow: 32_000 } };
  await assert.rejects(consolidateLayers({ snapshot, patches, componentAssignments: true, displayLanguage: "zh-CN", modelRuntime: tooSmall, batchContext: { jobId: "offline", recorder } }), /budget_exceeded/);
  assert.deepEqual(loaded, []);
  const larger = architectureSnapshot(33);
  const largerPatches = new Map(larger.graph.nodes.map(node => [node.id, { component_id: node.id, name: "请求执行组件", responsibility: "处理请求" }]));
  await assert.rejects(consolidateLayers({ snapshot: larger, patches: largerPatches, componentAssignments: true, displayLanguage: "zh-CN", modelRuntime: tooSmall, batchContext: { jobId: "offline", recorder } }), /must replay without paid calls/);
  assert.deepEqual(loaded, ["layer-round-1-1"]);
});

test("layer relation summaries conserve directions, counts and weights including internal edges", () => {
  const { snapshot, candidates } = optimizationInput();
  snapshot.graph.edges.push({ ...snapshot.graph.edges[1]!, id: "reverse", source: "component:2", target: "component:1", weight: 3 });
  snapshot.graph.nodes.push({ ...snapshot.graph.nodes[0]!, id: "repository", entity_kind: "repository" });
  snapshot.graph.edges.push({ ...snapshot.graph.edges[0]!, id: "hierarchy:edge:root", source: "repository", target: "component:0", relation_kind: "contains" });
  const summary = layerRelationSummary(snapshot, candidates);
  assert.equal(summary.relations.reduce((n, row) => n + row.relation_count, 0), 3);
  assert.equal(summary.relations.reduce((n, row) => n + row.weight, 0), 5);
  assert.equal(summary.relations.filter((row) => row.source === row.target).length, 1);
  const external = summary.relations.filter((row) => row.source !== row.target);
  assert.equal(external[0]!.source, external[1]!.target);
  assert.equal(summary.external_relation_count, 0);
  const subset = layerRelationSummary(snapshot, candidates.filter((row) => row.componentIds.includes("component:0")));
  assert.equal(subset.external_relation_count, 2);
});

test("invalid layer batches retry even when legacy storage marked them successful", async () => {
  const batches = new Map<string, ReturnType<typeof createSemanticBatch>>();
  const calls: string[] = [];
  const recorder = {
    load: async (_job: string, batchId: string) => batches.get(batchId) ?? null,
    start: async (batch: ReturnType<typeof createSemanticBatch>) => { batches.set(batch.batch_id, batch); },
    complete: async (batchId: string, output: unknown) => { batches.set(batchId, { ...batches.get(batchId)!, status: "succeeded", output }); },
    fail: async (batchId: string, error: string, status: "failed" | "cancelled" = "failed", output?: unknown) => { batches.set(batchId, { ...batches.get(batchId)!, status, error, output }); },
  };
  const run = (batchId: string, rejected: boolean) => runRecordedSemanticBatch({
    descriptor: { job_id: "retry-test", batch_id: batchId, snapshot_id: "snapshot", phase: "architecture_layers", ordinal: 1, input: { layer: batchId } },
    context: { jobId: "retry-test", recorder },
    run: async () => { calls.push(batchId); return { value: { mode: "layers" }, skillVersion: "test", stopReason: "completed", validationErrors: rejected ? ["scope_evidence: rejected"] : [] }; },
  });
  await run("layer-1", false); await run("layer-2", true);
  assert.equal(batches.get("layer-2")?.status, "failed");
  // Before this repair, a non-null invalid result was persisted as succeeded.
  batches.set("layer-2", { ...batches.get("layer-2")!, status: "succeeded" });
  await run("layer-1", false); await run("layer-2", false);
  assert.deepEqual(calls, ["layer-1", "layer-2", "layer-2"]);
  assert.equal(batches.get("layer-2")?.status, "succeeded");
});

test("global layer planning reserves output and tool reads and rejects unknown capacity", () => {
  const text = "中文证据与源码 identifiers ".repeat(1_000);
  const budget = semanticInputBudget(text, { contextWindow: 100_000, maxTokens: 40_000 });
  assert.ok(budget.estimatedInputTokens >= text.length / 2);
  assert.equal(budget.fits, true);
  assert.equal(semanticInputBudget(text, { contextWindow: 60_000, maxTokens: 40_000 }).fits, false);
  assert.equal(semanticInputBudget(text, { maxTokens: 40_000 }).fits, false);
  assert.equal(semanticInputBudget(text, { contextWindow: Infinity, maxTokens: 40_000 }).fits, false);
});

test("capacity-aware final pass covers over 32 candidates; small models and oversized manifests keep batching", async () => {
  const snapshot = architectureSnapshot(33);
  const patches = new Map<string, ComponentPatch>(snapshot.graph.nodes.map((node, index) => [node.id, {
    component_id: node.id, name: `语义组件${index}`, responsibility: `执行已解释职责${index}`,
    grouping_rationale: "成员共同实现可确认职责", layer_rationale: "成员和关系支持边界", layer_name: `候选职责层${index}`,
  }]));
  const candidates = initialLayerCandidates(snapshot, patches);
  const runtime = { model: { provider: "test", id: "model", contextWindow: 1_000_000, maxTokens: 384_000 } } as unknown as PiModelRuntime;
  const view = layerSemanticView(snapshot, patches, "zh-CN");
  assert.equal((await globalLayerInputBudget(view, candidates, "zh-CN", runtime))?.fits, true);
  const prepared = await prepareLayerBatchInput(view, candidates, "layer-global-final", "zh-CN", true);
  const value: LayerWorkerResult = {
    mode: "layers", groups: Array.from({ length: 3 }, (_, n) => ({ group_id: `g${n}`, name: `已核实职责层${n}`, responsibility: "承载已确认的组件职责", rationale: "由成员和实现关系确认" })),
    mappings: candidates.map((c, n) => ({ candidate_id: c.id, group_id: `g${n % 3}` })),
    scopes: [], direct_component_ids: snapshot.graph.nodes.map(n => n.id), component_reassignments: [],
  };
  assert.deepEqual(validateLayerSubmission(value, view, candidates, true, "zh-CN"), []);
  assert.ok((LAYER_WORKER_RESULT.properties.mappings as unknown as { maxItems: number }).maxItems >= candidates.length);
  const batch = createSemanticBatch({ job_id: "offline", batch_id: "layer-global-final", snapshot_id: snapshot.snapshot_id, phase: "architecture_layers", ordinal: 20_000, input: semanticBatchInputIdentity(prepared.input, runtime, "architecture-planning", await loadProductSkill("architecture-planning")) }, 1, null, null, new Date().toISOString());
  const loaded: string[] = [];
  const reject = async () => { throw new Error("offline must not call Provider"); };
  const recorder = { load: async (_job: string, id: string) => {
    loaded.push(id);
    return id === batch.batch_id ? { ...batch, status: "succeeded" as const, output: { value, skillVersion: "test", evalSuite: "test", stopReason: "completed", validationErrors: [] } } : null;
  }, start: reject, complete: reject, fail: reject };
  const result = await consolidateLayers({ snapshot, patches, displayLanguage: "zh-CN", modelRuntime: runtime, batchContext: { jobId: "offline", recorder } });
  assert.deepEqual(loaded, ["layer-global-final"]);
  assert.equal(result.degraded, false);
  assert.deepEqual([...result.patches.keys()].sort(), [...patches.keys()].sort());
  assert.deepEqual(result.directComponentIds.sort(), snapshot.graph.nodes.map(n => n.id).sort());
  assert.equal(result.workerRuns[0]?.layer_input_budget?.directGlobal, true);
  loaded.length = 0;
  const small = { ...runtime, model: { ...runtime.model, contextWindow: 64_000, maxTokens: 32_000 } };
  await assert.rejects(consolidateLayers({ snapshot, patches, displayLanguage: "zh-CN", modelRuntime: small, batchContext: { jobId: "offline", recorder } }), /offline must not call Provider/u);
  assert.deepEqual(loaded, ["layer-round-1-1"]);
  assert.equal(await globalLayerInputBudget(view, [{ ...candidates[0]!, componentIds: Array.from({ length: 97 }, (_, n) => `component:${n}`) }], "zh-CN", runtime), null);
  assert.notEqual(digestSemanticBatch(semanticBatchInputIdentity(prepared.input, small, "architecture-planning")), batch.input_digest);
});

test("member-only exploration keeps member pages, optional relations, evidence access and source fences", async () => {
  const { snapshot } = optimizationInput();
  const digest = digestSemanticBatch(snapshot);
  const allowedComponentIds = new Set(["component:1"]);
  const options = { snapshot, allowedComponentIds, readLines: async () => ["safe line"] };
  const old = createRepositoryExplorationTools(options);
  const lean = createRepositoryExplorationTools({ ...options, componentRelationsDefault: false });
  const call = async (repo: typeof lean, name: string, args: object) => {
    const value = await repo.tools.find((tool) => tool.name === name)!.execute("case", args);
    const block = value.content.find((row) => row.type === "text")!;
    return JSON.parse(block.text);
  };
  for (const member_offset of [0, 1]) {
    const args = { component_id: "component:1", member_offset, limit: 1 };
    const before = await call(old, "get_repository_component", args);
    const after = await call(lean, "get_repository_component", args);
    assert.deepEqual(after.members, before.members);
    assert.equal(after.relations_included, false);
    assert.equal("relations" in after, false);
    const expanded = await call(lean, "get_repository_component", { ...args, include_relations: true });
    assert.deepEqual(expanded.relations, before.relations);
    assert.deepEqual(expanded.neighbors, before.neighbors);
  }
  const relationIds: string[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page = await call(lean, "query_repository_relations", { component_ids: ["component:1"], offset, limit: 1 });
    relationIds.push(...page.items.map((row: { relation_id: string }) => row.relation_id));
    offset = page.next_offset;
  }
  assert.deepEqual(relationIds.sort(), snapshot.graph.edges.map((edge) => edge.id).sort());
  const member = snapshot.graph.nodes[1]!.members[0]!;
  assert.ok(lean.state.exposedEvidence.has(member.stable_id));
  await call(lean, "read_repository_source", { path: member.path });
  await assert.rejects(call(lean, "read_repository_source", { path: "unexposed.ts" }), /source_path_not_exposed/);
  await assert.rejects(call(lean, "get_repository_component", { component_id: "component:2" }), /entity_outside_worker_scope/);
  assert.equal(digestSemanticBatch(snapshot), digest);
});

test("known component source paths bypass directory paging without widening source access", async () => {
  const snapshot = architectureSnapshot(2), node = snapshot.graph.nodes[0]!;
  node.members = Array.from({ length: 200 }, (_, i) => ({ ...node.members[0]!, stable_id: `member:${i}`,
    path: i < 150 ? `src/docs/${i}.md` : `src/runtime/${i}.ts` }));
  const reads: string[] = [];
  const repository = createRepositoryExplorationTools({ snapshot, allowedComponentIds: new Set([node.id]),
    readLines: async (path, start, end) => { reads.push(path); return Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`); } });
  const source = repository.tools.find((tool) => tool.name === "read_repository_source")!;
  const member = node.members[190]!;
  await assert.rejects(source.execute("old", { path: member.path }), /source_path_not_exposed/);
  const result = await source.execute("direct", { component_id: node.id, path: member.path, offset: 10, limit: 200 });
  const page = JSON.parse(result.content.find(row => row.type === "text")!.text);
  assert.equal(page.start_line, 10); assert.equal(page.end_line, 209); assert.equal(page.next_offset, 210);
  assert.deepEqual(page.evidence_ids, [member.stable_id]);
  assert.equal(repository.state.exposedEvidence.get(member.stable_id), member);
  await assert.rejects(source.execute("wrong-member", { component_id: node.id, path: snapshot.graph.nodes[1]!.members[0]!.path }), /source_path_outside_component/);
  await assert.rejects(source.execute("outside", { component_id: snapshot.graph.nodes[1]!.id, path: member.path }), /entity_outside_worker_scope/);
  await assert.rejects(source.execute("missing", { component_id: node.id, path: "src/not-in-snapshot.ts" }), /source_path_outside_component/);
  await assert.rejects(source.execute("escape", { component_id: node.id, path: "../secret" }), /source_path_outside_component/);
  assert.deepEqual(reads, [member.path]);
});

test("file outline locates indexed symbols with paging while retaining source boundaries", async () => {
  const snapshot = architectureSnapshot(2), node = snapshot.graph.nodes[0]!;
  const path = node.members[0]!.path;
  const symbols = Array.from({ length: 55 }, (_, i) => ({ stable_id: `symbol:${i}`, path,
    label: `Module.method${i} (function)`, kind: "symbol", start_line: 701 + i * 4, end_line: 704 + i * 4 }));
  snapshot.fact_graph.nodes = symbols.map(symbol => ({ ...node, id: symbol.stable_id, entity_kind: "fact", evidence: [symbol], members: [] }));
  const before = digestSemanticBatch(snapshot);
  let sourceReads = 0;
  const repository = createRepositoryExplorationTools({ snapshot, allowedComponentIds: new Set([node.id]),
    readLines: async () => { sourceReads++; return ["target implementation"]; } });
  const outline = repository.tools.find(tool => tool.name === "get_repository_file_outline")!;
  const call = async (args: object) => {
    const response = await outline.execute("outline", args);
    return JSON.parse(response.content.find(row => row.type === "text")!.text);
  };
  await assert.rejects(call({ path }), /source_path_not_exposed: .*component_id.*get_repository_component/);
  await assert.rejects(call({ component_id: node.id, path: "outside.ts" }), /source_path_outside_component: .*member_path_prefix/);
  await assert.rejects(call({ component_id: snapshot.graph.nodes[1]!.id, path }), /entity_outside_worker_scope/);
  const first = await call({ component_id: node.id, path, limit: 50 });
  assert.equal(first.coverage, "static_symbols_only");
  assert.equal(first.total, 55);
  assert.equal(first.items.length, 50);
  const last = await call({ path, offset: first.next_offset });
  assert.equal(last.items.length, 5);
  assert.equal(last.next_offset, null);
  const match = await call({ path, query: "METHOD54" });
  assert.deepEqual(match.items, [{ evidence_id: "symbol:54", label: symbols[54]!.label, start_line: 917, end_line: 920 }]);
  assert.ok(repository.state.exposedEvidence.has("symbol:54"));
  assert.equal(sourceReads, 0, "outlines reuse the static index without reading or reparsing files");
  assert.equal((await call({ path, query: "noSuchMethod" })).total, 0);
  snapshot.fact_graph.nodes = [];
  const noParser = createRepositoryExplorationTools({ snapshot, readLines: async () => ["unparsed source"] });
  const empty = await noParser.tools.find(tool => tool.name === "get_repository_file_outline")!.execute("empty", { component_id: node.id, path });
  assert.equal(JSON.parse(empty.content.find(row => row.type === "text")!.text).coverage, "static_symbols_only");
  snapshot.fact_graph.nodes = symbols.map(symbol => ({ ...node, id: symbol.stable_id, entity_kind: "fact", evidence: [symbol], members: [] }));
  assert.equal(digestSemanticBatch(snapshot), before);
});

test("value Agent can locate a late function, read it directly and submit newly exposed symbol evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "value-outline-"));
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
  try {
    const snapshot = architectureSnapshot(1), node = snapshot.graph.nodes[0]!;
    snapshot.source_root = root;
    const path = node.members[0]!.path;
    await mkdir(join(root, "src/agent"), { recursive: true });
    await writeFile(join(root, path), [...Array<string>(700).fill("// unrelated section"),
      "export function enqueue(job: Job) {", "  if (active >= limit) return pending.push(job);", "  return run(job);", "}"].join("\n"));
    const symbol = { stable_id: "symbol:enqueue", path, label: "enqueue (function)", kind: "symbol", start_line: 701, end_line: 704 };
    snapshot.fact_graph.nodes = [{ ...node, id: symbol.stable_id, entity_kind: "fact", evidence: [symbol], members: [] }];
    const faux = fauxProvider({ provider: "value-outline-entry" });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      context => {
        assert.ok(context.tools?.some(tool => tool.name === "get_repository_file_outline"));
        return fauxAssistantMessage(fauxToolCall("get_repository_file_outline", { component_id: node.id, path, query: "enqueue" }));
      },
      context => {
        const tool = context.messages.find(row => row.role === "toolResult" && row.toolName === "get_repository_file_outline");
        assert.ok(tool);
        assert.match(JSON.stringify(tool), /symbol:enqueue/);
        assert.match(JSON.stringify(tool), /701/);
        return fauxAssistantMessage(fauxToolCall("read_repository_source", { path, offset: 701, limit: 4 }));
      },
      context => {
        const tool = context.messages.find(row => row.role === "toolResult" && row.toolName === "read_repository_source");
        assert.ok(tool);
        assert.match(JSON.stringify(tool), /active >= limit/);
        assert.doesNotMatch(JSON.stringify(tool), /unrelated section/);
        return fauxAssistantMessage(fauxToolCall("submit_result", { official_design_review: emptyOfficialReview, value_points: [{
          title: "有界任务处理", claim: "限制同时处理的任务", problem: "资源有限", implementation: "达到上限时将任务排队", tradeoffs: "需要等待", transfer_conditions: "适用于独立任务", component_ids: [node.id], evidence_ids: [symbol.stable_id],
        }] }));
      },
    ]);
    const result = await discoverValues({ snapshot, displayLanguage: "zh-CN", webResearch: emptyWebResearch,
      modelRuntime: { models, model: { ...faux.getModel(), contextWindow: 1_000_000, maxTokens: 384_000 } as Model<Api> } });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.snapshot.value_points[0]?.evidence[0]?.stable_id, symbol.stable_id);
    assert.equal(faux.state.callCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("member prefix paging retains the full directory and labels filtered totals", async () => {
  const snapshot = architectureSnapshot(1), node = snapshot.graph.nodes[0]!;
  node.members = Array.from({ length: 200 }, (_, i) => ({ ...node.members[0]!, stable_id: `member:${i}`,
    path: i < 150 ? `src/docs/${i}.md` : `src/runtime/${i}.ts` }));
  const repository = createRepositoryExplorationTools({ snapshot, readLines: async () => [], componentRelationsDefault: false });
  const tool = repository.tools.find(row => row.name === "get_repository_component")!;
  const call = async (args: object) => {
    const r = await tool.execute("page", { component_id: node.id, ...args });
    return JSON.parse(r.content.find(row => row.type === "text")!.text);
  };
  const first = await call({ member_path_prefix: "src\\runtime\\", limit: 40 });
  const last = await call({ member_path_prefix: "src/runtime/", member_offset: first.members.next_offset, limit: 40 });
  assert.equal(first.members.total, 50); assert.equal(first.members.component_total, 200);
  assert.equal(last.members.next_offset, null);
  assert.deepEqual([...first.members.items, ...last.members.items].map(row => row.path), node.members.slice(150).map(row => row.path));
  const all = await call({ limit: 20 });
  assert.equal(all.members.total, 200); assert.equal(all.members.next_offset, 20);
  assert.equal(all.members.items[0].path, node.members[0]!.path);
});

test("tabular layer material preserves every relation field and nested evidence sample", () => {
  const { snapshot, candidates } = optimizationInput();
  snapshot.graph.edges[0]!.source_observations = [{ extractor: "typescript" }];
  snapshot.graph.edges.push({ ...snapshot.graph.edges[0]!, id: "reverse", source: "component:1", target: "component:0", certainty: "degraded" });
  snapshot.graph.edges.push({ ...snapshot.graph.edges[1]!, id: "self", source: "component:2", target: "component:2", evidence: [] });
  for (const units of [candidates, componentLayerCandidates(snapshot)]) {
    const summary = layerRelationSummary(snapshot, units);
    const compact = compactLayerRelations(summary);
    const restored = compact.relations.map((values) => {
      const row: Record<string, unknown> = Object.fromEntries(compact.relation_columns.map((key, i) => [key, values[i]]));
      row.evidence_samples = (row.evidence_samples as unknown[][]).map((sample, i) => {
        const evidence = Object.fromEntries(compact.relation_evidence_columns.map((column, index) => [column, sample[index]]));
        return { ...evidence, evidence_id: (row.evidence_ids as string[])[i],
          source_component_id: evidence.source_component_id ?? row.source,
          target_component_id: evidence.target_component_id ?? row.target };
      });
      return row;
    });
    assert.deepEqual(restored, summary.relations);
    assert.deepEqual(compact.relation_resolution, summary.relation_resolution);
    assert.equal(compact.evidence_sampling, summary.evidence_sampling);
    assert.equal(compact.external_relation_count, summary.external_relation_count);
  }
});

test("component material covers later runtime directories and preloads the root overview before tool exploration", async () => {
  const root = await mkdtemp(join(tmpdir(), "component-overview-"));
  try {
    await writeFile(join(root, "README.md"), "# 能力族\n包含构建生成器和运行时注册表，两者职责不同。\n");
    const snapshot = architectureSnapshot(1);
    snapshot.source_root = root;
    const component = snapshot.graph.nodes[0]!;
    const template = component.members[0]!;
    component.members = [...Array.from({ length: 7 }, (_, i) => ({ ...template, stable_id: `file:build-${i}`, path: `build/${i}.ts` })),
      { ...template, stable_id: "file:overview", path: "README.md" },
      { ...template, stable_id: "file:runtime", path: "runtime/index.ts" }];
    const before = JSON.stringify(component);
    const prepared = await prepareComponentBatchInput(snapshot, [component.id], "component", false, "zh-CN");
    const row = (prepared.input.components as Array<Record<string, any>>)[0]!;
    assert.equal("current_layer_name" in row, false);
    assert.deepEqual(row.member_sections.map((section: any) => [section.path, section.file_count]), [[".", 1], ["build", 7], ["runtime", 1]]);
    assert.match(row.overview_excerpt.content, /运行时注册表/);
    assert.equal(row.overview_excerpt.evidence_id, "file:overview");
    assert.equal(prepared.diagnostics.read_count, 1);
    assert.equal(JSON.stringify(component), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("component submissions report omissions before starting a separate repair batch", () => {
  const patch = { component_id: "a", name: "请求入口", responsibility: "接收并处理请求", layer_name: "应用入口层" };
  const value: ComponentWorkerResult = { mode: "components", components: [patch] };
  assert.match(validateComponentSubmission(value, ["a", "b"], "zh-CN").join("\n"), /component_missing: b/);
  assert.deepEqual(validateComponentSubmission({ ...value, components: [patch, { ...patch, component_id: "b" }] }, ["a", "b"], "zh-CN"), []);
  const errors = validateComponentSubmission({ ...value, components: [patch, patch, { ...patch, component_id: "outside" }] }, ["a", "b"], "zh-CN");
  assert.ok(errors.some((error) => error.startsWith("component_duplicate:")));
  assert.ok(errors.some((error) => error.startsWith("component_unknown:")));
  assert.ok(errors.some((error) => error.startsWith("component_missing:")));
});

test("component preparation retains independent child overviews with bounded source and unchanged members", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-overview-"));
  try {
    await mkdir(join(root, "variant"));
    await writeFile(join(root, "README.md"), "# Family\nRoot claims a shared role.\n");
    await writeFile(join(root, "variant", "README.md"), "# Variant\nThis variant has a different lifecycle.\n" + "Additional detail.\n".repeat(100));
    const snapshot = architectureSnapshot(1); snapshot.source_root = root;
    const node = snapshot.graph.nodes[0]!, template = node.members[0]!;
    node.members = [
      { ...template, stable_id: "root", path: "README.md" },
      { ...template, stable_id: "child", path: "variant/README.md" },
      { ...template, stable_id: "missing", path: "missing/README.md" },
    ];
    const before = JSON.stringify(node);
    const prepared = await prepareComponentBatchInput(snapshot, [node.id], "children", false, "zh-CN");
    const row = (prepared.input.components as Array<Record<string, any>>)[0]!;
    const child = row.member_sections.find((s: any) => s.path === "variant").overview_excerpt;
    assert.match(child.content, /different lifecycle/);
    assert.ok(Buffer.byteLength(child.content) <= 800);
    assert.equal(child.evidence_id, "child"); assert.equal(child.truncated, true);
    assert.ok(child.next_offset > 1);
    assert.equal(row.member_sections.find((s: any) => s.path === "missing").overview_excerpt.status, "unavailable");
    assert.equal(prepared.diagnostics.read_count, 3);
    assert.equal(prepared.diagnostics.unavailable_count, 1);
    assert.equal(JSON.stringify(node), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("layer material keeps late member directories and resolvable child evidence beyond the root excerpt", async () => {
  const snapshot = architectureSnapshot(1);
  const component = snapshot.graph.nodes[0]!, template = component.members[0]!;
  component.members = [
    { ...template, stable_id: "root-doc", path: "family/README.md" },
    ...Array.from({ length: 12 }, (_, i) => ({ ...template, stable_id: `early-${i}`, path: `family/early/${i}.ts` })),
    { ...template, stable_id: "late-doc", path: "family/late/README.md" },
    { ...template, stable_id: "late-code", path: "family/late/index.ts" },
  ];
  const candidates = initialLayerCandidates(snapshot, new Map());
  for (const includeScopes of [true, false]) {
    const input = layerBatchInput(snapshot, candidates, "layer", "zh-CN", includeScopes);
    const row = ((includeScopes ? input.scope_components : input.component_summaries) as Array<Record<string, any>>)[0]!;
    assert.equal(row.evidence_ids.includes("late-doc"), false);
    assert.equal(row.member_sections.reduce((n: number, section: any) => n + section.file_count, 0), 15);
    const late = row.member_sections.find((section: any) => section.path === "family/late");
    assert.equal(late.overview_evidence[0].evidence_id, "late-doc");
    const repository = createRepositoryExplorationTools({ snapshot, readLines: async () => ["Implementation has an independently verifiable role."] });
    const read = repository.tools.find((tool) => tool.name === "read_repository_source")!;
    await assert.rejects(read.execute("before", { path: "family/late/README.md" }), /source_path_not_exposed/);
    await repository.tools.find((tool) => tool.name === "get_repository_evidence")!.execute("resolve", { evidence_ids: [late.overview_evidence[0].evidence_id] });
    await read.execute("after", { path: "family/late/README.md" });
  }
});

test("layer submission checks coverage, duplicates, cross-layer groups and relevant evidence", () => {
  const { snapshot, candidates, value } = optimizationInput();
  assert.deepEqual(validateLayerSubmission(value, snapshot, candidates, true, "zh-CN"), []);
  const cases: Array<[string, (copy: LayerWorkerResult) => void]> = [
    ["missing_component", (copy) => { copy.direct_component_ids = []; }],
    ["duplicate_component", (copy) => { copy.direct_component_ids.push("component:0"); }],
    ["scope_layer", (copy) => { copy.scopes[0]!.component_ids = ["component:0", "component:2"]; copy.direct_component_ids = ["component:1"]; }],
    ["scope_evidence", (copy) => { copy.scopes[0]!.evidence_ids = [snapshot.graph.nodes[2]!.evidence[0]!.stable_id]; }],
    ["duplicate_mapping", (copy) => { copy.mappings.push(copy.mappings[0]!); }],
  ];
  for (const [code, mutate] of cases) {
    const copy = structuredClone(value); mutate(copy);
    assert.ok(validateLayerSubmission(copy, snapshot, candidates, true, "zh-CN").some((error) => error.startsWith(code + ":")), code);
  }
});

test("layer summaries retain uncertainty and bounded source locations without changing graph evidence", () => {
  const { snapshot, candidates } = optimizationInput();
  snapshot.graph.edges[0]!.certainty = "verified";
  snapshot.graph.edges[0]!.source_observations = [{ extractor: "typescript", certainty: "verified" }];
  snapshot.graph.edges[1]!.certainty = "degraded";
  snapshot.summary.unresolved_syntax_call_count = 17;
  const before = JSON.stringify(snapshot);
  const result = layerRelationSummary(snapshot, candidates);
  assert.equal(result.relations.reduce((sum, row) => sum + (row.component_edge_certainty_counts.verified ?? 0), 0), 1);
  assert.equal(result.relations.reduce((sum, row) => sum + (row.component_edge_certainty_counts.degraded ?? 0), 0), 1);
  assert.ok(result.relations.some((row) => row.extractors.includes("typescript")));
  assert.ok(result.relations.every((row) => row.evidence_samples.length <= 2));
  assert.equal(result.relation_resolution.unresolved_syntax_calls, 17);
  assert.equal(JSON.stringify(snapshot), before);
});

test("evidence-backed reassignments govern scopes and survive final assembly without changing facts", async () => {
  const { snapshot, patches, candidates, value } = optimizationInput();
  const target = value.mappings.find((row) => candidates.find((candidate) => candidate.id === row.candidate_id)?.componentIds.includes("component:2"))!.group_id;
  const evidence = snapshot.graph.nodes[1]!.evidence[0]!.stable_id;
  value.component_reassignments = [{ component_id: "component:1", group_id: target, rationale: "实现证据说明该组件承担持久化，与存储组件共同负责数据落盘", evidence_ids: [evidence] }];
  value.scopes[0] = { ...value.scopes[0]!, layer_group_id: target, component_ids: ["component:1", "component:2"], evidence_ids: [evidence] };
  value.direct_component_ids = ["component:0"];
  assert.deepEqual(validateLayerSubmission(value, snapshot, candidates, true, "zh-CN"), []);
  const runtime = { model: { provider: "test", id: "model", maxTokens: 100 } } as unknown as PiModelRuntime;
  const prepared = await prepareLayerBatchInput(layerSemanticView(snapshot, patches, "zh-CN"), candidates, "layer-global-final", "zh-CN", true);
  const batch = createSemanticBatch({ job_id: "offline", batch_id: "layer-global-final", snapshot_id: snapshot.snapshot_id, phase: "architecture_layers", ordinal: 20_000, input: semanticBatchInputIdentity(prepared.input, runtime, "architecture-planning", await loadProductSkill("architecture-planning")) }, 1, null, null, new Date().toISOString());
  const reject = async () => { throw new Error("offline replay must not call a Provider"); };
  const output = { value, skillVersion: "4.2.0", evalSuite: "test", stopReason: "completed", validationErrors: [] as string[] };
  const batchContext = { jobId: "offline", recorder: { load: async () => ({ ...batch, status: "succeeded" as const, output }), start: reject, complete: reject, fail: reject } };
  const result = await consolidateLayers({ snapshot, patches, displayLanguage: "zh-CN", modelRuntime: runtime, batchContext });
  assert.equal(result.degraded, false);
  assert.equal(result.workerRuns[0]?.component_reassignment_count, 1);
  assert.equal(result.patches.get("component:1")?.layer_name, patches.get("component:2")!.layer_name);
  assert.equal(result.patches.get("component:1")?.layer_rationale, value.component_reassignments[0]!.rationale);
  const final = applyArchitectureResult(snapshot, { components: [...result.patches.values()], scopes: result.scopes, direct_component_ids: result.directComponentIds });
  assert.equal(final.fact_graph, snapshot.fact_graph);
  assert.deepEqual(final.graph.edges.filter((edge) => !edge.id.startsWith("hierarchy:edge:")), snapshot.graph.edges);
  assert.deepEqual(final.graph.nodes.filter((node) => node.entity_kind === "component").map((node) => [node.id, node.members]), snapshot.graph.nodes.map((node) => [node.id, node.members]));
  assert.equal(final.graph.nodes.filter((node) => node.entity_kind === "domain" && node.certainty === "provider_supported").length, 1);
  assert.equal(final.graph.nodes.find((node) => node.entity_kind === "domain")?.architecture_layer_rationale, value.groups.find((group) => group.group_id === target)!.rationale);
  output.validationErrors = ["reassignment_evidence: rejected"];
  // Invalid legacy successes now require a retry; this recorder stops before any model call.
  await assert.rejects(
    consolidateLayers({ snapshot, patches, displayLanguage: "zh-CN", modelRuntime: runtime, batchContext }),
    /offline replay must not call a Provider/u,
  );
});

test("component corrections reject unrelated evidence, invalid targets, duplicates and stale scopes", () => {
  const { snapshot, candidates, value } = optimizationInput();
  const target = value.mappings.find((row) => candidates.find((candidate) => candidate.id === row.candidate_id)?.componentIds.includes("component:2"))!.group_id;
  const correction = { component_id: "component:0", group_id: target, rationale: "组件实现及依赖证据支持调整到存储层", evidence_ids: [snapshot.graph.nodes[0]!.evidence[0]!.stable_id] };
  value.component_reassignments = [correction]; value.scopes = []; value.direct_component_ids = ["component:0", "component:1", "component:2"];
  assert.deepEqual(validateLayerSubmission(value, snapshot, candidates, true, "zh-CN"), []);
  const cases: Array<[string, (copy: LayerWorkerResult) => void]> = [
    ["reassignment_evidence", (copy) => { copy.component_reassignments[0]!.evidence_ids = [snapshot.graph.nodes[2]!.evidence[0]!.stable_id]; }],
    ["unknown_reassignment", (copy) => { copy.component_reassignments[0]!.group_id = "missing"; }],
    ["unknown_reassignment", (copy) => { copy.component_reassignments[0]!.component_id = "missing"; }],
    ["duplicate_reassignment", (copy) => { copy.component_reassignments.push(correction); }],
    ["unchanged_reassignment", (copy) => { copy.component_reassignments[0]!.group_id = copy.mappings.find((row) => row.group_id !== target)!.group_id; }],
    ["scope_layer", (copy) => { copy.scopes = optimizationInput().value.scopes; copy.direct_component_ids = ["component:2"]; }],
    ["empty_group", (copy) => { copy.groups.push({ ...copy.groups[0]!, group_id: "empty" }); }],
    ["duplicate_group_name", (copy) => { copy.groups[1]!.name = copy.groups[0]!.name; }],
    ["reassignment_limit", (copy) => { copy.component_reassignments = Array.from({ length: 17 }, () => correction); }],
  ];
  for (const [code, mutate] of cases) { const copy = structuredClone(value); mutate(copy); assert.ok(validateLayerSubmission(copy, snapshot, candidates, true, "zh-CN").some((error) => error.startsWith(code + ":")), code); }
  value.scopes = []; value.direct_component_ids = [];
  assert.ok(validateLayerSubmission(value, snapshot, candidates, false, "zh-CN").some((error) => error.startsWith("reassignment_limit:")));
});

test("a corrected component can form a new nonempty layer", () => {
  const { snapshot, candidates, value } = optimizationInput();
  value.groups.push({ group_id: "new", name: "执行适配层", responsibility: "承载隔离执行能力", rationale: "组件实现体现独立的运行职责" });
  value.component_reassignments = [{ component_id: "component:0", group_id: "new", rationale: "该组件提供运行期执行能力，需要独立边界", evidence_ids: [snapshot.graph.nodes[0]!.evidence[0]!.stable_id] }];
  value.scopes = []; value.direct_component_ids = ["component:0", "component:1", "component:2"];
  assert.deepEqual(validateLayerSubmission(value, snapshot, candidates, true, "zh-CN"), []);
});

test("large layer input declares omitted components and preserves a complete manifest", () => {
  const snapshot = architectureSnapshot(97);
  const candidates = initialLayerCandidates(snapshot, new Map());
  const input = layerBatchInput(snapshot, candidates, "layer", "zh-CN", true);
  assert.equal((input.scope_components as unknown[]).length, 96);
  assert.equal((input.omitted_scope_component_ids as unknown[]).length, 1);
  assert.equal((input.component_manifest as Array<{ component_ids: string[] }>).flatMap((row) => row.component_ids).length, 97);
});

test("explicit direct components are not silently regrouped by the layout fallback", () => {
  const snapshot = architectureSnapshot(13);
  const result = applyArchitectureResult(snapshot, {
    components: snapshot.graph.nodes.map((node) => ({ component_id: node.id, name: "独立职责组件", responsibility: "承担独立职责", layer_name: "共享能力层" })),
    direct_component_ids: snapshot.graph.nodes.map((node) => node.id),
  });
  assert.equal(result.graph.nodes.filter((node) => node.entity_kind === "domain").length, 0);
  assert.equal(result.graph.nodes.filter((node) => node.entity_kind === "component").length, 13);
});

test("semantic cache identity changes when effective model configuration changes", () => {
  const runtime = { model: { provider: "test", id: "model", api: "test", baseUrl: "https://example.com", maxTokens: 100, reasoning: true } } as unknown as PiModelRuntime;
  const input = { components: ["a"] };
  const before = digestSemanticBatch(semanticBatchInputIdentity(input, runtime, "architecture-planning"));
  const changed = { ...runtime, model: { ...runtime.model, maxTokens: 200 } };
  assert.notEqual(before, digestSemanticBatch(semanticBatchInputIdentity(input, changed, "architecture-planning")));
  const wireChanged = { ...runtime, model: { ...runtime.model, compat: { maxTokensField: "max_tokens" as const } } };
  assert.notEqual(before, digestSemanticBatch(semanticBatchInputIdentity(input, wireChanged, "architecture-planning")));
});

test("bounded layer overviews retain evidence locations and the source path fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "layer-overview-"));
  try {
    await writeFile(join(root, "README.md"), Array.from({ length: 100 }, (_, i) => `概览第${i}行：${"说明".repeat(20)}`).join("\n"));
    const snapshot = architectureSnapshot(1);
    snapshot.source_root = root;
    snapshot.graph.nodes[0]!.members = [{ ...snapshot.graph.nodes[0]!.members[0]!, path: "README.md" }];
    const candidates = initialLayerCandidates(snapshot, new Map());
    const prepared = await prepareLayerBatchInput(snapshot, candidates, "layer", "zh-CN", true);
    const row = (prepared.input.scope_components as Array<{ overview_excerpt: { evidence_id: string; path: string; content: string; start_line: number; next_offset: number; truncated: boolean; status: string } }>)[0]!;
    assert.equal(row.overview_excerpt.evidence_id, snapshot.graph.nodes[0]!.members[0]!.stable_id);
    assert.equal(row.overview_excerpt.path, "README.md");
    assert.equal(row.overview_excerpt.start_line, 1);
    assert.ok(Buffer.byteLength(row.overview_excerpt.content) <= 1600);
    assert.ok(row.overview_excerpt.truncated && row.overview_excerpt.next_offset > 1);
    assert.equal(prepared.diagnostics.read_count, 1);
    snapshot.graph.nodes[0]!.members[0]!.path = "../README.md";
    const blocked = await prepareLayerBatchInput(snapshot, candidates, "layer", "zh-CN", true);
    assert.equal(blocked.diagnostics.unavailable_count, 1);
    assert.equal((blocked.input.scope_components as Array<{ overview_excerpt: { status: string } }>)[0]!.overview_excerpt.status, "unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("valid model plans with eighteen items are not merged to the twelve-item fallback target", () => {
  const snapshot = architectureSnapshot(23);
  const scopes = ["入口", "执行", "存储", "查询", "通知"].map((name, i) => ({ name: `${name}协作职责`, responsibility: "共同处理具体职责", grouping_rationale: "根据现有关系归组", component_ids: [`component:${i * 2}`, `component:${i * 2 + 1}`], evidence_ids: [snapshot.graph.nodes[i * 2]!.evidence[0]!.stable_id] }));
  const final = applyArchitectureResult(snapshot, { components: snapshot.graph.nodes.map((node) => ({ component_id: node.id, name: "有明确职责的组件", responsibility: "承载一项具体功能", layer_name: "共享能力层" })), scopes, direct_component_ids: snapshot.graph.nodes.slice(10).map((node) => node.id) });
  const retained = final.graph.nodes.filter((node) => node.entity_kind === "domain");
  assert.equal(retained.length, 5);
  assert.ok(retained.every((node) => node.certainty === "provider_supported"));
  assert.deepEqual(retained.map((node) => node.name).sort(), scopes.map((scope) => scope.name).sort());
});

test("layer evidence identifies the component overview without generalizing its first member rationale", () => {
  const { snapshot, patches, candidates } = optimizationInput();
  const node = snapshot.graph.nodes[0]!;
  const evidence = node.members[0]!;
  node.members.push({ ...evidence, stable_id: "readme:child", path: "packages/family/child/README.md" });
  node.members.push({ ...evidence, stable_id: "readme:family", path: "packages/family/README.md" });
  const input = layerBatchInput(layerSemanticView(snapshot, patches, "zh-CN"), candidates, "layer", "zh-CN", true);
  const row = (input.scope_components as Array<{ component_id: string; member_count: number; overview_evidence: Array<{ evidence_id: string }> }>).find((item) => item.component_id === node.id)!;
  assert.equal(row.member_count, node.members.length);
  assert.equal(row.overview_evidence[0]?.evidence_id, "readme:family");
  assert.equal((input.candidates as Record<string, unknown>[]).some((item) => "current_rationale" in item), false);
});

test("responsibility scopes reject placeholders and single-component wrappers", () => {
  const snapshot = architectureSnapshot(4);
  const components = snapshot.graph.nodes.map((component) => ({
    component_id: component.id,
    name: `语义${component.name}`,
    responsibility: "承担一项明确职责。",
    layer_name: "核心能力层",
    layer_rationale: "这些组件共同实现核心能力。",
  }));
  const enriched = applyArchitectureResult(snapshot, {
    components,
    scopes: [{
      name: "请求与执行职责",
      responsibility: "连接请求入口与核心执行。",
      grouping_rationale: "两者之间存在直接静态调用关系。",
      component_ids: ["component:0", "component:1"],
      evidence_ids: ["evidence:component:0"],
    }, {
      name: "Cluster A",
      responsibility: "不应发布。",
      grouping_rationale: "占位名称不合格。",
      component_ids: ["component:2", "component:3"],
      evidence_ids: ["evidence:component:2"],
    }, {
      name: "单组件职责",
      responsibility: "不应包装。",
      grouping_rationale: "只有一个组件。",
      component_ids: ["component:3"],
      evidence_ids: ["evidence:component:3"],
    }],
  });
  const scopes = enriched.graph.nodes.filter((node) => node.entity_kind === "domain");
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.name, "请求与执行职责");
  assert.deepEqual((scopes[0]?.attributes?.component_ids as string[]).sort(), ["component:0", "component:1"]);
  assert.equal(enriched.graph.nodes.find((node) => node.id === "component:2")?.parent_entity_id, null);
  assert.equal(enriched.graph.nodes.find((node) => node.id === "component:3")?.parent_entity_id, null);
});

test("large layers publish one bounded semantic tree without path modules", () => {
  const snapshot = architectureSnapshot(25);
  const factGraph = snapshot.fact_graph;
  const enriched = applyArchitectureResult(snapshot, {
    components: snapshot.graph.nodes.map((component, index) => ({
      component_id: component.id,
      name: `能力组件 ${index}`,
      responsibility: index % 2 === 0 ? "处理分析与图谱职责。" : "处理数据与任务职责。",
      layer_name: "核心能力层",
      layer_rationale: "这些组件共同承载仓库的核心执行能力。",
    })),
  });
  const roots = enriched.graph.nodes.filter((node) => node.entity_kind === "repository");
  const layers = enriched.graph.nodes.filter((node) => node.entity_kind === "system");
  const scopes = enriched.graph.nodes.filter((node) => node.entity_kind === "domain");
  const components = enriched.graph.nodes.filter((node) => node.entity_kind === "component");
  assert.equal(roots.length, 1);
  assert.equal(layers.length, 1);
  assert.equal(components.length, 25);
  assert.equal(enriched.graph.nodes.some((node) => node.entity_kind === "subsystem" || node.entity_kind === "module"), false);
  assert.ok(scopes.every((scope) => scope.member_count >= 2 && scope.member_count <= 18));
  assert.ok(scopes.every((scope) => !/cluster|other|未分层|其他|职责范围\s*\d/iu.test(scope.name)));
  assert.ok(scopes.every((scope) => scope.evidence.length > 0));
  const layerId = layers[0]?.id as string;
  const directComponents = components.filter((component) => component.parent_entity_id === layerId);
  assert.ok(scopes.length + directComponents.length <= 18);
  assert.ok(components.every((component) => Boolean(component.parent_entity_id)));
  assert.equal(enriched.graph.hierarchy?.max_depth, 3);
  assert.deepEqual(enriched.fact_graph, factGraph);
});

test("candidate hierarchy keeps small repositories flat and adds bounded levels for large ones", () => {
  const small = buildCandidateHierarchy({
    repository: "example/small",
    components: [hierarchyNode("component:one", "src")],
    edges: [],
  });
  assert.equal(small.generated, false);
  assert.deepEqual(small.hierarchy, { root_entity_ids: ["component:one"], max_depth: 0 });

  const components = Array.from({ length: 9 }, (_, index) => hierarchyNode(
    `component:${index}`,
    index % 2 === 0 ? "src/api" : "src/domain",
  ));
  const large = buildCandidateHierarchy({
    repository: "example/large",
    components,
    edges: [],
  });
  assert.equal(large.generated, true);
  assert.ok(large.nodes.some((node) => node.entity_kind === "repository"));
  assert.ok(large.nodes.some((node) => node.entity_kind === "subsystem"));
  assert.equal(large.nodes.filter((node) => node.entity_kind === "component").length, 9);
  assert.equal(large.nodes.filter((node) => node.entity_kind === "component").every((node) => node.parent_entity_id), true);
  assert.ok(large.edges.every((edge) => large.nodes.some((node) => node.id === edge.source) && large.nodes.some((node) => node.id === edge.target)));
});

test("hierarchy operations require Evidence, protect facts, and reject cycles", () => {
  const parent = hierarchyNode("component:parent", "src");
  const child = hierarchyNode("component:child", "src");
  const fact = { ...hierarchyNode("fact:file", "src"), entity_kind: "fact" as const };
  const result = applyHierarchyOperations({
    nodes: [parent, child, fact],
    edges: [],
    operations: [
      { operation: "nest", entity_id: child.id, parent_entity_id: parent.id, evidence_ids: [child.evidence[0].stable_id] },
      { operation: "name", entity_id: fact.id, name: "伪造事实", evidence_ids: [fact.evidence[0].stable_id] },
      { operation: "nest", entity_id: parent.id, parent_entity_id: child.id, evidence_ids: [parent.evidence[0].stable_id] },
      { operation: "explain", entity_id: child.id, responsibility: "缺少证据的解释", evidence_ids: ["missing:evidence"] },
    ],
  });
  assert.equal(result.operations[0]?.status, "accepted");
  assert.equal(result.operations[1]?.reason, "fact_entity_immutable:fact:file");
  assert.equal(result.operations[2]?.reason, "hierarchy_cycle");
  assert.equal(result.operations[3]?.reason, "evidence_missing:missing:evidence");
  assert.equal(result.nodes.find((node) => node.id === child.id)?.parent_entity_id, parent.id);
  assert.ok(result.edges.some((edge) => edge.id.startsWith("hierarchy:edge:")));
});

test("TypeScript static analysis emits symbols and a user-facing component graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-"));
  try {
    await writeFile(join(root, "main.ts"), "import { helper } from './helper';\nexport function start() { return helper(); }\n", "utf8");
    await writeFile(join(root, "helper.ts"), "export function helper() { return 1; }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const files = [await analyzer.analyzeFile(root, "main.ts"), await analyzer.analyzeFile(root, "helper.ts")];
    assert.equal(files.length, 2);
    assert.ok(files.some((file) => file.symbols.length > 0));
    const snapshot = buildSnapshot({ snapshotId: "snap:test", repository: "example/repo", commitSha: "a".repeat(40), files, sourceRoot: root });
    assert.equal((snapshot.summary as { file_count: number }).file_count, 2);
    assert.ok(snapshot.graph.nodes.length >= 1);
    assert.ok(snapshot.graph.nodes.every((node) => node.id.startsWith("component:")));
    assert.ok(snapshot.fact_graph.nodes.some((node) => node.id.startsWith("fact:file:")));
    assert.ok(snapshot.fact_graph.nodes.some((node) => node.id.startsWith("fact:symbol:")));
    assert.equal(snapshot.value_points.length, 0);
    assert.equal(snapshot.languages[0]?.quality_tier, "degraded");
    assert.ok(snapshot.languages[0]?.reason_codes.includes("lsp_unavailable"));
    const component = snapshot.graph.nodes[0];
    assert.match(component.grouping_rationale ?? "", /结构目录/);
    const memberIds = component.members.map((row) => row.stable_id);
    const enriched = applySemanticResult(snapshot, {
      components: [{
        component_id: component.id,
        name: "启动与问候服务",
        responsibility: "连接入口函数与问候逻辑。",
        layer_name: "应用服务层",
        grouping_rationale: "入口与 helper 共同完成一次问候请求。",
        layer_rationale: "它们负责应用用例编排，不承担传输或存储职责。",
      }, {
        component_id: "component:invented",
        name: "不存在的组件",
        responsibility: "不应写入图谱。",
        layer_name: "未知层",
      }],
      value_points: [{
        title: "入口与核心逻辑解耦",
        claim: "入口只负责编排，核心函数保持独立。",
        problem: "避免入口承担全部逻辑。",
        implementation: "入口调用独立 helper。",
        tradeoffs: "增加一个模块边界。",
        transfer_conditions: "适合需要独立测试核心逻辑的应用。",
        component_ids: [component.id],
        evidence_ids: [component.evidence[0].stable_id],
      }, {
        title: "幻觉价值点",
        claim: "没有证据。",
        problem: "无",
        implementation: "无",
        tradeoffs: "无",
        transfer_conditions: "无",
        component_ids: ["component:invented"],
        evidence_ids: ["fact:invented"],
      }],
    });
    assert.equal(enriched.graph.semantic_mode, "provider_supported");
    assert.equal(enriched.graph.nodes[0].name, "启动与问候服务");
    assert.equal(enriched.graph.nodes[0].grouping_rationale, "入口与 helper 共同完成一次问候请求。");
    assert.equal(enriched.graph.nodes[0].architecture_layer_rationale, "它们负责应用用例编排，不承担传输或存储职责。");
    assert.deepEqual(enriched.graph.nodes[0].members.map((row) => row.stable_id), memberIds);
    assert.equal(enriched.graph.nodes.some((node) => node.id === "component:invented"), false);
    assert.equal(enriched.value_points.length, 1);
    assert.equal(enriched.learning_plan.steps.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("translated semantic text does not change layer or value-point identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-language-identity-"));
  try {
    await writeFile(join(root, "main.ts"), "export function start() { return 1; }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const file = await analyzer.analyzeFile(root, "main.ts");
    const base = buildSnapshot({
      snapshotId: "snap:language-identity",
      repository: "example/language-identity",
      commitSha: "f".repeat(40),
      files: [file],
      sourceRoot: root,
    });
    const component = base.graph.nodes[0];
    const evidenceId = component.evidence[0].stable_id;
    const chineseArchitecture = applyArchitectureResult(base, {
      components: [{
        component_id: component.id,
        name: "运行入口",
        responsibility: "负责启动应用。",
        layer_name: "应用层",
      }],
    });
    const englishArchitecture = applyArchitectureResult(base, {
      components: [{
        component_id: component.id,
        name: "Runtime entry",
        responsibility: "Starts the application.",
        layer_name: "Application layer",
      }],
    });
    assert.equal(chineseArchitecture.graph.layers[0].id, englishArchitecture.graph.layers[0].id);
    assert.equal(
      chineseArchitecture.graph.nodes[0].architecture_layer_id,
      englishArchitecture.graph.nodes[0].architecture_layer_id,
    );
    const chineseValue = applyValueDiscoveryResult(chineseArchitecture, { official_design_review: emptyOfficialReview, value_points: [{
      title: "入口隔离",
      claim: "入口与实现边界清楚。",
      problem: "启动逻辑容易扩散。",
      implementation: "独立入口负责启动。",
      tradeoffs: "增加一个边界。",
      transfer_conditions: "适用于需要独立启动流程的项目。",
      component_ids: [component.id],
      evidence_ids: [evidenceId],
    }] });
    const englishValue = applyValueDiscoveryResult(englishArchitecture, { official_design_review: emptyOfficialReview, value_points: [{
      title: "Entry isolation",
      claim: "The entry and implementation boundary is explicit.",
      problem: "Startup logic can spread.",
      implementation: "A dedicated entry owns startup.",
      tradeoffs: "It adds one boundary.",
      transfer_conditions: "Use it when startup needs an independent flow.",
      component_ids: [component.id],
      evidence_ids: [evidenceId],
    }] });
    assert.equal(chineseValue.value_points[0].stable_id, englishValue.value_points[0].stable_id);
    assert.deepEqual(chineseValue.value_points[0].component_ids, [component.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different value points sharing evidence survive language storage independently", () => {
  const base = architectureSnapshot(2);
  const point = (component: number, title: string) => ({
    title, claim: title, problem: "Shared implementation supports different decisions.",
    implementation: "Keep both decisions and their evidence.", tradeoffs: "Different tradeoffs.",
    transfer_conditions: "Choose the relevant decision.",
    component_ids: [base.graph.nodes[component]!.id],
    evidence_ids: [base.graph.nodes[component]!.evidence[0]!.stable_id],
  });
  const input = { official_design_review: emptyOfficialReview, value_points: [point(0, "Clear queued work"), point(1, "Independent decision"), point(0, "Adjust concurrency")] };
  const result = applyValueDiscoveryResult(base, input);
  const ids = result.value_points.map((value) => value.stable_id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(result.value_points.map((value) => value.title), input.value_points.map((value) => value.title));
  assert.deepEqual(result.value_points[0]!.evidence, result.value_points[2]!.evidence);
  const roundTrip = applySnapshotLanguageOverlay(stripSnapshotLanguage(result), extractSnapshotLanguageOverlay(result, "en"));
  assert.deepEqual(roundTrip.value_points, result.value_points);
  const translated = applyValueDiscoveryResult(base, { official_design_review: emptyOfficialReview, value_points: input.value_points.map((value, index) => ({ ...value, title: `中文决定${index}`, claim: `中文说明${index}` })) });
  assert.deepEqual(translated.value_points.map((value) => value.stable_id), ids);
  const withoutIndependent = applyValueDiscoveryResult(base, { official_design_review: emptyOfficialReview, value_points: [input.value_points[0]!, input.value_points[2]!] });
  assert.deepEqual(withoutIndependent.value_points.map((value) => value.stable_id), [ids[0], ids[2]]);
  assert.equal(applyValueDiscoveryResult(base, { official_design_review: emptyOfficialReview, value_points: [input.value_points[1]!] }).value_points[0]!.stable_id, ids[1]);
});

test("language overlay strips shared prose and restores per-edge fact counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-language-overlay-"));
  try {
    await writeFile(join(root, "a.ts"), "import { b } from './b'; export function a() { return b(); }\n", "utf8");
    await writeFile(join(root, "b.ts"), "export function b() { return 1; }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const snapshot = buildSnapshot({
      snapshotId: "snap:language-overlay",
      repository: "example/language-overlay",
      commitSha: "1".repeat(40),
      files: [await analyzer.analyzeFile(root, "a.ts"), await analyzer.analyzeFile(root, "b.ts")],
      sourceRoot: root,
    });
    const overlay = extractSnapshotLanguageOverlay(snapshot, "en");
    const base = stripSnapshotLanguage(snapshot);
    assert.ok(base.graph.nodes.every((node) => node.responsibility === ""));
    assert.ok(base.graph.edges.every((edge) => edge.description === ""));
    const restored = applySnapshotLanguageOverlay(base, overlay);
    assert.equal(restored.display_language, "en");
    assert.ok(restored.graph.edges.every((edge) => !edge.description.includes("{count}")));
    assert.ok(restored.graph.edges.every((edge) => edge.description.includes(String(edge.weight))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("language validation degradation retains evidence-backed semantic results", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-language-degraded-"));
  try {
    await writeFile(join(root, "main.ts"), "export function start() { return 1; }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const file = await analyzer.analyzeFile(root, "main.ts");
    const snapshot = buildSnapshot({
      snapshotId: "snap:language-degraded",
      repository: "example/language-degraded",
      commitSha: "d".repeat(40),
      files: [file],
      sourceRoot: root,
    });
    const component = snapshot.graph.nodes[0];
    const architecture = applyArchitectureResult(snapshot, {
      components: [{
        component_id: component.id,
        name: "Runtime Entry",
        responsibility: "Starts the runtime.",
        layer_name: "Application Layer",
      }],
    }, {
      supportedIds: new Set(),
      degradedIds: [component.id],
    });
    assert.equal(architecture.graph.nodes[0].name, "Runtime Entry");
    assert.equal(architecture.graph.nodes[0].certainty, "degraded");
    assert.equal(
      architecture.graph.nodes[0].attributes?.architecture_semantic_status,
      "language_mismatch_after_retry",
    );

    const values = applyValueDiscoveryResult(architecture, {
      value_points: [{
        title: "Runtime isolation",
        claim: "The runtime boundary is explicit.",
        problem: "Untrusted execution needs isolation.",
        implementation: "The entry component owns the boundary.",
        tradeoffs: "The boundary adds operational cost.",
        transfer_conditions: "Use it when execution crosses a trust boundary.",
        component_ids: [component.id],
        evidence_ids: [component.evidence[0].stable_id],
      }],
    }, undefined, "zh-CN");
    assert.equal(values.value_points.length, 1);
    assert.equal(values.value_points[0].title, "Runtime isolation");
    assert.equal(values.value_points[0].certainty, "degraded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing optional architecture rationales do not downgrade valid component semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-language-optional-"));
  try {
    await writeFile(join(root, "main.ts"), "export function start() { return 1; }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const file = await analyzer.analyzeFile(root, "main.ts");
    const snapshot = buildSnapshot({
      snapshotId: "snap:language-optional",
      repository: "example/language-optional",
      commitSha: "e".repeat(40),
      files: [file],
      sourceRoot: root,
    });
    const component = snapshot.graph.nodes[0];
    const patch = {
      component_id: component.id,
      name: "运行入口",
      responsibility: "负责启动应用运行时。",
      layer_name: "应用入口层",
      grouping_rationale: null as unknown as string,
      layer_rationale: null as unknown as string,
    };
    assert.equal(componentLanguageError(patch, "zh-CN"), null);
    const enriched = applyArchitectureResult(snapshot, { components: [patch] }, {
      supportedIds: new Set([component.id]),
      degradedIds: [],
    });
    assert.equal(enriched.graph.semantic_mode, "provider_supported");
    assert.equal(enriched.graph.nodes[0].certainty, "provider_supported");
    assert.equal(enriched.graph.nodes[0].attributes?.architecture_semantic_status, "provider_supported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truth-attested LSP facts upgrade language quality and bind symbol relations", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-lsp-merge-"));
  try {
    await writeFile(join(root, "base.ts"), "export class Base { run() { return 1; } }\n", "utf8");
    await writeFile(join(root, "main.ts"), "import { Base } from './base';\nexport class Child extends Base { start() { return this.run(); } }\n", "utf8");
    const analyzer = new TreeSitterAnalyzer();
    await analyzer.init();
    const files = [
      await analyzer.analyzeFile(root, "base.ts"),
      await analyzer.analyzeFile(root, "main.ts"),
    ];
    const lsp: LspRunResult = {
      language: "typescript",
      completed: true,
      truthVerified: true,
      serverName: "typescript-language-server",
      serverVersion: "1.0.0",
      capabilities: ["document_symbols", "call_hierarchy", "type_hierarchy"],
      reasonCodes: [],
      symbols: [
        { path: "base.ts", name: "Base", qualifiedName: "Base", kind: "class", startLine: 1, endLine: 1, startColumn: 13, endColumn: 17 },
        { path: "base.ts", name: "run", qualifiedName: "Base.run", kind: "method", startLine: 1, endLine: 1, startColumn: 20, endColumn: 23 },
        { path: "main.ts", name: "Child", qualifiedName: "Child", kind: "class", startLine: 2, endLine: 2, startColumn: 13, endColumn: 18 },
        { path: "main.ts", name: "start", qualifiedName: "Child.start", kind: "method", startLine: 2, endLine: 2, startColumn: 34, endColumn: 39 },
      ],
      relations: [
        { kind: "calls", sourcePath: "main.ts", sourceName: "Child.start", sourceLine: 2, sourceColumn: 56, targetPath: "base.ts", targetName: "Base.run", targetLine: 1, targetColumn: 20 },
        { kind: "inherits", sourcePath: "main.ts", sourceName: "Child", sourceLine: 2, sourceColumn: 13, targetPath: "base.ts", targetName: "Base", targetLine: 1, targetColumn: 13 },
      ],
    };
    const snapshot = buildSnapshot({
      snapshotId: "snap:lsp",
      repository: "example/lsp",
      commitSha: "b".repeat(40),
      files,
      sourceRoot: root,
      lspResults: [lsp],
    });
    assert.equal(snapshot.languages[0]?.quality_tier, "verified");
    assert.ok(snapshot.fact_graph.edges.some((edge) => edge.relation_kind === "calls" && edge.certainty === "verified"));
    assert.ok(snapshot.fact_graph.edges.some((edge) => edge.relation_kind === "inherits" && edge.certainty === "verified"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
