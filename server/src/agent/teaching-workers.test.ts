import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createProject, emptyProfile } from "../domain/conversation.js";
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
  faux.setResponses([response as never]);
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
    answer: "入口接收请求后调用 core。",
    evidence: [evidence],
    project,
    snapshot: snapshot(),
    store,
    modelRuntime: selectedRuntime("understanding-assessment", runtime("assessment-valid", fauxAssistantMessage(fauxToolCall("submit_result", {
      verdict: "mastered",
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

test("learning route may return an honest empty result", async () => {
  const project = createProject("owner:route", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.snapshot_id = "snapshot:teaching-worker";
  const result = await generateLearningRoute({
    project,
    snapshot: snapshot(),
    target: { kind: "repository", stable_id: null, label: "example/repo" },
    request: "Please help me learn this repository",
    profile: emptyProfile(),
    store,
    modelRuntime: selectedRuntime("learning-route", runtime("route-empty", (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const user = context.messages.find(row => row.role === "user")!;
      const text = typeof user.content === "string" ? user.content
        : (user.content as Array<{ type: string; text: string }>).filter(row => row.type === "text").map(row => row.text).join("");
      assert.equal(JSON.parse(text).display_language, "en", "the Chinese project must not override the English request");
      return fauxAssistantMessage(fauxToolCall("submit_result", { steps: [] }));
    })),
  });
  assert.equal(result.completed, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.trace.state_candidate, false);
  assert.equal(result.trace.provider, "route-empty");
});
