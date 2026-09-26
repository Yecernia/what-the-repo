import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime } from "./types.js";
import { semanticRunContract } from "../analysis/semantic-batch-runner.js";
import { skillMetadata } from "./skill-registry.js";
import { TextSubmissionRepair } from "./text-submission-repair.js";
import { providerFailureReason } from "./worker-failure.js";

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
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v3",
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
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v3",
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
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v3",
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

test("value endgame narrows schemas, blocks old exploration calls, and permits a corrected submission", async () => {
  const faux = fauxProvider({ provider: "value-endgame-fixture" });
  const models = createModels(); models.setProvider(faux.provider);
  let reads = 0, confirmations = 0, allowanceIndex = 0;
  const prompts: string[] = [];
  const tools = skillMetadata("repository-value-discovery").allowedTools
    .filter(name => !["submit_result", "repair_result_text"].includes(name))
    .map(name => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => {
      if (name === "get_repository_evidence") confirmations++;
      else reads++;
      return { content: [{ type: "text" as const, text: "verified" }], details: {} };
    } }));
  const schemas: string[][] = [];
  faux.setResponses([
    context => { schemas.push(context.tools?.map(tool => tool.name) ?? []); prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("get_repository_evidence", {})); },
    context => { schemas.push(context.tools?.map(tool => tool.name) ?? []); prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("get_repository_evidence", {})); },
    context => { schemas.push(context.tools?.map(tool => tool.name) ?? []); prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("read_repository_source", {})); },
    context => { schemas.push(context.tools?.map(tool => tool.name) ?? []); prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "English" })); },
    context => { schemas.push(context.tools?.map(tool => tool.name) ?? []); prompts.push(context.systemPrompt ?? ""); return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "已核实" })); },
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
  for (const names of schemas.slice(1)) assert.deepEqual(names?.sort(), ["get_repository_evidence", "repair_result_text", "submit_result"].sort());
  assert.ok(prompts.every(prompt => prompt.split("本批次或整个任务最多还可进行").length === 2), "phase hints must not accumulate");
  assert.equal(reads, 0, "hidden tools must not execute even if the model calls them from history");
  assert.equal(confirmations, 2);
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
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v3",
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
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v3",
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
