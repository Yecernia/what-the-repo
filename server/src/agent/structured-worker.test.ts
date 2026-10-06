import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model, type Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime } from "./types.js";
import { semanticRunContract } from "../analysis/semantic-batch-runner.js";
import { skillMetadata } from "./skill-registry.js";
import { TextSubmissionRepair } from "./text-submission-repair.js";
import { providerFailureReason } from "./worker-failure.js";
import { workerRequestContext } from "./worker-request-context.js";
import { generateLearningRoute } from './teaching-workers.js';
import { createProject, emptyProfile } from '../domain/conversation.js';
import type { EvidenceSnapshot } from '../domain/snapshot.js';
import type { ProductStore } from '../persistence/store.js';

test("teaching and review workers stop repeated unknown tool calls at six requests", async () => {
  for (const skillId of ["learning-route", "understanding-assessment", "citation-review"] as const) {
    const faux = fauxProvider({ provider: `bounded-${skillId}` });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 21 }, () => fauxAssistantMessage(fauxToolCall("nonexistent_tool", {}))));
    const metadata = skillMetadata(skillId);
    const result = await runStructuredWorker({ skillId,
      inputSchemaId: metadata.inputSchemaId, outputSchemaId: metadata.outputSchemaId, contextBuilderId: metadata.contextBuilderId,
      schema: Type.Object({ ok: Type.Boolean() }), systemPrompt: "Submit result.", userPrompt: "Check.",
      tools: metadata.allowedTools.filter(name => name !== "submit_result").map(name => ({ name, label: name, description: name,
        parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })),
      modelRuntime: { models, model: faux.getModel() as Model<Api> },
    });
    assert.equal(result.value, null);
    assert.equal(result.stopReason, "worker_call_limit_exceeded");
    assert.equal(faux.state.callCount, 6);
  }
});

test("review worker total deadline aborts an in-flight model request", async () => {
  const faux = fauxProvider({ provider: "bounded-review-deadline" });
  const models = createModels(); models.setProvider(faux.provider);
  let aborted = false;
  faux.setResponses([async (_context, options) => {
    await new Promise<void>(resolve => {
      if (options?.signal?.aborted) { aborted = true; resolve(); return; }
      options?.signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    return fauxAssistantMessage("", { stopReason: "aborted" });
  }]);
  const metadata = skillMetadata("citation-review");
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await runStructuredWorker({ skillId: "citation-review",
      inputSchemaId: metadata.inputSchemaId, outputSchemaId: metadata.outputSchemaId, contextBuilderId: metadata.contextBuilderId,
      schema: Type.Object({ ok: Type.Boolean() }), systemPrompt: "Submit.", userPrompt: "Review.",
      modelRuntime: { models, model: faux.getModel() as Model<Api> }, taskLimits: { timeoutMs: 20 },
    });
    assert.equal(result.stopReason, "worker_time_limit_exceeded");
    assert.equal(result.value, null);
    assert.equal(aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test("worker request annotations survive copied SDK contexts and reject rewritten history", () => {
  const append = workerRequestContext();
  const original: Context = { systemPrompt: "fixed", messages: [{ role: "user", content: "task", timestamp: 1 }] };
  const first = append(original, "first allowance");
  assert.equal(original.messages[0].content, "task");
  const next: Context = { ...original, messages: [...structuredClone(original.messages),
    { role: "user", content: "repair followup", timestamp: 2 }] };
  const second = append(next, "second allowance");
  assert.deepEqual(second.messages[0], first.messages[0]);
  assert.match(JSON.stringify(second.messages[1]), /second allowance/);
  assert.equal(next.messages[1].content, "repair followup");
  const changed = structuredClone(next);
  changed.messages[0].content = "changed history";
  assert.throws(() => append(changed, "third allowance"), /worker_request_history_changed/);
  assert.throws(() => append(next, "third allowance"), /requires_new_tail/);
});

test("provider retries distinguish transient transport from credentials and unknown failures", async () => {
  for (const status of [429, 500, 502, 503, 504]) assert.equal(providerFailureReason([{ status }]), "provider_transient_error");
  for (const status of [400, 401, 403, 404]) assert.equal(providerFailureReason([{ status }], "ECONNRESET"), "provider_request_failed");
  assert.equal(providerFailureReason([{ status: null, errorCode: "ECONNRESET" }]), "provider_transient_error");
  assert.equal(providerFailureReason([], "unknown error"), "provider_request_failed");
  const { faux, options } = textRepairRuntime("transient-transport-fixture");
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "socket ECONNRESET" })]);
  const result = await runStructuredWorker(options);
  assert.equal(result.value, null);
  assert.equal(result.stopReason, "provider_transient_error:provider_connection_failed");
  assert.equal(faux.state.callCount, 1, "the job owns retry; the Agent must not independently loop");
});

const textRepairTestSchema = Type.Object({ components: Type.Array(Type.Object({
  component_id: Type.String(), responsibility: Type.String({ minLength: 2, maxLength: 12 }),
  evidence_ids: Type.Array(Type.String()),
})) });

function textRepairRuntime(provider: string) {
  const faux = fauxProvider({ provider });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, options: {
    skillId: "component-explanation" as const,
    ...semanticRunContract("component-explanation"),
    systemPrompt: "保留原结果，按工具反馈只修文本。", userPrompt: "解释组件。",
    schema: textRepairTestSchema, repairTextFields: ["responsibility"],
    tools: skillMetadata("component-explanation").allowedTools.filter((name) => !["submit_result", "repair_result_text"].includes(name))
      .map((name) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })),
    modelRuntime: { models, model: faux.getModel() as Model<Api> },
  } };
}

test("endgame annotates an appended repair user message after a response without tools", async () => {
  const { faux, options } = textRepairRuntime("endgame-user-followup-fixture");
  const requests: Context[] = [];
  faux.setResponses([
    context => { requests.push(JSON.parse(JSON.stringify(context)) as Context); return fauxAssistantMessage("I will submit."); },
    context => { requests.push(JSON.parse(JSON.stringify(context)) as Context); return fauxAssistantMessage(fauxToolCall("submit_result", { components: [] })); },
  ]);
  const result = await runStructuredWorker({ ...options, explorationEndgame: { evidenceToolName: "get_repository_evidence" } });
  assert.equal(result.stopReason, "completed");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.equal(requests[1].messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(requests[1].messages.at(-1)?.content), /还可进行 39 次/);
});

test("text repair preserves other components and evidence and accepts only the corrected fields", async () => {
  const { faux, options } = textRepairRuntime("structured-text-repair-test");
  const original = { components: [
    { component_id: "component:a", responsibility: "private-source-do-not-log-this-long-description", evidence_ids: ["e:a"] },
    { component_id: "component:b", responsibility: "完整保留的组件", evidence_ids: ["e:b", "e:c"] },
  ] };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", original)),
    fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: [{ field_id: "f1", value: "新的准确说明" }] })),
  ]);
  const result = await runStructuredWorker(options);
  assert.deepEqual(result.value, { components: [{ ...original.components[0], responsibility: "新的准确说明" }, original.components[1]] });
  assert.equal(original.components[0]!.responsibility, "private-source-do-not-log-this-long-description");
  assert.equal(result.stopReason, "completed");
  assert.equal(result.diagnostics?.requestCount, 2);
  assert.deepEqual(result.diagnostics?.textRepair, { drafts: 1, attempts: 1, appliedFields: 1, exhausted: false, remainingFields: [] });
  assert.equal(result.diagnostics?.toolDispatches?.[0]?.isError, true);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /private-source|新的准确说明|完整保留的组件/);
});

test("scope text repair identifies each object and its original text without crossing field paths", () => {
  const schema = Type.Object({ scopes: Type.Array(Type.Object({
    scope_id: Type.String(), layer_group_id: Type.String(), name: Type.String(),
    component_ids: Type.Array(Type.String()), responsibility: Type.String({ maxLength: 25 }),
  })) });
  const original = { scopes: [
    { scope_id: "docs", layer_group_id: "guidance", name: "Documentation", component_ids: ["docs", "examples"], responsibility: "Documentation and examples explain how to use the library." },
    { scope_id: "automation", layer_group_id: "engineering", name: "Repository automation", component_ids: ["root", "ci"], responsibility: "Build configuration and CI automate verification and publishing." },
  ] };
  const repair = new TextSubmissionRepair(schema, ["responsibility"]);
  assert.throws(() => repair.prepare(original), /草稿/);
  const fields = JSON.parse(repair.feedback().split("\n").at(-1)!) as Array<{
    field_id: string; scope_id: string; layer_group_id: string; name: string; component_ids: string[]; current_text: string;
  }>;
  assert.deepEqual(fields.map(({ scope_id, layer_group_id, name, component_ids, current_text }) => ({ scope_id, layer_group_id, name, component_ids, responsibility: current_text })), original.scopes);
  const result = repair.apply({ draft_id: 1, corrections: [
    { field_id: fields[1].field_id, value: "Build and publish" },
    { field_id: fields[0].field_id, value: "Explain library usage" },
  ] });
  assert.deepEqual(result.scopes, original.scopes.map((scope, index) => ({ ...scope, responsibility: index ? "Build and publish" : "Explain library usage" })));
  assert.equal(original.scopes[1]!.responsibility, "Build configuration and CI automate verification and publishing.");
});

test("text repair rejects stale drafts and unlisted fields without changing the saved result", async () => {
  const { faux, options } = textRepairRuntime("structured-stale-text-repair-test");
  const original = { components: [{ component_id: "component:a", responsibility: "this description is too long", evidence_ids: ["e:a"] }] };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", original)),
    fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 7, corrections: [{ field_id: "f1", value: "错误草稿" }] })),
    fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: [{ field_id: "/components/0/component_id", value: "被篡改" }] })),
    fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: [{ field_id: "f1", value: "正确说明" }] })),
  ]);
  const result = await runStructuredWorker(options);
  assert.deepEqual(result.value, { components: [{ ...original.components[0], responsibility: "正确说明" }] });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.diagnostics?.textRepair?.attempts, 3);
  assert.equal(result.diagnostics?.textRepair?.exhausted, false);
});

test("repair feedback counts characters using the schema's rules and diagnostics retain only lengths", () => {
  const repair = new TextSubmissionRepair(Type.Object({ description: Type.String({ minLength: 3, maxLength: 6 }) }), ["description"]);
  for (const [description, count, rule, limit] of [["英a", 2, "minLength", 3], ["English", 7, "maxLength", 6], ["e\u0301👩‍💻中文abc", 7, "maxLength", 6]] as const) {
    assert.throws(() => repair.prepare({ description }), /不是英文单词数/);
    const [field] = JSON.parse(repair.feedback().split("\n").at(-1)!);
    assert.equal(field.current_text, description);
    assert.equal(field.current_length, count);
    assert.equal(field.limit, limit);
    assert.deepEqual(repair.stats.remainingFields, [{ location: "/description", rule, limit, currentLength: count }]);
    assert.ok(!JSON.stringify(repair.stats).includes(description));
  }
  assert.deepEqual(repair.apply({ draft_id: 3, corrections: [{ field_id: "f1", value: "中文ab" }] }), { description: "中文ab" });
  assert.deepEqual(repair.stats.remainingFields, []);
});

test("text repair stops after three failed corrections instead of accepting invalid text", async () => {
  const { faux, options } = textRepairRuntime("structured-text-repair-limit-test");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { components: [{ component_id: "a", responsibility: "too long description", evidence_ids: ["e:a"] }] })),
    ...[1, 2, 3].map((draft_id) => fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id, corrections: [{ field_id: "f1", value: "still too long description" }] }))),
  ]);
  const result = await runStructuredWorker(options);
  assert.equal(result.value, null);
  assert.equal(result.stopReason, "text_repair_exhausted");
  assert.equal(result.diagnostics?.requestCount, 4);
  assert.equal(result.diagnostics?.textRepair?.exhausted, true);
  assert.deepEqual(result.diagnostics?.textRepair?.remainingFields, [{ location: "/components/0/responsibility", rule: "maxLength", limit: 12, currentLength: 26 }]);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /still too long description/);
});

test("text repair still runs business validation and does not replace normal shape validation", async () => {
  const { faux, options } = textRepairRuntime("structured-text-repair-business-test");
  const row = { component_id: "a", responsibility: "too long description", evidence_ids: ["wrong"] };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { components: [{ responsibility: "bad shape" }] })),
    fauxAssistantMessage(fauxToolCall("submit_result", { components: [row] })),
    fauxAssistantMessage(fauxToolCall("repair_result_text", { draft_id: 1, corrections: [{ field_id: "f1", value: "准确说明" }] })),
    fauxAssistantMessage(fauxToolCall("submit_result", { components: [{ ...row, responsibility: "准确说明", evidence_ids: ["e:a"] }] })),
  ]);
  const result = await runStructuredWorker({ ...options, validateSubmitted: (value) => value.components[0]?.evidence_ids[0] === "e:a" ? [] : ["evidence: wrong"] });
  assert.deepEqual(result.value?.components[0]?.evidence_ids, ["e:a"]);
  assert.equal(result.stopReason, "completed");
  assert.equal(result.diagnostics?.rejectedSubmissions, 1);
  assert.equal(result.diagnostics?.requestCount, 4);
});

test("structured worker failure returns a stable reason without provider details", async () => {
  const faux = fauxProvider({ provider: "structured-failure-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelRuntime: PiModelRuntime = {
    models,
    model: faux.getModel() as Model<Api>,
  };
  faux.setResponses([
    fauxAssistantMessage("我没有调用提交工具。"),
    fauxAssistantMessage("仍然没有调用提交工具。"),
  ]);
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v7",
    outputSchemaId: "understanding-assessment-output-v6",
    contextBuilderId: "understanding-assessment-context-v13",
    systemPrompt: "提交结果。",
    userPrompt: "生成结果。",
    schema: Type.Object({ answer: Type.String() }),
    modelRuntime,
  });
  assert.equal(result.value, null);
  assert.equal(result.stopReason, "structured_output_missing");
  assert.doesNotMatch(result.stopReason, /faux|prompt|stack|provider/i);
});

test("structured worker exposes provider request failures separately from missing tool output", async () => {
  const faux = fauxProvider({ provider: "structured-provider-error-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelRuntime: PiModelRuntime = {
    models,
    model: faux.getModel() as Model<Api>,
  };
  faux.setResponses([
    fauxAssistantMessage("Provider request failed.", { stopReason: "error", errorMessage: "network" }),
  ]);
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v7",
    outputSchemaId: "understanding-assessment-output-v6",
    contextBuilderId: "understanding-assessment-context-v13",
    systemPrompt: "提交结果。",
    userPrompt: "生成结果。",
    schema: Type.Object({ answer: Type.String() }),
    modelRuntime,
  });
  assert.equal(result.value, null);
  assert.equal(result.stopReason, "provider_request_failed");
});

test("structured worker returns validation errors to the same agent and accepts a corrected submission", async () => {
  const faux = fauxProvider({ provider: "structured-validation-retry-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelRuntime: PiModelRuntime = {
    models,
    model: faux.getModel() as Model<Api>,
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { answer: "English answer" })),
    fauxAssistantMessage(fauxToolCall("submit_result", { answer: "中文答案" })),
  ]);
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v7",
    outputSchemaId: "understanding-assessment-output-v6",
    contextBuilderId: "understanding-assessment-context-v13",
    systemPrompt: "提交结果。",
    userPrompt: "生成中文结果。",
    schema: Type.Object({ answer: Type.String() }),
    modelRuntime,
    validateSubmitted: (value) => /[\u3400-\u9fff]/.test(value.answer)
      ? null
      : "answer 没有使用简体中文",
  });
  assert.deepEqual(result.value, { answer: "中文答案" });
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.diagnostics?.submitAttempts, 2);
  assert.equal(result.diagnostics?.rejectedSubmissions, 1);
  assert.equal(result.diagnostics?.requestCount, 2);
  assert.equal(result.diagnostics?.toolDispatchCount, 2);
  assert.equal(result.diagnostics?.toolDispatchErrorCount, 0);
  assert.ok(result.diagnostics?.toolDispatches?.every((row) => row.executed));
  assert.ok((result.diagnostics?.durationMs ?? 0) > 0);
});

test("value endgame preserves request prefixes and schemas while blocking exploration execution", async () => {
  const faux = fauxProvider({ provider: "value-endgame-fixture" });
  const models = createModels(); models.setProvider(faux.provider);
  let reads = 0, confirmations = 0, allowanceIndex = 0;
  const prompts: string[] = [];
  const requests: Context[] = [];
  const capture = (context: Context) => {
    requests.push(JSON.parse(JSON.stringify(context)) as Context);
    schemas.push(context.tools?.map(tool => tool.name) ?? []);
    prompts.push(context.systemPrompt ?? "");
  };
  const tools = skillMetadata("repository-value-discovery").allowedTools
    .filter(name => !["submit_result", "repair_result_text"].includes(name))
    .map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => {
      if (name === "get_repository_evidence") confirmations++;
      else reads++;
      return { content: [{ type: "text" as const, text: "verified" }], details: {} };
    } }));
  const schemas: string[][] = [];
  faux.setResponses([
    context => { capture(context); return fauxAssistantMessage([fauxToolCall("get_repository_evidence", {}), fauxToolCall("get_repository_evidence", {})]); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall("get_repository_evidence", {})); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall("read_repository_source", {})); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "English" })); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "已核实" })); },
  ]);
  const result = await runStructuredWorker({
    skillId: "repository-value-discovery", ...semanticRunContract("repository-value-discovery"),
    systemPrompt: "基于证据提交。", userPrompt: "分析", schema: Type.Object({ answer: Type.String() }),
    repairTextFields: ["answer"], tools,
    explorationEndgame: { evidenceToolName: "get_repository_evidence" },
    modelRuntime: { models, model: faux.getModel() as Model<Api>, beforeWorkerRequest: async () => ({
      batchRemaining: 20 - allowanceIndex++, jobRemaining: [5, 4, 3, 2, 1][allowanceIndex - 1]!,
    }) },
    validateSubmitted: value => /[\u3400-\u9fff]/u.test(value.answer) ? null : "language_mismatch: use Chinese",
  });
  assert.deepEqual(result.value, { answer: "已核实" });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.diagnostics?.rejectedSubmissions, 1);
  assert.deepEqual(result.diagnostics?.requests.map(row => [row.phase, row.remaining]),
    [["converge", 5], ["submit", 4], ["submit", 3], ["submit", 2], ["submit", 1]]);
  assert.ok(schemas[0]?.includes("search_web"), "convergence keeps evidence tools available");
  for (let index = 0; index < requests.length; index++) {
    assert.deepEqual(schemas[index], schemas[0]);
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.equal(prompts[index], prompts[0]);
    assert.doesNotMatch(prompts[index], /本批次或整个任务最多还可进行/);
    assert.match(JSON.stringify(requests[index].messages.at(-1)?.content), new RegExp(`还可进行 ${5 - index} 次`));
    if (index) assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
  }
  const parallelResults = requests[1].messages.filter(message => message.role === "toolResult");
  assert.equal(parallelResults.length, 2);
  assert.doesNotMatch(JSON.stringify(parallelResults[0].content), /程序请求上下文/);
  assert.match(JSON.stringify(parallelResults[1].content), /程序请求上下文/);
  assert.match(JSON.stringify(requests[3].messages.at(-1)?.content), /当前探索工具不可用/);
  assert.equal(reads, 0, "listed exploration tools must still be rejected during submission");
  assert.equal(confirmations, 3);
});

test("value endgame uses its local 40-call limit when a legacy reservation hook returns void", async () => {
  const faux = fauxProvider({ provider: "value-endgame-void-hook" });
  const models = createModels(); models.setProvider(faux.provider);
  let reservations = 0, executions = 0;
  const tools = skillMetadata("repository-value-discovery").allowedTools
    .filter(name => !["submit_result", "repair_result_text"].includes(name))
    .map(name => ({ name, label: name, description: name, parameters: Type.Object({}),
      execute: async () => { executions++; return { content: [], details: {} }; } }));
  faux.setResponses(Array.from({ length: 41 }, () => fauxAssistantMessage(fauxToolCall("get_repository_evidence", {}))));
  const result = await runStructuredWorker({
    skillId: "repository-value-discovery", ...semanticRunContract("repository-value-discovery"),
    systemPrompt: "提交结果。", userPrompt: "分析", schema: Type.Object({ answer: Type.String() }), tools,
    explorationEndgame: { evidenceToolName: "get_repository_evidence" },
    modelRuntime: { models, model: faux.getModel() as Model<Api>, beforeWorkerRequest: async () => { reservations++; } },
  });
  assert.equal(result.value, null);
  assert.equal(result.stopReason, "analysis_batch_call_limit_exceeded");
  assert.equal(result.diagnostics?.requestCount, 40);
  assert.equal(reservations, 40);
  assert.equal(executions, 40);
  assert.equal(faux.getPendingResponseCount(), 1);
});

test('route endgame uses six actual requests, keeps schemas stable and repairs fifth submission on the sixth', async () => {
  const faux = fauxProvider({ provider: 'route-six-request-endgame' });
  const models = createModels(); models.setProvider(faux.provider);
  const evidence = { stable_id: 'e:route', label: 'entry', path: 'src/entry.ts', start_line: 1, end_line: 3, kind: 'symbol' };
  const snapshot: EvidenceSnapshot = { snapshot_id: 'snapshot:route-budget', summary: { file_count: 1, symbol_count: 1, call_count: 0, component_count: 1 },
    graph: { semantic_mode: 'provider_supported', nodes: [{ id: 'c:entry', name: 'Entry', label: 'Entry', responsibility: 'Input',
      grouping_rationale: 'Input', architecture_layer_id: 'layer:entry', architecture_layer_name: 'Entry', members: [evidence], member_count: 1,
      evidence: [evidence], certainty: 'verified', review_status: 'reviewed', fan_in: 0, fan_out: 0 }], edges: [], layers: [], unassigned_component_ids: [] },
    languages: [], value_points: [], learning_plan: { snapshot_id: 'snapshot:route-budget', selected_value_point: null, steps: [] } };
  const project = createProject('owner:route', 'https://github.com/example/route', 'route', 'free:test');
  const sourceReads: Array<[number, number]> = [];
  const store = { readSourceLines: async (_project: string, _snapshot: string, _path: string, start: number, end: number) => {
    sourceReads.push([start, end]);
    return { lines: Array.from({ length: Math.min(end, 205) - start + 1 }, (_, i) => `// source line ${start + i}`), truncated: false };
  } } as unknown as ProductStore;
  const contexts: Context[] = [];
  const capture = (context: Context) => { contexts.push(JSON.parse(JSON.stringify(context)) as Context); };
  const step = { title: 'Read the entry', objective: 'Explain the input flow', completion_check: 'Explain the input', learning_targets: ['Explain the input'],
    component_ids: ['c:entry'], evidence_ids: ['e:route'] };
  faux.setResponses([
    context => { capture(context); return fauxAssistantMessage(fauxToolCall('list_repository_components', {})); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall('get_repository_component', { component_id: 'c:entry' })); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall('get_repository_evidence', { evidence_ids: ['e:route'] })); },
    context => { capture(context); return fauxAssistantMessage(fauxToolCall('read_repository_source', { path: 'src/entry.ts', offset: 1, limit: 200 })); },
    context => { capture(context); assert.match(JSON.stringify(context.messages), /next_offset\\?":201/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { steps: [{ ...step, component_ids: ['unknown'] }] })); },
    context => { capture(context); assert.match(JSON.stringify(context.messages), /unknown component/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { steps: [step] })); },
  ]);
  const result = await generateLearningRoute({ project, snapshot, target: { kind: 'repository', stable_id: null, label: 'route' },
    request: 'Teach the entry flow', profile: emptyProfile(), store, modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(result.completed, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.trace.diagnostics?.requestCount, 6);
  assert.equal(result.trace.diagnostics?.submitAttempts, 2);
  assert.equal(result.trace.diagnostics?.rejectedSubmissions, 1);
  assert.deepEqual(result.trace.diagnostics?.requests.map(r => [r.phase, r.remaining]),
    [['explore', 6], ['explore', 5], ['converge', 4], ['converge', 3], ['submit', 2], ['submit', 1]]);
  assert.deepEqual(sourceReads, [[1, 201]], 'the five-line trailing page is not mechanically read');
  for (const context of contexts) {
    assert.deepEqual(context.tools, contexts[0]!.tools);
    assert.equal(context.systemPrompt, contexts[0]!.systemPrompt);
  }
});

test('route endgame blocks every exploration execution in the last two requests, including get evidence', async () => {
  const faux = fauxProvider({ provider: 'route-no-final-exploration' });
  const models = createModels(); models.setProvider(faux.provider);
  const metadata = skillMetadata('learning-route');
  let executed = 0;
  const tools = metadata.allowedTools.filter(name => name !== 'submit_result').map(name => ({ name, label: name, description: name,
    parameters: Type.Object({}), execute: async () => { executed++; return { content: [], details: {} }; } }));
  const checkedResponse = (response: ReturnType<typeof fauxAssistantMessage>) => (_context: Context, options?: { maxTokens?: number }) => {
    assert.equal(options?.maxTokens, 256, 'the endgame branch forwards the explicit output-token limit');
    return response;
  };
  faux.setResponses([
    ...Array.from({ length: 4 }, () => checkedResponse(fauxAssistantMessage(fauxToolCall('get_repository_evidence', {})))),
    checkedResponse(fauxAssistantMessage(tools.map(tool => fauxToolCall(tool.name, {})))),
    (context, options) => { assert.equal(options?.maxTokens, 256);
      assert.match(JSON.stringify(context.messages.at(-1)?.content), /当前探索工具不可用/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { steps: [] })); },
  ]);
  const result = await runStructuredWorker({ skillId: 'learning-route', inputSchemaId: metadata.inputSchemaId,
    outputSchemaId: metadata.outputSchemaId, contextBuilderId: metadata.contextBuilderId,
    systemPrompt: 'Form an honest route.', userPrompt: 'Learn the repository.', schema: Type.Object({ steps: Type.Array(Type.String()) }), tools,
    explorationEndgame: { submitReserve: 2, convergeReserve: 4 }, taskLimits: { maxOutputTokens: 256 },
    modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(result.value, { steps: [] }, 'insufficient verified evidence remains an honest empty result');
  assert.equal(executed, 4, 'no get/read/list/query exploration executes on request five');
  assert.equal(result.diagnostics?.requestCount, 6);
  assert.equal(result.diagnostics?.submitAttempts, 1);
});

test('bounded route allowance is the minimum of its local bound and external batch/job allowances', async () => {
  for (const limits of [{ maxRequests: 6, batch: 40, job: 100, remaining: 6 }, { maxRequests: 6, batch: 3, job: 100, remaining: 3 },
    { maxRequests: 6, batch: 40, job: 2, remaining: 2 }, { maxRequests: 2, batch: 40, job: 100, remaining: 2 }]) {
    const faux = fauxProvider({ provider: `route-allowance-${limits.remaining}-${limits.maxRequests}-${limits.batch}` });
    const models = createModels(); models.setProvider(faux.provider);
    const metadata = skillMetadata('learning-route');
    faux.setResponses([fauxAssistantMessage(fauxToolCall('submit_result', { steps: [] }))]);
    const result = await runStructuredWorker({ skillId: 'learning-route', inputSchemaId: metadata.inputSchemaId,
      outputSchemaId: metadata.outputSchemaId, contextBuilderId: metadata.contextBuilderId, systemPrompt: 'Submit.', userPrompt: 'Route.',
      tools: metadata.allowedTools.filter(name => name !== 'submit_result').map(name => ({ name, label: name, description: name,
        parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) })),
      schema: Type.Object({ steps: Type.Array(Type.String()) }), explorationEndgame: { submitReserve: 2, convergeReserve: 4 },
      taskLimits: { maxRequests: limits.maxRequests }, modelRuntime: { models, model: faux.getModel() as Model<Api>,
        beforeWorkerRequest: async () => ({ batchRemaining: limits.batch, jobRemaining: limits.job }) } });
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.diagnostics?.requests[0]?.remaining, limits.remaining);
    assert.equal(result.diagnostics?.requests[0]?.phase, limits.remaining <= 2 ? 'submit' : limits.remaining <= 4 ? 'converge' : 'explore');
  }
});

test("ordinary structured workers leave a void reservation hook in charge of its own limit", async () => {
  const { faux, options } = textRepairRuntime("ordinary-void-hook");
  let reservations = 0;
  const toolName = options.tools[0]!.name;
  faux.setResponses([
    ...Array.from({ length: 41 }, () => fauxAssistantMessage(fauxToolCall(toolName, {}))),
    fauxAssistantMessage(fauxToolCall("submit_result", { components: [] })),
  ]);
  const result = await runStructuredWorker({ ...options,
    modelRuntime: { ...options.modelRuntime, beforeWorkerRequest: async () => { reservations++; } },
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.diagnostics?.requestCount, 42);
  assert.equal(reservations, 42);
});

test("structured worker records SDK argument rejection and unknown tools without retaining content", async () => {
  const faux = fauxProvider({ provider: "structured-dispatch-retry-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { private_source: "never-log-this" })),
    fauxAssistantMessage(fauxToolCall("unknown-private-secret", {})),
    fauxAssistantMessage(fauxToolCall("submit_result", { answer: "accepted" })),
  ]);
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v7",
    outputSchemaId: "understanding-assessment-output-v6",
    contextBuilderId: "understanding-assessment-context-v13",
    systemPrompt: "提交结果。", userPrompt: "生成结果。",
    schema: Type.Object({ answer: Type.String() }),
    modelRuntime: { models, model: faux.getModel() as Model<Api> },
  });
  assert.deepEqual(result.value, { answer: "accepted" });
  assert.equal(result.diagnostics?.submitAttempts, 1);
  assert.equal(result.diagnostics?.rejectedSubmissions, 0);
  assert.equal(result.diagnostics?.toolCount, 0);
  assert.equal(result.diagnostics?.toolDispatchCount, 3);
  assert.equal(result.diagnostics?.toolDispatchErrorCount, 2);
  assert.deepEqual(result.diagnostics?.toolDispatches, [
    { sequence: 1, requestSequence: 1, name: "submit_result", executed: false, isError: true, schemaErrors: [{ keyword: "required", schemaPath: "#" }] },
    { sequence: 2, requestSequence: 2, name: "unknown_tool", executed: false, isError: true },
    { sequence: 3, requestSequence: 3, name: "submit_result", executed: true, isError: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /private_source|never-log-this|unknown-private-secret|accepted/);
});

test("structured worker retains the final evidence-backed submission after validation retries are exhausted", async () => {
  const faux = fauxProvider({ provider: "structured-validation-degraded-test" });
  const models = createModels();
  models.setProvider(faux.provider);
  const modelRuntime: PiModelRuntime = {
    models,
    model: faux.getModel() as Model<Api>,
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { answer: "First English answer" })),
    fauxAssistantMessage(fauxToolCall("submit_result", { answer: "Second English answer" })),
  ]);
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v7",
    outputSchemaId: "understanding-assessment-output-v6",
    contextBuilderId: "understanding-assessment-context-v13",
    systemPrompt: "提交结果。",
    userPrompt: "生成中文结果。",
    schema: Type.Object({ answer: Type.String() }),
    modelRuntime,
    validateSubmitted: () => "answer 没有使用简体中文",
  });
  assert.deepEqual(result.value, { answer: "Second English answer" });
  assert.equal(result.stopReason, "completed_with_validation_errors");
  assert.deepEqual(result.validationErrors, ["answer 没有使用简体中文"]);
});


function boundedReviewOptions(provider: string) {
  const faux=fauxProvider({provider});const models=createModels();models.setProvider(faux.provider);
  const metadata=skillMetadata('citation-review');
  return {faux,options:{skillId:'citation-review' as const,inputSchemaId:metadata.inputSchemaId,outputSchemaId:metadata.outputSchemaId,
    contextBuilderId:metadata.contextBuilderId,schema:Type.Object({ok:Type.Boolean()}),systemPrompt:'Submit.',userPrompt:'Review.',
    modelRuntime:{models,model:faux.getModel() as Model<Api>}}};
}

test('an explicit 360 second worker deadline permits a request beyond the default 120 seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {faux,options}=boundedReviewOptions('review-extended-deadline');
  let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve});
  let finish!:()=>void;const finished=new Promise<void>(resolve=>{finish=resolve});let aborted=false;
  faux.setResponses([async(_context,streamOptions)=>{streamOptions?.signal?.addEventListener('abort',()=>{aborted=true;finish()},{once:true});enter();await finished;
    return fauxAssistantMessage(fauxToolCall('submit_result',{ok:true}));}]);
  const resultPromise=runStructuredWorker({...options,taskLimits:{maxRequests:1,timeoutMs:360000}});
  await entered;t.mock.timers.tick(120001);assert.equal(aborted,false);finish();
  const result=await resultPromise;assert.equal(result.stopReason,'completed');assert.deepEqual(result.value,{ok:true});assert.equal(faux.state.callCount,1);
});

test('default worker deadline stays 120 seconds and explicit timeouts stay bounded to 600 seconds',async t=>{
  for(const timeoutMs of [undefined,720000])await t.test(String(timeoutMs??'default'),async t=>{
    t.mock.timers.enable({apis:['setTimeout']});const {faux,options}=boundedReviewOptions('review-deadline-'+String(timeoutMs));
    let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve});let aborted=false;
    faux.setResponses([async(_context,streamOptions)=>{enter();await new Promise<void>(resolve=>streamOptions?.signal?.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}));
      return fauxAssistantMessage('',{stopReason:'aborted'});}]);
    const pending=runStructuredWorker({...options,...timeoutMs===undefined?{}:{taskLimits:{timeoutMs}}});await entered;
    t.mock.timers.tick((timeoutMs===undefined?120000:600000)-1);assert.equal(aborted,false);
    t.mock.timers.tick(1);const result=await pending;assert.equal(aborted,true);assert.equal(result.stopReason,'worker_time_limit_exceeded');assert.equal(result.value,null);
  });
});

test('external cancellation still aborts an extended worker deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const {faux,options}=boundedReviewOptions('review-extended-cancel');
  let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve});const controller=new AbortController();
  faux.setResponses([async(_context,streamOptions)=>{enter();await new Promise<void>(resolve=>streamOptions?.signal?.addEventListener('abort',()=>resolve(),{once:true}));return fauxAssistantMessage('',{stopReason:'aborted'});}]);
  const pending=runStructuredWorker({...options,signal:controller.signal,taskLimits:{timeoutMs:360000}});await entered;controller.abort();
  const result=await pending;assert.equal(result.stopReason,'cancelled');assert.equal(result.value,null);assert.equal(faux.state.callCount,1);
});

test('length terminates after one request and never adopts even a complete-looking partial submit',async t=>{
  for(const content of ['unfinished prose',fauxToolCall('submit_result',{ok:true}),fauxToolCall('submit_result',{})])await t.test(typeof content==='string'?'prose':JSON.stringify(content.arguments),async()=>{
    const {faux,options}=boundedReviewOptions('review-length');let validated=0;
    faux.setResponses([fauxAssistantMessage(content,{stopReason:'length'}),fauxAssistantMessage(fauxToolCall('submit_result',{ok:true}))]);
    const result=await runStructuredWorker({...options,maxSubmitAttempts:1,taskLimits:{maxRequests:1},validateSubmitted:()=>{validated++;return[]}});
    assert.equal(result.stopReason,'worker_output_limit_exceeded');assert.equal(result.value,null);assert.equal(faux.state.callCount,1);
    assert.equal(result.diagnostics!.requestCount,1);assert.equal(validated,0);assert.equal(result.diagnostics!.submitAttempts,0);
  });
});
