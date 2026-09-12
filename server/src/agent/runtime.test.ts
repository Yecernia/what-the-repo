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
      fauxThinking("DO NOT SHOW THIS INTERNAL REASONING"),
      fauxText("可展示的回答"),
    ])]);

    const result = await runtime.run(options(modelRuntime, "展示事件测试"));
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
    const persisted = await sessions.snapshot(identity);
    const persistedText = JSON.stringify(persisted.messages);
    assert.equal(persistedText.includes("DO NOT SHOW THIS INTERNAL REASONING"), false);
    assert.equal(persisted.messages.some((message) => (
      message.role === "assistant"
      && message.content.some((block) => block.type === "thinking")
    )), false);
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
    assert.deepEqual(afterRejected.messages.map(messageText), ["第一轮问题", visibleAnswer]);

    await runtime.run(options(modelRuntime, "你好"), async (result) => ({
      value: result,
      sessionCommit: "accepted",
    }));
    assert.deepEqual(visibleToSecondRun, ["第一轮问题", visibleAnswer, "你好"]);

    const committed = await sessions.snapshot(identity);
    assert.deepEqual(committed.messages.map(messageText), [
      "第一轮问题",
      visibleAnswer,
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

    const result = await runtime.run(runOptions);
    assert.equal(result.stopReason, "paused");
    assert.equal(faux.state.callCount, 1);
    assert.ok(result.events.some((event) => event.type === "run_paused"));
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
