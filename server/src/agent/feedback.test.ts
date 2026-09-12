import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createMessage, createProject } from "../domain/conversation.js";
import { FileStore } from "../persistence/file-store.js";
import type { PiModelRuntime } from "./types.js";
import { FeedbackAnalysisWorker } from "./feedback.js";
import { FEEDBACK_TARGET_SKILL_IDS } from "./skill-registry.js";

test("natural-language feedback is linked to the previous answer without inventing a button vote", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-worker-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const project = createProject(
      "owner-feedback",
      "https://github.com/example/feedback",
      "反馈",
      "free:deepseek-v4-flash",
    );
    const user = createMessage("user", "这个回答不对，和我的问题无关。");
    const assistant = createMessage("assistant", "这里是上一条回答。");
    project.messages.push(assistant, user);
    await store.saveProject(project);

    const faux = fauxProvider({ provider: "feedback-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", {
      is_feedback: true,
      sentiment: "negative",
      strengths: [],
      issues: ["回答没有回应用户问题"],
      skill_hypotheses: ["primary-conversational-supervisor"],
      confidence: 0.9,
    }))]);

    const enqueued: string[] = [];
    await new FeedbackAnalysisWorker(store, async (requestId) => { enqueued.push(requestId); }).schedule({
      ownerId: project.owner_id,
      projectId: project.project_id,
      userMessageId: user.message_id,
      hint: {
        sentiment: "negative",
        reason: "用户明确评价上一条回答",
        confidence: 0.95,
      },
      modelRuntime,
    });
    const saved = await store.loadProject(project.project_id, project.owner_id);
    const feedback = saved?.messages.find((message) => message.message_id === assistant.message_id)?.feedback;
    assert.equal(feedback?.vote, null);
    assert.equal(feedback?.signal?.source, "language");
    assert.equal(feedback?.signal?.issues[0], "回答没有回应用户问题");
    const requests = await store.listEvolutionFeedbackRequests("pending");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.sample_count, 1);
    assert.deepEqual(requests[0]?.skill_ids, ["primary-conversational-supervisor"]);
    assert.deepEqual(enqueued, [requests[0]?.request_id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence quality gate blocks an otherwise valid evolution request", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-quality-gate-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const project = createProject(
      "owner-feedback-quality-gate",
      "https://github.com/example/feedback-quality-gate",
      "反馈质量门",
      "free:deepseek-v4-flash",
    );
    const assistant = createMessage("assistant", "上一条回答", { trace_id: "trace-quality-blocked" });
    const user = createMessage("user", "这条回答没有解决问题");
    project.messages.push(assistant, user);
    await store.saveProject(project);
    await store.saveTrace("trace-quality-blocked", {
      trace_id: "trace-quality-blocked",
      event_type: "conversation_run",
      project_id: project.project_id,
      evidence_quality: {
        evolution_eligible: false,
        quality_gate_reasons: ["citation_correctness_below_threshold"],
      },
    });

    const faux = fauxProvider({ provider: "feedback-quality-gate-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", {
      is_feedback: true,
      sentiment: "negative",
      strengths: [],
      issues: ["回答没有回应用户问题"],
      skill_hypotheses: ["primary-conversational-supervisor"],
      confidence: 0.9,
    }))]);

    const enqueued: string[] = [];
    await new FeedbackAnalysisWorker(store, async (requestId) => { enqueued.push(requestId); }).schedule({
      ownerId: project.owner_id,
      projectId: project.project_id,
      userMessageId: user.message_id,
      hint: {
        sentiment: "negative",
        reason: "用户明确评价上一条回答",
        confidence: 0.95,
      },
      modelRuntime,
    });

    assert.equal((await store.listEvolutionFeedbackRequests("pending")).length, 0);
    assert.deepEqual(enqueued, []);
    const feedbackTraces = (await store.listTraces(project.project_id))
      .filter((trace) => trace.event_type === "feedback_signal");
    assert.equal(feedbackTraces.length, 1);
    assert.deepEqual(feedbackTraces[0]?.evolution_task_request, {
      status: "quality_gate_blocked",
      reasons: ["citation_correctness_below_threshold"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary language without a Primary hint does not start the feedback worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-neutral-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const project = createProject(
      "owner-feedback-neutral",
      "https://github.com/example/feedback-neutral",
      "反馈语义",
      "free:deepseek-v4-flash",
    );
    const assistant = createMessage("assistant", "上一条回答");
    const user = createMessage("user", "我们继续看下一个组件");
    project.messages.push(assistant, user);
    await store.saveProject(project);
    await new FeedbackAnalysisWorker(store).schedule({
      ownerId: project.owner_id,
      projectId: project.project_id,
      userMessageId: user.message_id,
      modelRuntime: undefined,
    });
    const saved = await store.loadProject(project.project_id, project.owner_id);
    assert.equal(saved?.messages.find((message) => message.message_id === assistant.message_id)?.feedback, null);
    assert.equal((await store.listEvolutionFeedbackRequests()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed or ironic language is left to the feedback model instead of a phrase gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-feedback-irony-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const project = createProject(
      "owner-feedback-irony",
      "https://github.com/example/feedback-irony",
      "反讽反馈",
      "free:deepseek-v4-flash",
    );
    const assistant = createMessage("assistant", "我解释了另一个模块，没有回答你问的入口。 ");
    const user = createMessage("user", "你讲得可真完整，唯独没回答我问的那个点。 ");
    project.messages.push(assistant, user);
    await store.saveProject(project);

    const faux = fauxProvider({ provider: "feedback-irony-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_result", {
      is_feedback: true,
      sentiment: "negative",
      strengths: [],
      issues: ["回答避开了用户实际问题"],
      skill_hypotheses: ["primary-conversational-supervisor"],
      confidence: 0.86,
    }))]);

    await new FeedbackAnalysisWorker(store).schedule({
      ownerId: project.owner_id,
      projectId: project.project_id,
      userMessageId: user.message_id,
      hint: {
        sentiment: "negative",
        reason: "这句话可能在评价上一条回答",
        confidence: 0.8,
      },
      modelRuntime,
    });
    const saved = await store.loadProject(project.project_id, project.owner_id);
    const signal = saved?.messages.find((message) => message.message_id === assistant.message_id)?.feedback?.signal;
    assert.equal(signal?.source, "language");
    assert.equal(signal?.sentiment, "negative");
    assert.equal((await store.listEvolutionFeedbackRequests("pending")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("answer feedback cannot target feedback or evolution method Skills", () => {
  assert.equal(FEEDBACK_TARGET_SKILL_IDS.includes("feedback-analysis" as never), false);
  assert.equal(FEEDBACK_TARGET_SKILL_IDS.includes("skill-creator" as never), false);
  assert.equal(FEEDBACK_TARGET_SKILL_IDS.includes("skill-evolution" as never), false);
  assert.equal(FEEDBACK_TARGET_SKILL_IDS.includes("primary-conversational-supervisor"), true);
});
