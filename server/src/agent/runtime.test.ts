import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PiConversationRuntime } from "./runtime.js";
import { PiSessionStore, PiSessionWaitTimeoutError } from "./session-store.js";
import type { AgentMessage, PiAgentRunOptions, PiModelRuntime, PiSessionIdentity } from "./types.js";
import { messageThinkingSummary } from "../services/conversation-service.js";

const identity: PiSessionIdentity = {
  sessionId: "runtime-session-test",
  ownerId: "owner-test",
  projectId: "project-test",
  snapshotId: "snapshot-test",
  skillId: "primary-supervisor",
  skillVersion: "test",
};

test('final review commits only approved history and completion follows persistence even when the observer disconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'what-the-repo-final-review-history-'));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: 'final-review-history' });
    const models = createModels(); models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    faux.setResponses([fauxAssistantMessage('Valid assessment. UNSUPPORTED SUPPLEMENT')]);
    let committed = false;
    let completedEvents = 0;
    const input = options(modelRuntime, 'My answer and follow-up');
    input.onEvent = event => {
      if (event.type === 'run_completed') {
        assert.equal(committed, true);
        completedEvents++;
        throw new Error('observer disconnected after commit');
      }
    };
    const result = await runtime.run(input, async result => {
      assert.equal(completedEvents, 0);
      committed = true;
      return { value: 'saved', sessionCommit: 'accepted', assistantText: 'Valid assessment.',
        trustedMessages: [
          { role: 'user', content: input.userMessage, timestamp: Date.now() },
          { ...fauxAssistantMessage('Valid assessment.'), role: 'assistant' } as AgentMessage,
        ] };
    });
    assert.equal(result, 'saved');
    assert.equal(completedEvents, 1);
    const stored = await sessions.snapshot(identity);
    assert.equal(JSON.stringify(stored.messages).includes('UNSUPPORTED SUPPLEMENT'), false);
    assert.ok(JSON.stringify(stored.messages).includes('Valid assessment.'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("");
  }
  if (message.role === "assistant") {
    return message.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("");
  }
  return "";
}

function options(
  modelRuntime: PiModelRuntime,
  userMessage: string,
  signal?: AbortSignal,
  tools: AgentTool[] = [],
): PiAgentRunOptions {
  return {
    identity,
    systemPrompt: "自然回答用户；本测试不调用工具。",
    userMessage,
    modelRuntime,
    thinkingLevel: "off",
    tools,
    runId: "run-" + userMessage,
    signal,
  };
}

test('reply submission repairs an omitted contract without streaming an unregistered draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-reply-repair-'));
  try {
    const runtime = new PiConversationRuntime(new PiSessionStore(root));
    const faux = fauxProvider({ provider: 'reply-repair' });
    const models = createModels(); models.setProvider(faux.provider);
    let submitted: string | null = null;
    const submit: AgentTool = { name: 'submit_conversation_reply', label: '核对回答', description: '', parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => { submitted = (params as { text: string }).text; return { content: [{ type: 'text', text: 'Accepted.' }], details: {} }; } };
    faux.setResponses([
      fauxAssistantMessage('检查题已提供，确认卡也已提供。'),
      context => {
        assert.ok(JSON.stringify(context.messages).includes('用户已经给出的答案'));
        return fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { text: '已核对并提交的回答。' }));
      },
    ]);
    const result = await runtime.run({ ...options({ models, model: faux.getModel() as Model<Api> }, '用户已经给出的答案', undefined, [submit]),
      replyContract: { read: () => submitted, correction: 'Submit the reply contract for the original user message.' } });
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.text, submitted);
    assert.equal(faux.state.callCount, 2);
    assert.equal(result.events.some(event => event.type === 'assistant_delta'), false);
    assert.equal(result.events.some(event => JSON.stringify(event.display).includes('检查题已提供')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('omitted and rejected reply contracts have bounded repairs and never become completed answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-reply-rejected-'));
  try {
    const runtime = new PiConversationRuntime(new PiSessionStore(root));
    const faux = fauxProvider({ provider: 'reply-rejected' });
    const models = createModels(); models.setProvider(faux.provider);
    const submit: AgentTool = { name: 'submit_conversation_reply', label: '核对回答', description: '', parameters: Type.Object({ text: Type.String() }),
      execute: async () => { throw new Error('Registration failed.'); } };
    for (const response of [fauxAssistantMessage('只有承诺，没有提交。'), fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { text: '无效检查题' }))]) {
      const callsBefore = faux.state.callCount;
      faux.setResponses([response, response, response]);
      const result = await runtime.run({ ...options({ models, model: faux.getModel() as Model<Api> }, '开始当前步骤', undefined, [submit]),
        replyContract: { read: () => null, correction: 'Submit the reply contract.' } });
      assert.equal(result.stopReason, 'conversation_reply_invalid');
      assert.equal(result.text, '');
      assert.equal(faux.state.callCount - callsBefore, 3);
      assert.equal(result.events.some(event => event.type === 'assistant_delta'), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('schema-rejected submissions record fields without the SDK received-arguments dump', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-reply-schema-'));
  try {
    const runtime = new PiConversationRuntime(new PiSessionStore(root));
    const faux = fauxProvider({ provider: 'reply-schema' });
    const models = createModels(); models.setProvider(faux.provider);
    const rejected: string[][] = [];
    const submit: AgentTool = { name: 'submit_conversation_reply', label: '核对回答', description: '',
      parameters: Type.Object({ text: Type.String() }),
      execute: async () => { assert.fail('invalid schema must not reach execution'); } };
    const response = fauxAssistantMessage(fauxToolCall('submit_conversation_reply', { text: { secret: 'PRIVATE-MARKER' } }));
    faux.setResponses([response, response, response]);
    const result = await runtime.run({ ...options({ models, model: faux.getModel() as Model<Api> }, 'schema failure', undefined, [submit]),
      replyContract: { read: () => null, correction: 'Submit a valid reply.', onSchemaRejection: fields => rejected.push(fields) } });
    assert.equal(result.stopReason, 'conversation_reply_invalid');
    assert.equal(rejected.length, 3);
    assert.match(JSON.stringify(rejected), /text/);
    assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE-MARKER|Received arguments/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a shared submission budget stops a same-batch fourth schema refusal and every trailing worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-reply-batch-budget-'));
  try {
    const runtime = new PiConversationRuntime(new PiSessionStore(root));
    const faux = fauxProvider({ provider: 'reply-batch-budget' });
    const models = createModels(); models.setProvider(faux.provider);
    const budget = { used: 0 };
    const rejected: string[][] = [];
    let workerCalls = 0;
    const submit: AgentTool = { name: 'submit_conversation_reply', label: '核对回答', description: '',
      parameters: Type.Object({ text: Type.String() }),
      execute: async () => { assert.fail('invalid schema must not reach execution or review'); } };
    const assess: AgentTool = { name: 'assess_understanding', label: '评估理解', description: '',
      parameters: Type.Object({}), execute: async () => {
        workerCalls++;
        return { content: [{ type: 'text', text: 'worker must not run' }], details: {} };
      } };
    const marker = 'PRIVATE_FOURTH_SCHEMA_ARGUMENT';
    faux.setResponses([fauxAssistantMessage([
      ...[1, 2, 3, 4].map(index => fauxToolCall('submit_conversation_reply', {
        text: { secret: index === 4 ? marker : 'PRIVATE_SCHEMA_ARGUMENT_' + index },
      }, { id: 'invalid-submit-' + index })),
      fauxToolCall('assess_understanding', {}, { id: 'trailing-worker' }),
    ])]);
    const result = await runtime.run({ ...options({ models, model: faux.getModel() as Model<Api> }, 'bounded batch', undefined, [submit, assess]),
      replyContract: { read: () => null, correction: 'Submit a valid reply.', budget,
        onSchemaRejection: fields => rejected.push(fields) } });
    assert.equal(result.stopReason, 'conversation_reply_invalid');
    assert.equal(result.text, '');
    assert.equal(budget.used, 3, 'SDK validation and execution share a capped turn-wide allowance');
    assert.equal(rejected.length, 3, 'the fourth malformed call is not recorded as a fourth attempt');
    assert.equal(workerCalls, 0, 'no assessment or review can run after the third refusal in the same batch');
    assert.equal(faux.state.callCount, 1, 'exhaustion cannot initiate another model request');
    const safeDiagnostics = JSON.stringify({ rejected, events: result.events });
    assert.doesNotMatch(safeDiagnostics, /PRIVATE_SCHEMA_ARGUMENT_|PRIVATE_FOURTH_SCHEMA_ARGUMENT|Received arguments|4\/3/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi can answer ordinary chat directly without forcing a tool call", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-direct-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-direct-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    let toolCalls = 0;
    const tool: AgentTool = {
      name: "optional_repository_lookup",
      label: "查询项目",
      description: "仅在确实需要仓库事实时调用。",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        toolCalls += 1;
        return { content: [{ type: "text", text: "不应调用" }], details: {} };
      },
    };
    faux.setResponses([fauxAssistantMessage("当然可以，我们先随便聊聊。")]);
    const result = await runtime.run(
      options(modelRuntime, "今天先不聊项目", undefined, [tool]),
      async (value) => ({ value, sessionCommit: "accepted" }),
    );
    assert.equal(result.text, "当然可以，我们先随便聊聊。");
    assert.equal(toolCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime turns provider thinking into safe display summaries without exposing hidden text", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-display-events-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-display-events-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    faux.setResponses([fauxAssistantMessage([
      { ...fauxThinking("DO NOT SHOW THIS INTERNAL REASONING"), thinkingSignature: "signed-reasoning" },
      { ...fauxText("可展示的回答"), textSignature: "signed-text" },
    ])]);

    const result = await runtime.run(options(modelRuntime, "展示事件测试"), async (value) => ({
      value, sessionCommit: "accepted", assistantText: value.text,
    }));
    const serialized = JSON.stringify(result.events);
    assert.equal(serialized.includes("DO NOT SHOW THIS INTERNAL REASONING"), false);
    assert.ok(result.events.some((event) => event.type === "thinking_started"));
    assert.ok(result.events.some((event) => event.type === "thinking_completed"));
    assert.ok(result.events.some((event) => event.type === "answer_started"));
    assert.ok(result.events.some((event) => event.type === "assistant_delta" && event.display?.visible === false));
    for (const event of result.events.filter((item) => item.display?.visible)) {
      assert.ok(event.display);
      assert.ok(["summary", "commentary", "tool", "answer"].includes(event.display!.kind));
      assert.ok(event.display!.stage.length > 0);
      assert.ok(event.display!.label.length > 0);
      assert.ok(["running", "completed", "failed", "cancelled", "paused"].includes(event.display!.status));
    }
    const persisted = await new PiSessionStore(root).snapshot(identity);
    const persistedText = JSON.stringify(persisted.messages);
    assert.equal(persistedText.includes("DO NOT SHOW THIS INTERNAL REASONING"), true);
    assert.equal(persistedText.includes("signed-reasoning"), true);
    assert.equal(persistedText.includes("signed-text"), true);
    assert.equal(persisted.messages.length, 2);
    assert.equal(persisted.messages.some((message) => (
      message.role === "assistant"
      && message.content.some((block) => block.type === "thinking")
    )), true);
    const summary = messageThinkingSummary(result.events);
    assert.ok(summary.length > 0);
    assert.ok(summary.every((event) => event.kind === "summary"));
    assert.equal(JSON.stringify(summary).includes("DO NOT SHOW THIS INTERNAL REASONING"), false);
    assert.equal(summary.some((event) => event.label === "正在生成回答"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi classifies provider commentary text without mixing it into the final answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-commentary-events-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-commentary-events-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    faux.setResponses([fauxAssistantMessage([
      {
        type: "text",
        text: "我先检查入口和调用链。",
        textSignature: JSON.stringify({ v: 1, id: "commentary-1", phase: "commentary" }),
      },
      {
        type: "text",
        text: "最终结论。",
        textSignature: JSON.stringify({ v: 1, id: "answer-1", phase: "final_answer" }),
      },
    ])]);

    const result = await runtime.run(options(modelRuntime, "说明阶段"));
    assert.equal(result.text, "最终结论。");
    const commentary = result.events.find((event) => event.type === "assistant_commentary");
    assert.ok(commentary);
    assert.equal(commentary?.display?.kind, "commentary");
    assert.equal(commentary?.display?.text, "我先检查入口和调用链。");
    assert.equal(commentary?.display?.visible, true);
    assert.equal(JSON.stringify(result.events).includes("commentary-1"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime preserves the visible answer and citation notice when the user changes topic", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-transaction-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-transaction-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    let visibleToSecondRun: string[] = [];
    const visibleAnswer = "这是一条没有通过引用校验的仓库回答。\n\n> 引用未核实：相关说明需要核对。";
    faux.setResponses([
      fauxAssistantMessage("这是一条没有通过引用校验的仓库回答。"),
      (context) => {
        visibleToSecondRun = context.messages.map((message) => {
          if (message.role === "user") {
            return typeof message.content === "string"
              ? message.content
              : message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
          }
          if (message.role === "assistant") {
            return message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
          }
          return "";
        });
        return fauxAssistantMessage("第二轮正常回答。");
      },
    ]);

    await runtime.run(options(modelRuntime, "第一轮问题"), async (result) => ({
      value: result,
      sessionCommit: "accepted",
      assistantText: visibleAnswer,
    }));
    const afterRejected = await sessions.snapshot(identity);
    assert.equal(messageText(afterRejected.messages[1]!), "这是一条没有通过引用校验的仓库回答。");
    assert.ok(messageText(afterRejected.messages[2]!).endsWith(visibleAnswer));
    const displayRecord = messageText(afterRejected.messages[2]!);

    await runtime.run(options(modelRuntime, "你好"), async (result) => ({
      value: result,
      sessionCommit: "accepted",
    }));
    assert.deepEqual(visibleToSecondRun, ["第一轮问题", "这是一条没有通过引用校验的仓库回答。", displayRecord, "你好"]);

    const committed = await sessions.snapshot(identity);
    assert.deepEqual(committed.messages.map(messageText), [
      "第一轮问题",
      "这是一条没有通过引用校验的仓库回答。",
      displayRecord,
      "你好",
      "第二轮正常回答。",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime does not contact the provider when already cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-cancelled-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-cancelled-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = {
      models,
      model: faux.getModel() as Model<Api>,
    };
    faux.setResponses([fauxAssistantMessage("不应生成")]);
    const controller = new AbortController();
    controller.abort();

    const result = await runtime.run(
      options(modelRuntime, "已取消的问题", controller.signal),
      async (value) => ({ value, sessionCommit: "discard" }),
    );
    assert.equal(result.stopReason, "cancelled");
    assert.equal(faux.state.callCount, 0);
    assert.deepEqual((await sessions.snapshot(identity)).messages, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime cancellation interrupts a run waiting for the same Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-session-wait-cancel-"));
  let releaseHolder = (): void => undefined;
  let holder: Promise<void> | undefined;
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions, 5_000);
    const faux = fauxProvider({ provider: "runtime-session-wait-cancel-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    faux.setResponses([fauxAssistantMessage("不应生成")]);

    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    const holderBlock = new Promise<void>((resolve) => { releaseHolder = resolve; });
    holder = sessions.withSession(identity, async () => {
      holderEntered();
      await holderBlock;
    });
    await holderReady;

    const runId = "run-session-wait-cancel-test";
    runtime.prepareRun(runId);
    const runOptions = options(modelRuntime, "等待 Session 时取消");
    runOptions.runId = runId;
    const pending = runtime.run(runOptions);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.cancel(runId), true);

    const result = await pending;
    assert.equal(result.stopReason, "cancelled");
    assert.equal(faux.state.callCount, 0);
    releaseHolder();
    await holder;
  } finally {
    releaseHolder();
    await holder?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime bounds only Session lock waiting, not the active holder", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-session-wait-timeout-"));
  let releaseHolder = (): void => undefined;
  let holder: Promise<void> | undefined;
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions, 30);
    const faux = fauxProvider({ provider: "runtime-session-wait-timeout-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    faux.setResponses([fauxAssistantMessage("不应生成")]);

    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    const holderBlock = new Promise<void>((resolve) => { releaseHolder = resolve; });
    holder = sessions.withSession(identity, async () => {
      holderEntered();
      await holderBlock;
    });
    await holderReady;

    await assert.rejects(
      runtime.run(options(modelRuntime, "等待 Session 超时")),
      PiSessionWaitTimeoutError,
    );
    assert.equal(faux.state.callCount, 0);
    releaseHolder();
    await holder;
  } finally {
    releaseHolder();
    await holder?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi receives thrown tool failures as isError messages and can recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-tool-error-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-tool-error-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    let sawError = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { query: "missing" })),
      (context) => {
        const result = context.messages.find((message) => message.role === "toolResult") as
          | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
          | undefined;
        sawError = result?.isError === true
          && Boolean(result.content?.some((item) => item.text?.includes("请先查询组件")));
        return fauxAssistantMessage("我会先换一种查询方式。");
      },
    ]);
    const tool: AgentTool = {
      name: "lookup",
      label: "查询",
      description: "查询测试数据",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => { throw new Error("请先查询组件，再读取源码。"); },
    };

    const result = await runtime.run(options(modelRuntime, "查一下", undefined, [tool]));
    assert.equal(result.stopReason, "completed");
    assert.equal(result.text, "我会先换一种查询方式。");
    assert.equal(sawError, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi runtime pauses after the current tool turn without starting another model turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-pause-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-pause-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    const runId = "run-pause-test";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "pause-call" })),
      fauxAssistantMessage("不应进入第二轮模型调用。"),
    ]);
    const tool: AgentTool = {
      name: "lookup",
      label: "查询",
      description: "查询测试数据",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "完成" }], details: {} }),
    };
    const runOptions = options(modelRuntime, "暂停测试", undefined, [tool]);
    runOptions.runId = runId;
    runOptions.onEvent = (event) => {
      if (event.type === "tool_call_requested") assert.equal(runtime.pause(runId), true);
    };

    const result = await runtime.run(runOptions, async (value) => ({
      value, sessionCommit: "accepted", assistantText: "Paused after collecting evidence.",
    }));
    assert.equal(result.stopReason, "paused");
    assert.equal(faux.state.callCount, 1);
    assert.ok(result.events.some((event) => event.type === "run_paused"));
    const saved = (await new PiSessionStore(root).snapshot(identity)).messages;
    assert.equal(saved[1]?.role, "assistant");
    assert.ok(saved[1]?.role === "assistant" && saved[1].content.some((block) => block.type === "toolCall" && block.id === "pause-call"));
    assert.equal(saved[2]?.role, "toolResult");
    assert.equal(saved[3]?.role, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi executes independent read-only tools in parallel", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-parallel-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-parallel-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    let active = 0;
    let maxActive = 0;
    const execute = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { content: [{ type: "text" as const, text: "完成" }], details: {} };
    };
    const tools: AgentTool[] = ["overview", "profile"].map((name) => ({
      name,
      label: name,
      description: "独立只读查询",
      parameters: Type.Object({}),
      execute,
    }));
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("overview", {}, { id: "parallel-overview" }),
        fauxToolCall("profile", {}, { id: "parallel-profile" }),
      ]),
      fauxAssistantMessage("两个查询都完成了。"),
    ]);

    const result = await runtime.run(options(modelRuntime, "并行查询", undefined, tools));
    assert.equal(result.stopReason, "completed");
    assert.equal(maxActive, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pause requested before provider startup is honored", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-runtime-prepared-pause-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "runtime-prepared-pause-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    const runId = "run-prepared-pause-test";
    faux.setResponses([fauxAssistantMessage("当前普通回答在这一轮结束后暂停。")]);
    runtime.prepareRun(runId);
    assert.equal(runtime.pause(runId), true);
    const runOptions = options(modelRuntime, "准备期暂停");
    runOptions.runId = runId;

    const result = await runtime.run(runOptions);
    assert.equal(result.stopReason, "paused");
    assert.equal(result.text, "当前普通回答在这一轮结束后暂停。");
    assert.equal(faux.state.callCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('BYOK echoed by a provider never reaches console diagnostics, events or saved Pi sessions', async (t) => {
  const { readFile, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'wtr-byok-runtime-'));
  const key = 'never-persist-sentinel-BYOK-714';
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: 'byok-security-test' });
    const models = createModels(); models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api>, apiKey: key };
    faux.setResponses([fauxAssistantMessage('upstream echoed ' + key + ' safely')]);
    const result = await runtime.run(options(modelRuntime, 'ordinary-request'));
    assert.equal(result.text.includes(key), false);
    assert.ok(result.text.includes('[redacted]'));
    assert.equal(JSON.stringify(result).includes(key), false);
    faux.setResponses([{ ...fauxAssistantMessage(''), stopReason: 'error', errorMessage: '401 invalid key ' + key }]);
    const failed = await runtime.run(options(modelRuntime, 'ordinary-error'));
    assert.equal(failed.stopReason, 'provider_authentication_failed');
    assert.equal(JSON.stringify(logs).includes(key), false);
    const scan = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await scan(file);
        else assert.equal((await readFile(file)).includes(Buffer.from(key)), false, 'session must not contain the credential');
      }
    };
    await scan(root);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [reason,expected] of [
  [new Error('run_cancelled'),'cancelled'],
  [new Error('conversation_stream_disconnected'),'client_network_error'],
  [new Error('runtime_lease_lost'),'runtime_lease_lost'],
  [new Error('timeout exceeded when trying to connect'),'database_pool_timeout'],
  [new Error('untrusted internal failure with secret-sentinel'),'server_error'],
] as const) test(`run abort classification preserves ${expected}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-runtime-abort-'));
  try {
    const runtime=new PiConversationRuntime(new PiSessionStore(root));
    const faux=fauxProvider({provider:'abort-classifier'}), models=createModels();models.setProvider(faux.provider);
    const signal=new AbortController();signal.abort(reason);
    const result=await runtime.run(options({models,model:faux.getModel() as Model<Api>},'abort',signal.signal));
    assert.equal(result.stopReason,expected);
    assert.equal(result.events.some(event=>event.type==='run_cancelled'),expected==='cancelled');
    assert.equal(result.events.at(-1)?.errorCode,expected);
    assert.equal(JSON.stringify(result.events).includes('secret-sentinel'),false);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a backend lease abort reaches an active Agent and cannot finalize a successful answer',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-active-session-loss-'));
  try {
    const sessions=new PiSessionStore(root), runtime=new PiConversationRuntime(sessions);
    const lease=new AbortController(), caller=new AbortController();
    const original=sessions.withSession.bind(sessions);
    const withLease: PiSessionStore['withSession'] = (identity,task,opts)=>original(identity,ctx=>task({...ctx,signal:lease.signal}),opts);
    t.mock.method(sessions,'withSession',withLease);
    const faux=fauxProvider({provider:'active-session-loss'}),models=createModels();models.setProvider(faux.provider);
    faux.setResponses([()=>{lease.abort(new Error('runtime_lease_lost'));return fauxAssistantMessage('must not commit');}]);
    let finalized=0;const events:unknown[]=[];
    await assert.rejects(runtime.run({...options({models,model:faux.getModel() as Model<Api>},'test',caller.signal),onEvent:event=>events.push(event)},async result=>{
      finalized++;return {value:result,sessionCommit:'accepted'};
    }),{code:'runtime_lease_lost'});
    assert.equal(caller.signal.aborted,false);assert.equal(finalized,0);
    assert.equal(JSON.stringify(events).includes('run_cancelled'),false);
    assert.match(JSON.stringify(events),/runtime_lease_lost/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('runtime forwards the session fence to both business write boundaries',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'wtr-session-fence-flow-'));
  try {
    const sessions=new PiSessionStore(root),runtime=new PiConversationRuntime(sessions);
    const original=sessions.withSession.bind(sessions),fence={permitId:'test-write-fence'};
    const fenced:PiSessionStore['withSession']=(identity,task,opts)=>original(identity,ctx=>task({...ctx,writeFence:fence}),opts);
    t.mock.method(sessions,'withSession',fenced);
    const faux=fauxProvider({provider:'fence-flow'}),models=createModels();models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('ok')]);let checked=0;
    await runtime.run({...options({models,model:faux.getModel() as Model<Api>},'test'),beforePrompt:async(signal,writeFence)=>{
      assert.equal(signal?.aborted,false);assert.strictEqual(writeFence,fence);checked++;
    }},async(result,signal,writeFence)=>{
      assert.equal(signal?.aborted,false);assert.strictEqual(writeFence,fence);checked++;
      return {value:result,sessionCommit:'accepted'};
    });
    assert.equal(checked,2);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("turn context is appended once and connection changes rebuild only protocol history", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-replay-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "scope-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api>, providerConnectionId: "connection-a" };
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("PRIVATE REASONING"), fauxText("first answer")]),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("third answer"),
    ]);
    await runtime.run({ ...options(modelRuntime, "first question"), turnContext: "context one" });
    const first = (await sessions.snapshot(identity)).messages;
    await runtime.run({ ...options(modelRuntime, "second question"), turnContext: "context two" });
    const second = await sessions.snapshot(identity);
    assert.deepEqual(second.messages.slice(0, first.length), first);
    assert.deepEqual(second.messages[2]?.role === "user" && second.messages[2].content, [
      { type: "text", text: "context two" }, { type: "text", text: "second question" },
    ]);
    assert.equal(second.entries.filter((entry) => entry.type === "compaction").length, 0);
    await runtime.run(options({ ...modelRuntime, providerConnectionId: "connection-b" }, "third question"));
    const third = await sessions.snapshot(identity);
    assert.equal(third.messages[0]?.role, "compactionSummary");
    assert.equal(JSON.stringify(third.messages).includes("PRIVATE REASONING"), false);
    assert.ok(JSON.stringify(third.entries).includes("PRIVATE REASONING"));
    assert.ok(JSON.stringify(third.messages).includes("first answer"));
    assert.ok(JSON.stringify(third.messages).includes("context one"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy history and edited turns establish stable replay boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-edit-replay-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "edit-replay-test" });
    const models = createModels(); models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: faux.getModel() as Model<Api> };
    await sessions.withSession(identity, async ({ session }) => sessions.appendMessages(session, [
      { role: "user", content: "legacy question", timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "LEGACY SECRET", thinkingSignature: "legacy-signature" }, { type: "text", text: "legacy answer" }], timestamp: 2 } as AgentMessage,
    ]));
    faux.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("edited answer"), fauxAssistantMessage("next answer")]);
    await runtime.run({ ...options(modelRuntime, "old question"), turn: { messageId: "edit-me", replace: false, previousMessages: [] } });
    const first = await sessions.snapshot(identity);
    assert.equal(JSON.stringify(first.messages).includes("LEGACY SECRET"), false);
    assert.equal(first.messages[0]?.role, "compactionSummary");
    await runtime.run({ ...options(modelRuntime, "edited question"), turn: { messageId: "edit-me", replace: true, previousMessages: [] } });
    const edited = await sessions.snapshot(identity);
    assert.equal(JSON.stringify(edited.messages).includes("old question"), false);
    assert.equal(JSON.stringify(edited.messages).includes("old answer"), false);
    await runtime.run(options(modelRuntime, "next question"));
    const next = await sessions.snapshot(identity);
    assert.deepEqual(next.messages.slice(0, edited.messages.length), edited.messages);
    assert.equal(next.entries.filter((entry) => entry.type === "compaction").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compaction counts system overhead and never serializes reasoning as summary input", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-compact-replay-"));
  try {
    const sessions = new PiSessionStore(root);
    const runtime = new PiConversationRuntime(sessions);
    const faux = fauxProvider({ provider: "compact-replay-test" });
    const models = createModels(); models.setProvider(faux.provider);
    const modelRuntime: PiModelRuntime = { models, model: { ...faux.getModel(), contextWindow: 20_000 } as Model<Api> };
    await sessions.withSession(identity, async (context) => {
      await sessions.ensureReplayScope(context, modelRuntime, {
        systemPrompt: "s".repeat(15_000), tools: [], thinkingLevel: "off",
      });
      await sessions.appendMessages(context.session, [
        { role: "user", content: "earlier question", timestamp: 1 },
        { role: "assistant", content: [{ type: "thinking", thinking: "COMPACTION SECRET", thinkingSignature: "signed" }, { type: "text", text: "earlier answer" }], timestamp: 2 } as AgentMessage,
      ]);
    });
    faux.setResponses([
      (context) => {
        assert.equal(JSON.stringify(context).includes("COMPACTION SECRET"), false);
        return fauxAssistantMessage("Earlier conversation summarized.");
      },
      (context) => {
        assert.equal(JSON.stringify(context).includes("COMPACTION SECRET"), false);
        assert.ok(JSON.stringify(context).includes("pending question"));
        return fauxAssistantMessage("current answer");
      },
    ]);
    const result = await runtime.run({ ...options(modelRuntime, "pending question"), systemPrompt: "s".repeat(15_000) });
    assert.equal(result.text, "current answer");
    assert.equal(faux.state.callCount, 2);
    const saved = await sessions.snapshot(identity);
    assert.equal(saved.messages[0]?.role, "compactionSummary");
    assert.equal(saved.messages[1]?.role, "user");
    assert.equal(messageText(saved.messages[1]!), "pending question");
    assert.equal(JSON.stringify(saved.messages).includes("COMPACTION SECRET"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
