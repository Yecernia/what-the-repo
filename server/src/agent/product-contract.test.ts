import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProject, emptyProfile } from "../domain/conversation.js";
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import { FileStore } from "../persistence/file-store.js";
import { validateAnswerCitations, withCitationNotice } from "./citations.js";
import { createConversationTools, type ConversationToolContext } from "./conversation-tools.js";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiConversationRuntime } from "./runtime.js";
import { PiSessionStore, projectSessionId } from "./session-store.js";
import { PiMemoryStore } from "./memory-store.js";
import { MemoryMaintenance } from "./memory-maintenance.js";
import { FeedbackAnalysisWorker } from "./feedback.js";
import { ConversationService } from "../services/conversation-service.js";
import type { ServerConfig } from "../config.js";
import type { PiAgentRunOptions, PiModelRuntime, PiRunFinalization, PiRunResult } from "./types.js";
import { providerErrorCode } from "./provider-error.js";

test("last turn editing replaces Pi context, including a later compaction, and saves failed summaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wtr-last-turn-"));
  try {
    const { context, store } = await fixture(root);
    const sessions = new PiSessionStore(join(root, "sessions"));
    const faux = fauxProvider({ provider: "last-turn-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const originalRun = PiConversationRuntime.prototype.run;
    t.mock.method(PiConversationRuntime.prototype, "run", function(this: PiConversationRuntime, options: PiAgentRunOptions,
      finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) {
      return originalRun.call(this, { ...options, modelRuntime: { models, model: faux.getModel() } }, finalize);
    });
    t.mock.method(MemoryMaintenance.prototype, "schedule", () => {});
    t.mock.method(FeedbackAnalysisWorker.prototype, "schedule", () => {});
    const config = { root, dataDir: root, nodeEnv: "test", sessionSecret: "test-only-secret",
      freeProviderBaseUrl: "https://api.deepseek.com", freeProviderModel: "deepseek-chat",
      freeProviderApiKey: "never-used", keyEncryptionSecret: "test-only-secret" } as ServerConfig;
    const service = new ConversationService(config, store, sessions, new PiMemoryStore(join(root, "memory")));
    const owner = { owner_id: context.project.owner_id, kind: "guest" as const };
    const base = { owner, projectId: context.project.project_id };
    faux.setResponses([fauxAssistantMessage("先前回答"), fauxAssistantMessage("打错字的旧回答")]);
    const first = (await service.run({ ...base, content: "先前问题" }))!;
    const old = (await service.run({ ...base, content: "打错的问题" }))!;
    const identity = { sessionId: projectSessionId(owner.owner_id, base.projectId, context.project.analysis.snapshot_id),
      ownerId: owner.owner_id, projectId: base.projectId, snapshotId: context.project.analysis.snapshot_id,
      skillId: "primary-conversational-supervisor", skillVersion: "test" };
    await sessions.withSession(identity, async ({ session, messages }) => sessions.appendCompaction(session, {
      summary: "打错的问题和旧回答已压缩", tokensBefore: 200, retainedTail: messages.slice(-2),
    }));
    faux.setResponses([(request) => {
      const serialized = JSON.stringify(request.messages);
      assert.match(serialized, /先前问题/);
      assert.match(serialized, /先前回答/);
      assert.match(serialized, /正确问题/);
      assert.doesNotMatch(serialized, /打错|旧回答|已压缩/);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate_limit_exceeded" });
    }]);
    const failed = (await service.run({ ...base, content: "正确问题", replaceMessageId: old.user_message.message_id }))!;
    assert.equal(failed.error?.code, "provider_rate_limited");
    assert.equal(failed.assistant_message.content, "");
    assert.equal(failed.assistant_message.thinking_summary?.at(-1)?.status, "failed");
    assert.match(failed.assistant_message.thinking_summary?.at(-1)?.label ?? "", /上游请求过多/);
    faux.setResponses([(request) => {
      assert.equal(request.messages.filter(message => message.role === "user").length, 2);
      assert.doesNotMatch(JSON.stringify(request.messages), /打错|rate_limit|上游请求/);
      return fauxAssistantMessage("正确的新回答");
    }]);
    const successful = (await service.run({ ...base, content: "正确问题", retryRunId: failed.assistant_message.trace_id! }))!;
    assert.equal(successful.error, undefined);
    const saved = (await store.loadProject(base.projectId, owner.owner_id))!;
    assert.deepEqual(saved.messages.map(message => message.content), ["先前问题", "先前回答", "正确问题", "正确的新回答"]);
    assert.equal(saved.messages[2]?.message_id, old.user_message.message_id);
    assert.ok((await store.listRunTraces(base.projectId, failed.assistant_message.trace_id!)).length);
    await assert.rejects(service.run({ ...base, content: "不能改较早问题", replaceMessageId: first.user_message.message_id }), /只能编辑最后/);
    const active = await sessions.snapshot(identity);
    assert.doesNotMatch(JSON.stringify(active.messages), /打错|旧回答/);
    const all = await sessions.withSession(identity, ({ session }) => session.findEntries());
    assert.ok(all.length > active.entries.length); // Old audit branch remains, outside LLM context.
    const controller = new AbortController();
    let concurrent: Promise<void> | undefined;
    faux.setResponses([fauxAssistantMessage("取消前的部分内容")]);
    const cancelled = (await service.run({ ...base, content: "将被取消的问题", signal: controller.signal, onEvent: event => {
      if (event.type === "run_started") concurrent = assert.rejects(service.run({ ...base, content: "并发编辑" }), /上一轮仍在处理/);
      if (event.type === "assistant_delta" && event.delta) controller.abort();
    } }))!;
    await concurrent;
    assert.equal(cancelled.error?.code, "cancelled");
    assert.equal(cancelled.assistant_message.thinking_summary?.at(-1)?.status, "cancelled");
    assert.ok(cancelled.assistant_message.content.length > 0);
    faux.setResponses([(request) => {
      assert.doesNotMatch(JSON.stringify(request.messages), /将被取消|取消前的部分/);
      return fauxAssistantMessage("修改后正常回答");
    }]);
    await service.run({ ...base, content: "取消后修改的问题", replaceMessageId: cancelled.user_message.message_id });
    const afterCancel = (await store.loadProject(base.projectId, owner.owner_id))!;
    assert.equal(afterCancel.messages.length, 6);
    assert.equal(afterCancel.messages.at(-2)?.content, "取消后修改的问题");
    assert.equal(afterCancel.messages.at(-1)?.error, null);
    const legacySessions = new PiSessionStore(join(root, "legacy-sessions"));
    const legacyService = new ConversationService(config, store, legacySessions, new PiMemoryStore(join(root, "memory")));
    faux.setResponses([(request) => {
      assert.match(JSON.stringify(request.messages), /先前问题|正确的新回答/);
      assert.doesNotMatch(JSON.stringify(request.messages), /取消后修改的问题|修改后正常回答/);
      return fauxAssistantMessage("旧会话也能编辑");
    }]);
    await legacyService.run({ ...base, content: "修改旧会话", replaceMessageId: afterCancel.messages.at(-2)!.message_id });
    assert.equal((await store.loadProject(base.projectId, owner.owner_id))!.messages.length, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public upstream failures distinguish balance from rate limits and local budgets", () => {
  assert.equal(providerErrorCode("429 insufficient_quota"), "provider_balance_insufficient");
  assert.equal(providerErrorCode("429 too many requests"), "provider_rate_limited");
  assert.equal(providerErrorCode("Provider budget exceeded"), "provider_budget_exceeded");
  assert.equal(providerErrorCode("401 invalid key"), "provider_authentication_failed");
  assert.equal(providerErrorCode("403 forbidden"), "provider_permission_denied");
  assert.equal(providerErrorCode("UND_ERR_SOCKET"), "provider_connection_failed");
  assert.equal(providerErrorCode(new Error("database unavailable"), "server_error"), "server_error");
});

async function fixture(root: string): Promise<{
  store: FileStore;
  context: ConversationToolContext;
  snapshot: EvidenceSnapshot;
}> {
  const store = new FileStore(root);
  await store.init();
  const project = createProject(
    "guest:contract",
    "https://github.com/example/contract",
    "contract",
    "free:deepseek-v4-flash",
  );
  const snapshotId = "snap:repo:github:example/contract:123:contract";
  const publicKey = "c".repeat(64);
  const entryEvidence = evidence("fact:file:entry", "src/entry.ts", 1, 4);
  const coreEvidence = evidence("fact:file:core", "src/core.ts", 1, 3);
  const relationEvidence = {
    ...entryEvidence,
    stable_id: "fact:call:entry-core",
    label: "start 调用 run",
    kind: "calls",
  };
  const snapshot: EvidenceSnapshot = {
    snapshot_id: snapshotId,
    summary: { file_count: 2, symbol_count: 2, call_count: 1, component_count: 2 },
    graph: {
      semantic_mode: "provider_supported",
      nodes: [
        component("component:entry", "入口层", "接收请求并调用核心服务。", entryEvidence),
        component("component:core", "核心服务层", "执行核心业务规则。", coreEvidence),
      ],
      edges: [{
        id: "relation:entry-core",
        source: "component:entry",
        target: "component:core",
        relation_kind: "calls",
        label: "入口调用核心服务",
        description: "入口把请求交给核心服务。",
        certainty: "verified",
        evidence: [relationEvidence],
        weight: 1,
      }],
      layers: [],
      unassigned_component_ids: [],
    },
    fact_graph: { nodes: [], edges: [] },
    value_points: [],
    languages: [{
      language: "typescript",
      quality_tier: "verified",
      files_seen: 2,
      files_analyzed: 2,
      files_failed: 0,
      reason_codes: [],
    }],
    learning_plan: {
      snapshot_id: snapshotId,
      selected_value_point: null,
      steps: [],
    },
  };
  project.analysis.snapshot_id = snapshotId;
  project.analysis.canonical_snapshot_key = publicKey;
  project.analysis.stage = "done";
  project.study.phase = "explaining";
  project.study.current_step = 1;
  project.study.total_steps = 3;
  await store.saveProject(project);
  await store.savePublicSnapshot({
    publicKey,
    repository: "example/contract",
    commitSha: "3".repeat(40),
    snapshotId,
    view: snapshot,
    analysis: { snapshot_id: snapshotId, fact_graph: snapshot.fact_graph },
  });
  const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "src", "entry.ts"), "import { run } from './core';\nexport function start() {\n  return run();\n}\n", "utf8");
  await writeFile(join(sourceRoot, "src", "core.ts"), "export function run() {\n  return 'ok';\n}\n", "utf8");
  const context: ConversationToolContext = {
    project,
    snapshot,
    profile: emptyProfile(),
    agentMemories: [],
    store,
    selected: {
      snapshot_id: snapshotId,
      kind: "component",
      stable_id: "component:entry",
      label: "入口层",
    },
    exposedEvidence: new Map(),
    exposedPaths: new Set(),
    toolsUsed: [],
    pendingLearningAction: { value: null },
    assessment: { value: null },
    currentUserMessage: "讲讲图里这个组件",
    modelRuntime: null as never,
    workerRuns: [],
  };
  return { store, context, snapshot };
}

test("selected component context returns only real adjacent components", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-selected-component-"));
  try {
    const { context } = await fixture(root);
    const tool = createConversationTools(context).find((item) => item.name === "get_component_context");
    assert.ok(tool);
    const result = await tool.execute("selected", {});
    const payload = JSON.parse(String((result.content[0] as { text: string }).text)) as {
      component: {
        id: string;
        neighbors: Array<{ id: string }>;
        adjacent_relations: Array<{ id: string }>;
      };
    };
    assert.equal(payload.component.id, "component:entry");
    assert.deepEqual(payload.component.neighbors.map((item) => item.id), ["component:core"]);
    assert.deepEqual(payload.component.adjacent_relations.map((item) => item.id), ["relation:entry-core"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fabricated graph identifiers fail closed without exposing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-fabricated-graph-"));
  try {
    const { context } = await fixture(root);
    const tool = createConversationTools(context).find((item) => item.name === "get_component_context");
    assert.ok(tool);
    await assert.rejects(
      tool.execute("fabricated", { component_id: "component:invented" }),
      /找不到这个组件/,
    );
    assert.equal(context.exposedEvidence.size, 0);
    assert.equal(context.exposedPaths.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only repository tools preserve the existing teaching state", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-readonly-state-"));
  try {
    const { context } = await fixture(root);
    const before = structuredClone(context.project.study);
    const tools = createConversationTools(context);
    await tools.find((item) => item.name === "get_project_overview")?.execute("overview", {});
    await tools.find((item) => item.name === "query_code_evidence")?.execute("query", {
      text: "入口",
      limit: 3,
    });
    assert.deepEqual(context.project.study, before);
    assert.equal(context.pendingLearningAction.value, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("online tool catalog contains no shell database or arbitrary file capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-tool-catalog-"));
  try {
    const { context } = await fixture(root);
    const names = createConversationTools(context).map((item) => item.name).sort();
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
    assert.equal(names.some((name) => /shell|bash|sql|database|write|execute/.test(name)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("citation validation accepts real lines and rejects fabricated locations", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-citation-contract-"));
  try {
    const { context, snapshot, store } = await fixture(root);
    const valid = await validateAnswerCitations({
      text: "入口在 `src/entry.ts:2`。",
      snapshot,
      exposed: context.exposedEvidence,
      projectId: context.project.project_id,
      store,
    });
    assert.equal(valid.errors.length, 0);
    assert.equal(valid.evidence[0]?.path, "src/entry.ts");
    const invalid = await validateAnswerCitations({
      text: "不存在的实现位于 `src/missing.ts:99`，越界位置是 `src/core.ts:999`。",
      snapshot,
      exposed: context.exposedEvidence,
      projectId: context.project.project_id,
      store,
    });
    assert.deepEqual(invalid.evidence, []);
    assert.ok(invalid.errors.some((item) => item.startsWith("unknown_path:")));
    assert.ok(invalid.errors.some((item) => item.startsWith("invalid_line:")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("citation validation canonicalizes a unique basename and ignores code symbols", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-citation-basename-"));
  try {
    const { context, snapshot, store } = await fixture(root);
    const basename = await validateAnswerCitations({
      text: "入口在 `entry.ts:2`。",
      snapshot,
      exposed: context.exposedEvidence,
      projectId: context.project.project_id,
      store,
    });
    assert.deepEqual(basename.errors, []);
    assert.equal(basename.evidence[0]?.path, "src/entry.ts");

    const symbols = await validateAnswerCitations({
      text: "这里调用了 `Field.eval`，并使用 `Math.min`。",
      snapshot,
      exposed: context.exposedEvidence,
      projectId: context.project.project_id,
      store,
    });
    assert.deepEqual(symbols.errors, []);
    assert.deepEqual(symbols.evidence, []);

    const exposed = new Map([["fact:file:entry", snapshot.graph.nodes[0]!.evidence[0]!]]);
    const invalid = await validateAnswerCitations({
      text: "错误路径是 `missing.ts:1`。",
      snapshot,
      exposed,
      projectId: context.project.project_id,
      store,
    });
    assert.ok(invalid.errors.some((item) => item === "unknown_path:missing.ts"));
    assert.deepEqual(invalid.evidence, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("citation existence accepts shared names, resolves directory context and ignores extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-citation-directory-"));
  try {
    const { context, snapshot, store } = await fixture(root);
    const source = store.publicSourceSnapshotRoot("c".repeat(64), snapshot.snapshot_id);
    await mkdir(join(source, "src/task_queue"), { recursive: true });
    await writeFile(join(source, "src/task_queue/common.ts"), "export const value = 1;\n");
    await writeFile(join(source, "src/common.ts"), "export const another = 2;\n");
    const validate = (text: string) => validateAnswerCitations({ text, snapshot,
      exposed: new Map(), projectId: context.project.project_id, store });
    const ambiguous = await validate("看 `common.ts:1`，这是一个 `.ts` 文件。");
    assert.deepEqual(ambiguous.errors, []);
    assert.deepEqual(ambiguous.evidence, []); // Existence does not choose an arbitrary link.
    const grouped = await validate("`src/task_queue/` 下有 `common.ts:1`，入口另见 `entry.ts:2`。");
    assert.deepEqual(grouped.errors, []);
    assert.match(grouped.text, /`src\/task_queue\/common.ts:1`/);
    assert.equal(grouped.evidence[0]?.path, "src/task_queue/common.ts"); // Not in the graph.
    assert.equal(grouped.evidence[0]?.start_line, 1);
    assert.match(grouped.text, /`src\/entry.ts:2`/);
    const notInherited = await validate("`src/task_queue/` 下的文件。\n\n再看 `common.ts:1`。");
    assert.deepEqual(notInherited.errors, []);
    assert.deepEqual(notInherited.evidence, []);
    const invalid = await validate("构建后可能有 `dist/main.js`，尚未核实；参见 `src/entry.ts:2-999`。");
    assert.equal(invalid.errors.length, 2);
    assert.deepEqual(invalid.evidence, []);
    assert.match(withCitationNotice(invalid.text, invalid.errors), /引用未核实/);
    assert.match(withCitationNotice("See `missing.ts`.", ["unknown_path:missing.ts"]), /Unverified references/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation service keeps the displayed unverified reply in the next Pi requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-visible-history-"));
  try {
    const { context, store } = await fixture(root);
    const sessions = new PiSessionStore(join(root, "sessions"));
    const faux = fauxProvider({ provider: "visible-history-test" });
    const models = createModels();
    models.setProvider(faux.provider);
    const modelRuntime = { models, model: faux.getModel() } as PiModelRuntime;
    const originalRun = PiConversationRuntime.prototype.run;
    t.mock.method(PiConversationRuntime.prototype, "run", function(this: PiConversationRuntime, options: PiAgentRunOptions,
      finalize: (result: PiRunResult) => Promise<PiRunFinalization<unknown>>) {
      assert.match(options.systemPrompt, /界面会精简显示名称/); // Actual loaded Skill + dynamic prompt.
      assert.match(options.systemPrompt, /界面默认语言：English/);
      assert.match(options.systemPrompt, /当前用户提问的主要语言/);
      assert.match(options.systemPrompt, /hello/);
      assert.equal(options.modelRuntime.model.id, "deepseek-chat", "role overrides must preserve the selected chat model");
      for (const role of ["understanding-assessment", "citation-review", "memory-maintenance"] as const) {
        assert.equal(options.modelRuntime.roleRuntimes?.[role]?.model.id, `test-${role}`);
      }
      return originalRun.call(this, { ...options, modelRuntime }, finalize);
    });
    t.mock.method(MemoryMaintenance.prototype, "schedule", () => {});
    t.mock.method(FeedbackAnalysisWorker.prototype, "schedule", () => {});
    const config = { root, dataDir: root, nodeEnv: "test", sessionSecret: "test-only-secret",
      freeProviderBaseUrl: "https://api.deepseek.com", freeProviderModel: "deepseek-chat",
      freeProviderApiKey: "never-used", keyEncryptionSecret: "test-only-secret",
      agentModels: Object.fromEntries(["understanding-assessment", "citation-review", "memory-maintenance"].map(role => [role, { model: `test-${role}` }])) } as ServerConfig;
    const service = new ConversationService(config, store, sessions, new PiMemoryStore(join(root, "memory")));
    const owner = { owner_id: context.project.owner_id, kind: "guest" as const };
    let visible = "";
    faux.setResponses([
      fauxAssistantMessage("这个文件可能是 `missing.ts`，尚未核实。"),
      (input) => {
        const last = input.messages.at(-2);
        assert.equal(last?.role, "assistant");
        assert.equal(last?.role === "assistant" ? last.content.filter(b => b.type === "text").map(b => b.text).join("") : "", visible);
        assert.match(visible, /引用未核实/);
        return fauxAssistantMessage("午饭可以吃面。");
      },
      (input) => {
        assert.equal(input.messages.at(-1)?.role, "user");
        const answers = input.messages.filter(message => message.role === "assistant");
        assert.equal(answers.length, 2);
        return fauxAssistantMessage("你好！");
      },
    ]);
    const first = await service.run({ owner, projectId: context.project.project_id, content: "讲一个简单文件", displayLanguage: "en" });
    assert.ok(first);
    visible = first.assistant_message.content;
    assert.deepEqual(first.validation_errors, ["unknown_path:missing.ts"]);
    assert.equal(first.assistant_message.context_eligible, false); // Not promoted to trusted long-term memory.
    const second = await service.run({ owner, projectId: context.project.project_id, content: "午饭吃什么", displayLanguage: "en" });
    assert.equal(second?.assistant_message.content, "午饭可以吃面。");
    await service.run({ owner, projectId: context.project.project_id, content: "你好", displayLanguage: "en" });
    const persisted = await store.loadProject(context.project.project_id, owner.owner_id);
    assert.equal(persisted?.messages[1]?.content, visible);
    const identity = { sessionId: projectSessionId(owner.owner_id, context.project.project_id, context.project.analysis.snapshot_id),
      ownerId: owner.owner_id, projectId: context.project.project_id, snapshotId: context.project.analysis.snapshot_id,
      skillId: "primary-conversational-supervisor", skillVersion: "test" };
    const history = await sessions.snapshot(identity);
    assert.deepEqual(history.messages.map(message => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function evidence(stableId: string, path: string, start: number, end: number) {
  return {
    stable_id: stableId,
    label: path,
    path,
    start_line: start,
    end_line: end,
    kind: "file",
  };
}

function component(id: string, name: string, responsibility: string, member: ReturnType<typeof evidence>) {
  return {
    id,
    label: name,
    name,
    responsibility,
    architecture_layer_id: null,
    architecture_layer_name: null,
    members: [member],
    member_count: 1,
    evidence: [member],
    certainty: "verified",
    review_status: "reviewed",
    fan_in: 0,
    fan_out: 0,
  };
}
