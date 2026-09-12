import type { AnalysisProgressUpdate } from "./progress.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { generateSnapshotLanguageOverlay } from "./language-overlay-worker.js";
import { SNAPSHOT_LANGUAGE_OVERLAY_VERSION, type SnapshotLanguageOverlayPayload } from "../domain/snapshot-language.js";
import { loadProductSkill } from "../agent/skill-registry.js";
import type { WorkerDiagnostics } from "../agent/worker-diagnostics.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { ProductStore } from "../persistence/store.js";
import { createSemanticBatchRecorder } from "./coordinator.js";
import { createAnalysisExecutionBudget } from "./execution-budget.js";

function overlayFixture() {
  const source: SnapshotLanguageOverlayPayload = {
    schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION, language: "en", generated_at: "2026-09-06T00:00:00Z",
    components: [{ id: "component:a", name: "Queue", responsibility: "Runs queued jobs", grouping_rationale: "Schedules work", architecture_layer_rationale: null }],
    layers: [{ id: "layer:a", name: "Processing", responsibility: "Handles work" }],
    relations: [{ kind: "calls", label: "Calls", description: "{count} calls" }],
    value_points: [{ stable_id: "value:a", title: "Bounded concurrency", claim: "Caps active work", problem: "Limited memory", implementation: "Uses a queue", tradeoffs: "Tasks wait", transfer_conditions: "Independent work" }],
  };
  const expected = {
    components: [{ id: "component:a", name: "任务队列", responsibility: "处理排队任务", grouping_rationale: "共同调度工作", architecture_layer_rationale: "" }],
    layers: [{ id: "layer:a", name: "任务处理", responsibility: "负责处理工作" }],
    relations: [{ kind: "calls", label: "调用", description: "共 {count} 次调用" }],
    value_points: [{ stable_id: "value:a", title: "有界并发", claim: "限制同时进行的工作", problem: "内存有限", implementation: "通过队列调度", tradeoffs: "任务需要等待", transfer_conditions: "适用于独立任务" }],
  };
  return { source, expected };
}

test("the registered language Skill executes all display batches with fixed IDs and placeholders", async () => {
  const { source, expected } = overlayFixture();
  const skill = await loadProductSkill("snapshot-language-overlay");
  const faux = fauxProvider({ provider: "overlay-contract-test" });
  const models = createModels(); models.setProvider(faux.provider);
  const modes: string[] = [];
  const response: FauxResponseFactory = (context) => {
    assert.ok(context.systemPrompt?.includes(skill.skill.content));
    const message = context.messages.find((row) => row.role === "user")!;
    const text = typeof message.content === "string" ? message.content : message.content.filter((row) => row.type === "text").map((row) => row.text).join("");
    const { mode } = JSON.parse(text) as { mode: keyof typeof expected };
    modes.push(mode);
    return fauxAssistantMessage(fauxToolCall("submit_result", { mode, [mode]: expected[mode] }));
  };
  faux.setResponses([response, response, response, response]);
  const before = structuredClone(source);
  const progress: AnalysisProgressUpdate[] = [];
  const result = await generateSnapshotLanguageOverlay({ source, targetLanguage: "zh-CN", modelRuntime: { models, model: faux.getModel() as Model<Api> },
    batchContext: { jobId: "translation-progress", snapshotId: "overlay-fixture", onProgress: async update => { progress.push(update); },
      recorder: { load: async () => null, start: async () => {}, complete: async () => {}, fail: async () => {} } },
  });
  assert.deepEqual(progress.filter(event => event.status === "completed").map(event => event.kind),
    ["translating_components", "translating_layers", "translating_relations", "translating_values"]);
  assert.ok(progress.filter(event => event.status === "completed").every(event => event.completed_batches === 1 && event.total_batches === 1));
  assert.equal(result.degraded, false);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(modes, ["components", "layers", "relations", "value_points"]);
  assert.deepEqual(result.payload.components, [{ ...expected.components[0], architecture_layer_rationale: null }]);
  assert.deepEqual(result.payload.layers, expected.layers);
  assert.deepEqual(result.payload.relations, expected.relations);
  assert.deepEqual(result.payload.value_points, expected.value_points);
  assert.deepEqual(source, before);
});

test("value translation retains detail above the previous short-text limit without a rewrite", async () => {
  const { source } = overlayFixture();
  source.components = []; source.layers = []; source.relations = []; source.language = "zh-CN";
  source.value_points[0]!.implementation = "等待中的任务可以移出队列，执行中的任务需要终止线程，已经完成的外部副作用不会回滚。";
  const translated = { ...source.value_points[0]!,
    implementation: "Waiting tasks can leave the queue without destroying a worker. Running tasks require worker termination; rejecting a promise alone does not stop their handler. Already completed external effects are not rolled back, so applications need their own idempotency or compensation strategy. ".repeat(4) };
  assert.ok(translated.implementation.length > 900);
  const before = structuredClone(source);
  const faux = fauxProvider({ provider: "overlay-long-value-detail" }), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", { mode: "value_points", value_points: [translated] }))]);
  const result = await generateSnapshotLanguageOverlay({ source, targetLanguage: "en", modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(result.degraded, false); assert.equal(faux.state.callCount, 1);
  assert.deepEqual(result.payload.value_points, [translated]); assert.deepEqual(source, before);
});

function recordedOverlayFixture(provider: string) {
  const { source, expected } = overlayFixture();
  const saved = new Map<string, SemanticBatch>();
  const fence = { jobId: "translation-job", workerId: "worker", attempt: 1 };
  const job = { job_id: fence.jobId, attempt: 1, lease_expires_at: new Date().toISOString() } as AnalysisJob;
  const store = {
    listSemanticBatches: async () => [...saved.values()].map(row => structuredClone(row)),
    loadSemanticBatch: async (_job: string, batch: string) => structuredClone(saved.get(batch) ?? null),
    saveSemanticBatch: async (batch: SemanticBatch) => { saved.set(batch.batch_id, structuredClone(batch)); },
  };
  const faux = fauxProvider({ provider });
  const models = createModels(); models.setProvider(faux.provider);
  const response: FauxResponseFactory = (context) => {
    const message = context.messages.find(row => row.role === "user")!;
    const text = typeof message.content === "string" ? message.content : message.content.filter(row => row.type === "text").map(row => row.text).join("");
    const { mode } = JSON.parse(text) as { mode: keyof typeof expected };
    return fauxAssistantMessage(fauxToolCall("submit_result", { mode, [mode]: expected[mode] }));
  };
  const run = async (skill?: Awaited<ReturnType<typeof loadProductSkill>>) => {
    const budget = await createAnalysisExecutionBudget({ store, fence, signal: new AbortController().signal });
    try {
      return await generateSnapshotLanguageOverlay({ source, targetLanguage: "zh-CN", signal: budget.signal,
        batchContext: { ...createSemanticBatchRecorder(store as unknown as ProductStore, job, fence), snapshotId: "snapshot" },
        modelRuntime: { models, model: faux.getModel() as Model<Api>, beforeWorkerRequest: budget.beforeRequest,
          ...(skill ? { skills: { "snapshot-language-overlay": skill } } : {}) },
      });
    } finally { budget.dispose(); }
  };
  return { source, expected, saved, job, fence, faux, response, run };
}

test("translation resumes only unfinished batches with cumulative calls and actual attempt diagnostics", async () => {
  const f = recordedOverlayFixture("overlay-recovery-test");
  f.faux.setResponses([f.response, fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" })]);
  await assert.rejects(f.run(), /language_overlay_provider_unavailable/);
  const first = structuredClone(f.saved.get("language-components-1")!);
  assert.equal(first.status, "succeeded");
  assert.equal(f.saved.get("language-layers-2")?.status, "failed");
  assert.equal(f.saved.size, 2);
  f.job.attempt = f.fence.attempt = 2;
  f.source.generated_at = "2026-09-07T00:00:00Z";
  f.faux.setResponses([f.response, f.response, f.response]);
  const result = await f.run();
  assert.equal(result.degraded, false);
  assert.equal(f.faux.state.callCount, 5);
  assert.deepEqual(f.saved.get(first.batch_id), first, "completed batch is untouched across attempts and timestamps");
  assert.deepEqual([...f.saved.values()].map(row => row.checkpoint.execution_requests), [1, 2, 1, 1]);
  for (const batch of f.saved.values()) {
    assert.equal(batch.phase, "language_overlay");
    const diagnostics = (batch.output as { diagnostics: WorkerDiagnostics }).diagnostics;
    assert.equal(diagnostics.identity?.jobId, f.fence.jobId);
    assert.equal(diagnostics.identity?.batchId, batch.batch_id);
    assert.equal(diagnostics.identity?.jobAttempt, batch.batch_id === first.batch_id ? 1 : 2);
  }
  await f.run();
  assert.equal(f.faux.state.callCount, 5, "completed translation replays without model calls");
  f.source.layers[0]!.responsibility = "Updated source description";
  f.faux.setResponses([f.response]);
  await f.run();
  assert.equal(f.faux.state.callCount, 6, "only the changed source batch is translated again");
  const skill = await loadProductSkill("snapshot-language-overlay");
  f.faux.setResponses([f.response, f.response, f.response, f.response]);
  await f.run({ ...skill, skill: { ...skill.skill, content: skill.skill.content + "\n保持说明准确。" } });
  assert.equal(f.faux.state.callCount, 10, "changed loaded Skill body invalidates all batches even at the same version");
});

test("persistent fixed-ID, mode and placeholder errors fail translation instead of publishing partial text", async () => {
  for (const issue of ["id", "mode", "placeholder"] as const) {
    const f = recordedOverlayFixture(`overlay-structure-${issue}`);
    f.source.components = []; f.source.layers = []; f.source.value_points = [];
    const invalid = { mode: issue === "mode" ? "layers" : "relations", relations: [{ ...f.expected.relations[0],
      ...(issue === "id" ? { kind: "unknown" } : {}), ...(issue === "placeholder" ? { description: "共若干次调用" } : {}) }] };
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", invalid)), fauxAssistantMessage(fauxToolCall("submit_result", invalid))]);
    await assert.rejects(f.run(), /language_overlay_structure_failed/);
    const batch = f.saved.get("language-relations-1")!;
    assert.equal(batch.status, "failed");
    assert.equal(batch.error, "language_overlay_structure_failed");
    assert.equal(batch.checkpoint.execution_requests, 2);
    f.faux.setResponses([f.response]);
    assert.equal((await f.run()).degraded, false, "invalid output is not replayed");
    assert.equal(f.faux.state.callCount, 3);
  }
});

test("translation language-only degradation remains replayable even for layer mode", async () => {
  const f = recordedOverlayFixture("overlay-language-degrade");
  f.source.components = []; f.source.relations = []; f.source.value_points = [];
  const result = fauxAssistantMessage(fauxToolCall("submit_result", { mode: "layers", layers: f.source.layers }));
  f.faux.setResponses([result, result]);
  const generated = await f.run();
  assert.equal(generated.degraded, true);
  assert.ok(generated.errors.every(error => error.includes("目标语言")));
  assert.equal(f.saved.get("language-layers-1")?.status, "succeeded");
  assert.equal((await f.run()).degraded, true);
  assert.equal(f.faux.state.callCount, 2);
});
