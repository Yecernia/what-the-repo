import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { loadProductSkill, skillPrompt } from "../agent/skill-registry.js";
import { runStructuredWorker } from "../agent/structured-worker.js";
import { selectAnalysisExecution } from "./execution-identity.js";
import { canonicalPublicSnapshotKey } from "./identity.js";
import { semanticBatchInputIdentity } from "./semantic-batch-runner.js";

test("effective Skill content, model and search configuration invalidate public and batch caches; credentials do not", async () => {
  const faux = fauxProvider({ provider: "execution-identity-test" });
  const models = createModels(); models.setProvider(faux.provider);
  const runtime = { model: faux.getModel() as Model<Api>, models, apiKey: "secret-a" };
  const original = await selectAnalysisExecution(runtime, true);
  const changedKey = await selectAnalysisExecution({ ...runtime, apiKey: "secret-b" }, true);
  assert.equal(changedKey.digest, original.digest);
  const changedModel = await selectAnalysisExecution({ ...runtime, model: { ...runtime.model, maxTokens: runtime.model.maxTokens + 1 } }, true);
  const changedSearch = await selectAnalysisExecution(runtime, false);
  const skill = await loadProductSkill("component-explanation");
  const sameVersionNewText = { ...skill, skill: { ...skill.skill, content: skill.skill.content + "\nnew reviewed rule" } };
  const changedSkill = await selectAnalysisExecution({ ...runtime, skills: { "component-explanation": sameVersionNewText } }, true);
  for (const next of [changedModel, changedSearch, changedSkill]) {
    assert.notEqual(next.digest, original.digest);
    assert.notEqual(canonicalPublicSnapshotKey("example/project", "commit", undefined, next.digest), canonicalPublicSnapshotKey("example/project", "commit", undefined, original.digest));
  }
  assert.notDeepEqual(semanticBatchInputIdentity({}, original.runtime!, "component-explanation"), semanticBatchInputIdentity({}, changedSkill.runtime!, "component-explanation"));
  assert.doesNotMatch(JSON.stringify(semanticBatchInputIdentity({}, original.runtime!, "component-explanation")), /secret-a|new reviewed rule/);
});

test("selected Skill is shared by prompt sizing and the actual Worker instead of being hot-loaded again", async () => {
  const skill = await loadProductSkill("understanding-assessment");
  const selected = { ...skill, version: "selected-revision", skill: { ...skill.skill, content: "Selected approved instructions for this test." } };
  const faux = fauxProvider({ provider: "selected-skill-test" });
  const models = createModels(); models.setProvider(faux.provider);
  const prompt = await skillPrompt(selected.id, "Task instructions", selected);
  assert.match(prompt.prompt, /Selected approved instructions/);
  faux.setResponses([(context) => {
    assert.match(context.systemPrompt ?? "", /Selected approved instructions/);
    return fauxAssistantMessage(fauxToolCall("submit_result", { answer: "done" }));
  }]);
  const result = await runStructuredWorker({ skillId: selected.id, inputSchemaId: selected.inputSchemaId,
    outputSchemaId: selected.outputSchemaId, contextBuilderId: selected.contextBuilderId,
    modelRuntime: { models, model: faux.getModel() as Model<Api>, skills: { [selected.id]: selected } },
    schema: Type.Object({ answer: Type.String() }), systemPrompt: "Task instructions", userPrompt: "Test" });
  assert.equal(result.skillVersion, "selected-revision");
  assert.equal(result.stopReason, "completed");
});
