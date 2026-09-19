import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import dns from "node:dns/promises";
import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp, progressPayload } from "./app.js";
import { createMessage, createProject, emptyProfile } from "../domain/conversation.js";
import { newAnalysisJob } from "../domain/jobs.js";
import { createLearningActionProposal } from "../agent/learning-actions.js";
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore, projectSessionId } from "../agent/session-store.js";
import type { EvidenceSnapshot } from "../domain/snapshot.js";
import { FileStore } from "../persistence/file-store.js";
import type { ServerConfig } from "../config.js";
import {
  parseGithubGatewayStartGrant,
  signGithubGatewayPayload,
} from "../github-gateway/protocol.js";

function config(dataDir: string): ServerConfig {
  return {
    root: dataDir,
    host: "127.0.0.1",
    port: 8398,
    dataDir,
    sessionDir: join(dataDir, "pi-sessions"),
    memoryDir: join(dataDir, "pi-memory"),
    skillVersionsRoot: join(dataDir, "skill-versions"),
    nodeEnv: "test",
    sessionSecret: "test-session-secret",
    freeProviderBaseUrl: null,
    freeProviderModel: null,
    freeProviderApiKey: null,
    githubClientId: null,
    githubClientSecret: null,
    githubCallbackUrl: null,
    webUrl: "http://127.0.0.1:5307",
    databaseUrl: null,
    retentionEnabled: true,
    keyEncryptionSecret: "test-session-secret",
    quotaMaxProjects: 20,
    quotaCreationsPerHour: 30,
    quotaStorageBytes: 4 * 1024 * 1024 * 1024,
    mcpTokens: [],
    mcpRequestsPerMinute: 60,
  };
}

function githubConfig(dataDir: string): ServerConfig {
  return {
    ...config(dataDir),
    githubClientId: "github-client",
    githubClientSecret: "github-secret",
    githubCallbackUrl: "http://127.0.0.1:5307/oauth/callback",
  };
}

function githubGatewayConfig(dataDir: string): ServerConfig {
  return {
    ...githubConfig(dataDir),
    githubClientId: null,
    githubClientSecret: null,
    githubCallbackUrl: null,
    githubGatewayUrl: "https://github.example.com",
    githubGatewaySharedSecret: "gateway-test-secret-012345678901234567890123456789",
  };
}

test("production API refuses to build without a signing Session Secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-session-secret-"));
  try {
    const store = new FileStore(root);
    await store.init();
    assert.throws(
      () => buildApp({
        config: { ...config(root), nodeEnv: "production", sessionSecret: "" },
        store,
        sessions: new PiSessionStore(join(root, "pi-sessions")),
        memories: new PiMemoryStore(join(root, "pi-memory")),
      }),
      /生产 API 必须配置至少 32 个字符/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function cookieValue(headers: string | string[] | undefined, name: string): string {
  const rows = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const row = rows.find((item) => item.startsWith(`${name}=`));
  assert.ok(row, `missing cookie ${name}`);
  return row!.split(";", 1)[0].slice(name.length + 1);
}

function cookieHeaderFromSetCookies(headers: string | string[] | undefined, names: string[]): string {
  const rows = Array.isArray(headers) ? headers : headers ? [headers] : [];
  return names.map((name) => `${name}=${cookieValue(rows, name)}`).join("; ");
}

function signOAuthCookie(body: Record<string, unknown>, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function verifyAndAddConnection(
  app: FastifyInstance,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
) {
  const verified = await app.inject({
    method: "POST",
    url: "/api/settings/connections/verify",
    headers,
    payload,
  });
  assert.equal(verified.statusCode, 200);
  const verification = verified.json() as { ok: boolean; verification_token?: string; message?: string };
  assert.equal(verification.ok, true, verification.message);
  assert.ok(verification.verification_token);
  return app.inject({
    method: "POST",
    url: "/api/settings/connections",
    headers,
    payload: {
      ...payload,
      verification_token: verification.verification_token,
    },
  });
}

test("TypeScript API keeps guest project/profile contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: { ...config(root), chatMaxRounds: 12, chatMaxContentBytes: 3456 },
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true, storage: "file", model_configured: false });
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    assert.equal(guest.statusCode, 200);
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader } });
    assert.equal(me.statusCode, 200);
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { kind: "github", value: "https://github.com/example/repo", title: "我的项目", model: "provider:personal:model" },
    });
    assert.equal(project.statusCode, 201);
    const createdProject = project.json() as { project: { project_id: string; model_override: string | null } };
    assert.equal(createdProject.project.model_override, null);
    assert.deepEqual(project.json().project.chat_limits, { max_rounds: 12, max_content_bytes: 3456 });
    const projectId = createdProject.project.project_id;
    const refreshed = await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: { cookie: cookieHeader } });
    assert.equal(refreshed.statusCode, 200);
    assert.deepEqual(refreshed.json().project.chat_limits, { max_rounds: 12, max_content_bytes: 3456 });
    assert.equal('chat_limits' in (await store.loadProject(projectId))!, false);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { title: "新标题" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal((renamed.json() as { title: string }).title, "新标题");
    const profile = await app.inject({
      method: "PUT",
      url: "/api/profile",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { enabled: false, goals: ["理解架构"] },
    });
    assert.equal(profile.statusCode, 200);
    assert.equal((profile.json() as { profile: { enabled: boolean } }).profile.enabled, false);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot language query is read-only, validates language and preserves owner access", async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-display-language-api-'));
  const store = new FileStore(root);
  await store.init();
  const app = buildApp({ config: config(root), store,
    sessions: new PiSessionStore(join(root, 'pi-sessions')), memories: new PiMemoryStore(join(root, 'pi-memory')) });
  try {
    const guest = await app.inject({ method: 'POST', url: '/api/auth/guest' });
    const cookie = guest.headers['set-cookie']!;
    const headers = { cookie: (Array.isArray(cookie) ? cookie[0]! : cookie).split(';')[0]! };
    const project = createProject(guest.json<{ owner_id: string }>().owner_id, 'https://github.com/example/repo', 'Example', 'free:test');
    project.display_language = 'zh-CN';
    await store.saveProject(project);
    const reads: Array<string | undefined> = [];
    store.loadSnapshot = async <T>(_id: string, language?: string) => {
      reads.push(language); return { snapshot_id: 'same-id', display_language: language ?? 'zh-CN' } as T;
    };
    const url = `/api/projects/${project.project_id}/snapshot`;
    const response = await app.inject({ method: 'GET', url: `${url}?display_language=en`, headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().display_language, 'en');
    assert.equal((await app.inject({ method: 'GET', url: `${url}?display_language=fr`, headers })).statusCode, 400);
    const stranger = createProject('guest:someone-else', 'https://github.com/example/repo', 'Other', 'free:test');
    await store.saveProject(stranger);
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${stranger.project_id}/snapshot?display_language=en`, headers })).statusCode, 404);
    assert.deepEqual(reads, ['en']);
    assert.equal((await store.loadProject(project.project_id))!.display_language, 'zh-CN');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("reanalyze reuses an active job and the user cancellation route is gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-analysis-reuse-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    assert.equal(guest.statusCode, 200);
    const ownerId = (guest.json() as { owner_id: string }).owner_id;
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const project = createProject(ownerId, "https://github.com/example/reuse-api", "复用任务", "free:test");
    const originalJob = newAnalysisJob(project.project_id, "analysis:reuse-api:first");
    await store.createProjectWithJob(project, originalJob);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/projects/${project.project_id}/analysis/cancel`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(cancelled.statusCode, 404);

    const reanalyzed = await app.inject({
      method: "POST",
      url: `/api/projects/${project.project_id}/reanalyze`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(reanalyzed.statusCode, 200);
    const reanalyzedBody = reanalyzed.json() as { job_id: string; job_status: string };
    assert.equal(reanalyzedBody.job_id, originalJob.job_id);
    assert.equal(reanalyzedBody.job_status, "queued");

    const otherGuest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const otherCookie = otherGuest.headers["set-cookie"];
    assert.ok(otherCookie);
    const otherCookieHeader = Array.isArray(otherCookie) ? otherCookie[0].split(";", 1)[0] : otherCookie.split(";", 1)[0];
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/projects/${project.project_id}/reanalyze`,
      headers: { cookie: otherCookieHeader },
    });
    assert.equal(forbidden.statusCode, 404);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health endpoint fails closed when the configured store is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-health-"));
  try {
    const store = new FileStore(root);
    await store.init();
    store.checkHealth = async () => {
      throw new Error("store unavailable");
    };
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 503);
    assert.deepEqual(health.json(), { ok: false, storage: "file", model_configured: false });
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation requests report session_busy when the previous turn still owns the Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-session-busy-"));
  let releaseHolder = (): void => undefined;
  let holder: Promise<void> | undefined;
  try {
    const store = new FileStore(root);
    await store.init();
    const sessions = new PiSessionStore(join(root, "pi-sessions"));
    const app = buildApp({
      config: {
        ...config(root),
        freeProviderBaseUrl: "https://api.deepseek.com",
        freeProviderModel: "deepseek-chat",
        freeProviderApiKey: "test-provider-key",
        chatWaitTimeoutMs: 25,
      },
      store,
      sessions,
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const ownerId = (guest.json() as { owner_id: string }).owner_id;
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: {
        kind: "github",
        value: "https://github.com/example/session-busy",
        title: "Session busy test",
        model: "free:deepseek-v4-flash",
      },
    });
    assert.equal(created.statusCode, 201);
    const projectId = (created.json() as { project: { project_id: string } }).project.project_id;
    const project = await store.loadProject(projectId, ownerId);
    assert.ok(project);

    let holderEntered!: () => void;
    const holderReady = new Promise<void>((resolve) => { holderEntered = resolve; });
    const holderBlock = new Promise<void>((resolve) => { releaseHolder = resolve; });
    holder = sessions.withSession({
      sessionId: projectSessionId(ownerId, projectId, project.analysis.snapshot_id),
      ownerId,
      projectId,
      snapshotId: project.analysis.snapshot_id,
      skillId: "primary-supervisor",
      skillVersion: "test-holder",
    }, async () => {
      holderEntered();
      await holderBlock;
    });
    await holderReady;

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/messages`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { content: "这条消息不应越过上一轮。" },
    });
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), {
      detail: "上一轮仍在处理，请等待它结束或取消后再试",
      code: "session_busy",
    });

    releaseHolder();
    await holder;
    await app.close();
  } finally {
    releaseHolder();
    await holder?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("assistant feedback persists immediately and keeps natural model failures out of the response", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-feedback-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { kind: "github", value: "https://github.com/example/feedback", title: "反馈测试", model: "free:deepseek-v4-flash" },
    });
    const projectId = (projectResponse.json() as { project: { project_id: string } }).project.project_id;
    const project = await store.loadProject(projectId, (guest.json() as { owner_id: string }).owner_id);
    assert.ok(project);
    const assistant = createMessage("assistant", "这是一个可评价的回答。");
    project.messages.push(assistant);
    await store.saveProject(project);

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/messages/${assistant.message_id}/feedback`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { vote: "up" },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { feedback: { vote: string } }).feedback.vote, "up");
    const saved = await store.loadProject(projectId, project.owner_id);
    assert.equal(saved?.messages.find((message) => message.message_id === assistant.message_id)?.feedback?.vote, "up");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("learning action decline is model-free and stop confirmation commits only after the click", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-learning-action-api-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const ownerId = (guest.json() as { owner_id: string }).owner_id;
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { kind: "github", value: "https://github.com/example/learning", title: "学习确认", model: "free:deepseek-v4-flash" },
    });
    assert.equal(created.statusCode, 201);
    const projectId = (created.json() as { project: { project_id: string } }).project.project_id;
    const project = await store.loadProject(projectId, ownerId);
    assert.ok(project);
    const snapshot: EvidenceSnapshot = {
      snapshot_id: "snapshot:learning-actions",
      summary: { file_count: 1, symbol_count: 1, call_count: 0, component_count: 1 },
      graph: {
        semantic_mode: "provider_supported",
        nodes: [],
        edges: [],
        layers: [],
        unassigned_component_ids: [],
      },
      value_points: [],
      languages: [],
      learning_plan: { snapshot_id: "snapshot:learning-actions", selected_value_point: null, steps: [] },
    };
    project.analysis.snapshot_id = snapshot.snapshot_id;
    project.analysis.stage = "done";
    project.study.phase = "explaining";
    project.study.current_step = 0;
    project.study.total_steps = 1;
    project.study.dynamic_learning_plan = [{
      step_id: "learning:one",
      order: 1,
      title: "第一步",
      objective: "理解入口。",
      component_ids: ["component:entry"],
      evidence_refs: ["fact:file:entry"],
      completion_check: "能说明入口职责。",
    }];
    const routeProposal = createLearningActionProposal(project, snapshot, {
      action: "start_learning_route",
      targetKind: "repository",
      request: "请带我系统学习",
    });
    const stopProposal = createLearningActionProposal(project, snapshot, {
      action: "stop_guided_learning",
      request: "我不想继续被带着学了",
    });
    project.messages.push(
      createMessage("assistant", "可以为你制定路线。", { learning_action: routeProposal }),
      createMessage("assistant", "可以停止当前路线。", { learning_action: stopProposal }),
    );
    await store.saveProject(project);
    await store.saveSnapshot(projectId, snapshot);

    const declined = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/learning-actions/${encodeURIComponent(routeProposal.action_id)}`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { decision: "decline" },
    });
    assert.equal(declined.statusCode, 200);
    assert.equal((declined.json() as { action: { status: string } }).action.status, "declined");
    assert.equal((declined.json() as { state_changed: boolean }).state_changed, false);

    const stopped = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/learning-actions/${encodeURIComponent(stopProposal.action_id)}`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { decision: "confirm" },
    });
    assert.equal(stopped.statusCode, 200);
    const stoppedPayload = stopped.json() as {
      action: { status: string };
      state_changed: boolean;
      project: { study: { phase: string; total_steps: number; dynamic_learning_plan: unknown[] } };
    };
    assert.equal(stoppedPayload.action.status, "executed");
    assert.equal(stoppedPayload.state_changed, true);
    assert.equal(stoppedPayload.project.study.phase, "orienting");
    assert.equal(stoppedPayload.project.study.total_steps, 0);
    assert.deepEqual(stoppedPayload.project.study.dynamic_learning_plan, []);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming chat closes with a safe error event when a run fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-stream-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: {
        kind: "github",
        value: "https://github.com/example/repo",
        title: "流式错误测试",
        model: "free:deepseek-v4-flash",
      },
    });
    const projectId = (project.json() as { project: { project_id: string } }).project.project_id;
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/messages/stream`,
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { content: "你好" },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: error/);
    assert.match(response.body, /上游暂不可用，请稍后重试/);
    assert.match(response.body, /event: done/);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SSE progress payload carries the safe display contract and hides answer deltas", () => {
  const timestamp = "2026-08-31T00:00:00.000Z";
  const tool = progressPayload({
    runId: "run-sse-contract",
    sequence: 7,
    timestamp,
    type: "tool_result_received",
    summary: "已完成工具调用",
    elapsedMs: 345,
    toolName: "query_code_evidence",
    isError: false,
    display: {
      kind: "tool",
      stage: "tool",
      label: "已完成工具调用",
      text: "已收到工具结果，下面结合证据继续判断。",
      toolName: "query_code_evidence",
      status: "completed",
      visible: true,
    },
  });
  assert.deepEqual(tool, {
    run_id: "run-sse-contract",
    stage: "tool_result_received",
    event_type: "tool_result_received",
    display_stage: "tool",
    kind: "tool",
    label: "已完成工具调用",
    text: "已收到工具结果，下面结合证据继续判断。",
    status: "completed",
    visible: true,
    timestamp,
    elapsed_ms: 345,
    sequence: 7,
    delta: undefined,
    tool_name: "query_code_evidence",
    tool_error: false,
  });

  const answerDelta = progressPayload({
    runId: "run-sse-contract",
    sequence: 8,
    timestamp,
    type: "assistant_delta",
    summary: "正在生成回答",
    delta: "最终答案片段",
    display: {
      kind: "answer",
      stage: "answer",
      label: "正在生成回答",
      status: "running",
      visible: false,
    },
  });
  assert.equal(answerDelta.visible, false);
  assert.equal(answerDelta.kind, "answer");
  assert.equal(answerDelta.delta, "最终答案片段");
  assert.equal(answerDelta.text, undefined);
});

test("run event replay returns events from the final trace after Last-Event-ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-run-events-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: {
        kind: "github",
        value: "https://github.com/example/run-events",
        title: "事件回放",
        model: "free:deepseek-v4-flash",
      },
    });
    const projectId = (created.json() as { project: { project_id: string } }).project.project_id;
    const timestamp = new Date().toISOString();
    await store.saveTrace("run-replay", {
      trace_id: "run-replay",
      run_id: "run-replay",
      project_id: projectId,
      owner_id: (guest.json() as { owner_id: string }).owner_id,
      event_type: "conversation",
      stop_reason: "completed",
      created_at: timestamp,
      events: [{
        run_id: "run-replay",
        sequence: 1,
        timestamp,
        type: "run_started",
        elapsed_ms: 0,
      }, {
        run_id: "run-replay",
        sequence: 2,
        timestamp,
        type: "run_completed",
        elapsed_ms: 42,
      }],
    });
    store.listTraces = async () => {
      throw new Error("run replay must not scan every project trace");
    };

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/runs/run-replay/events`,
      headers: { cookie: cookieHeader, "last-event-id": "1" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      run_id: "run-replay",
      after: 1,
      events: [{
        run_id: "run-replay",
        event_type: "run_completed",
        stage: "run_completed",
        display_stage: "completion",
        kind: "answer",
        label: "已完成",
        status: "completed",
        visible: false,
        timestamp,
        elapsed_ms: 42,
        sequence: 2,
      }],
      next_sequence: 2,
      completed: true,
      has_more: false,
    });
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run event replay paginates complete traces and ignores arbitrary persisted display text", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-run-events-pagination-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: {
        kind: "github",
        value: "https://github.com/example/run-events-pagination",
        title: "事件分页",
        model: "free:deepseek-v4-flash",
      },
    });
    const projectId = (created.json() as { project: { project_id: string } }).project.project_id;
    const ownerId = (guest.json() as { owner_id: string }).owner_id;
    const timestamp = new Date().toISOString();
    const events = Array.from({ length: 501 }, (_, index) => {
      const sequence = index + 1;
      const type = sequence === 1 ? "run_started" : sequence === 501 ? "run_completed" : "thinking_started";
      return {
        run_id: "run-pagination",
        sequence,
        timestamp,
        type,
        stage: type,
        summary: "DO NOT TRUST THIS SUMMARY",
        label: "DO NOT TRUST THIS LABEL",
        text: "DO NOT SHOW THIS INTERNAL REASONING",
        display_stage: "reasoning",
        kind: "commentary",
        status: "running",
        visible: true,
      };
    });
    await store.saveTrace("run-pagination", {
      trace_id: "run-pagination",
      run_id: "run-pagination",
      project_id: projectId,
      owner_id: ownerId,
      event_type: "conversation",
      created_at: timestamp,
      events,
    });

    const first = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/runs/run-pagination/events?limit=500`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json() as {
      events: Array<Record<string, unknown>>;
      next_sequence: number;
      completed: boolean;
      has_more: boolean;
    };
    assert.equal(firstBody.events.length, 500);
    assert.equal(firstBody.next_sequence, 500);
    assert.equal(firstBody.completed, false);
    assert.equal(firstBody.has_more, true);
    assert.equal(firstBody.events[0]?.label, "正在理解问题");
    assert.doesNotMatch(JSON.stringify(firstBody), /DO NOT TRUST|DO NOT SHOW/);

    const second = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/runs/run-pagination/events?after=${firstBody.next_sequence}&limit=500`,
      headers: { cookie: cookieHeader },
    });
    assert.equal(second.statusCode, 200);
    const secondBody = second.json() as {
      events: Array<Record<string, unknown>>;
      next_sequence: number;
      completed: boolean;
      has_more: boolean;
    };
    assert.equal(secondBody.events.length, 1);
    assert.equal(secondBody.events[0]?.sequence, 501);
    assert.equal(secondBody.events[0]?.visible, false);
    assert.equal(secondBody.next_sequence, 501);
    assert.equal(secondBody.completed, true);
    assert.equal(secondBody.has_more, false);
    assert.doesNotMatch(JSON.stringify(secondBody), /DO NOT TRUST|DO NOT SHOW/);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple domestic provider keys expose only their verified models and thinking-only updates keep the model", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-providers-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deepseek.com") && url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("api.moonshot.cn") && url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "kimi-live-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "provider-test",
      display_name: "Provider Test",
      avatar_url: null,
      kind: "github",
    });
    const cookie = guest.headers["set-cookie"];
    assert.ok(cookie);
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(";", 1)[0] : cookie.split(";", 1)[0];
    for (const [provider, connectionId] of [["deepseek", "deepseek-personal"], ["moonshotai-cn", "kimi-personal"]]) {
      const response = await verifyAndAddConnection(app, { cookie: cookieHeader, "content-type": "application/json" }, {
        provider,
        connection_id: connectionId,
        label: connectionId,
        api_key: `key-${connectionId}`,
      });
      assert.equal(response.statusCode, 200);
    }
    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: cookieHeader },
    });
    const settings = settingsResponse.json() as {
      model_options: Array<{
        selector: string;
        connection_id: string;
        thinking_levels: string[];
        thinking_mode?: string;
      }>;
    };
    assert.ok(settings.model_options.some((option) => option.connection_id === "deepseek-personal"));
    assert.ok(settings.model_options.some((option) => option.connection_id === "kimi-personal"));
    const selected = settings.model_options.find((option) => option.connection_id === "deepseek-personal");
    assert.ok(selected);
    assert.equal(selected.thinking_mode, "pi");
    const selectedThinking = selected.thinking_levels.at(-1) ?? "off";
    const choose = await app.inject({
      method: "PUT",
      url: "/api/settings/selection",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { model: selected.selector, thinking_level: selectedThinking },
    });
    assert.equal(choose.statusCode, 200);
    assert.equal((choose.json() as { model: string }).model, selected.selector);
    const thinkingOnly = await app.inject({
      method: "PUT",
      url: "/api/settings/selection",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { thinking_level: "off" },
    });
    assert.equal(thinkingOnly.statusCode, 200);
    assert.equal((thinkingOnly.json() as { model: string }).model, selected.selector);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("new connection verification does not save until the signed result is added", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-provider-verification-flow-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("api.deepseek.com") && String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-5.4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "provider-verification-flow",
      display_name: "Provider Verification Flow",
      avatar_url: null,
      kind: "github",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const headers = { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" };
    const payload = { provider: "deepseek", label: "只验证不保存", api_key: "flow-key" };

    const verified = await app.inject({
      method: "POST",
      url: "/api/settings/connections/verify",
      headers,
      payload,
    });
    assert.equal(verified.statusCode, 200);
    const verification = verified.json() as { ok: boolean; verification_token?: string; models: string[] };
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.models, ["gpt-5.4"]);
    assert.ok(verification.verification_token);
    assert.equal((await store.loadSettings(identity.owner_id)).connections.length, 0);
    assert.equal(store.keys.get(identity.owner_id, "flow-key"), null);

    const changed = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers,
      payload: { ...payload, label: "验证后改名", verification_token: verification.verification_token },
    });
    assert.equal(changed.statusCode, 409);
    assert.equal((await store.loadSettings(identity.owner_id)).connections.length, 0);
    assert.equal(store.keys.get(identity.owner_id, "flow-key"), null);

    const added = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers,
      payload: { ...payload, verification_token: verification.verification_token },
    });
    assert.equal(added.statusCode, 200);
    assert.equal((await store.loadSettings(identity.owner_id)).connections[0]?.label, "只验证不保存");
    assert.equal(store.keys.get(identity.owner_id, "flow-key"), null, "vault lookup is keyed by connection id");
    const saved = await store.loadSettings(identity.owner_id);
    const savedId = saved.connections[0]?.connection_id;
    assert.ok(savedId);
    assert.equal(store.keys.get(identity.owner_id, savedId!), "flow-key");
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("provider model discovery filters task-specific models before saving a connection", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-provider-model-filter-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("ark.cn-beijing.volces.com") && String(input).endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "doubao-pro-chat" },
            { id: "deepseek-vl2" },
            { id: "doubao-seedance-1.0" },
            { id: "doubao-seedream-4.0" },
            { id: "hunyuan-video" },
            { id: "hunyuan-music-generation" },
            { id: "bge-embedding-v1" },
            { id: "hy-3d-3.1" },
            { id: "yt-video-humanactor" },
            { id: "cogView-4-250304" },
            { id: "speech-2.6-hd" },
            { id: "Qwen/Qwen-Image" },
            { id: "vendor/seedance-2.0" },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "provider-model-filter",
      display_name: "Provider Model Filter",
      avatar_url: null,
      kind: "github",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const headers = { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" };
    const payload = { provider: "doubao", label: "模型过滤", api_key: "filter-key" };

    const verified = await app.inject({
      method: "POST",
      url: "/api/settings/connections/verify",
      headers,
      payload,
    });
    assert.equal(verified.statusCode, 200);
    const verification = verified.json() as { ok: boolean; models: string[]; message: string; verification_token: string };
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.models, ["doubao-pro-chat", "deepseek-vl2"]);
    assert.match(verification.message, /2 个可对话模型/u);

    const added = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers,
      payload: { ...payload, verification_token: verification.verification_token },
    });
    assert.equal(added.statusCode, 200);
    const settings = added.json() as { providers: Array<{ custom_models: string[] }> };
    assert.deepEqual(settings.providers[0]?.custom_models, ["doubao-pro-chat", "deepseek-vl2"]);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("manual model proof supports unlisted models, rejects unverified changes and preserves models on refresh failure", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  let calls = 0;
  let discoveryFails = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/models')) {
      return discoveryFails ? new Response(null, { status: 503 })
        : Response.json({ data: [{ id: 'deepseek-v4-flash' }, { id: 'old-chat', status: 'Shutdown' }] });
    }
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-unlisted-preview');
    assert.equal(body.max_tokens, 1024);
    const content = new Headers(init?.headers).get('authorization')?.includes('invalid-key') ? '' : 'OK';
    return new Response([
      { id: 'probe', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
      { id: 'probe', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 } },
    ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const root = await mkdtemp(join(tmpdir(), 'what-the-repo-manual-model-'));
  const store = new FileStore(root);
  await store.init();
  const app = buildApp({ config: config(root), store, sessions: new PiSessionStore(join(root, 'sessions')), memories: new PiMemoryStore(join(root, 'memory')) });
  try {
    await app.ready();
    const guest = await app.inject({ method: 'POST', url: '/api/auth/guest' });
    const owner = guest.json();
    await store.saveUser(owner.owner_id, { ...owner, kind: 'github' });
    const headers = { cookie: `what_the_repo_identity=${cookieValue(guest.headers['set-cookie'], 'what_the_repo_identity')}` };
    const input = { provider: 'deepseek', label: 'Manual', api_key: 'valid-key', model_id: 'deepseek-unlisted-preview' };
    const rejected = await app.inject({ method: 'POST', url: '/api/settings/connections/verify', headers, payload: { ...input, api_key: 'invalid-key' } });
    assert.equal(rejected.json().ok, false);
    assert.equal(rejected.json().verification_token, undefined);
    const verified = await app.inject({ method: 'POST', url: '/api/settings/connections/verify', headers, payload: input });
    assert.equal(verified.json().ok, true, verified.body);
    assert.equal(calls, 2);
    const proof = verified.json().verification_token;
    assert.deepEqual(verified.json().models, ['deepseek-unlisted-preview']);
    assert.equal((await store.loadSettings(owner.owner_id)).connections.length, 0);
    const add = (models: string[], override = {}) => app.inject({ method: 'POST', url: '/api/settings/connections', headers, payload: { ...input, verification_token: proof, models, ...override } });
    assert.equal((await add([])).statusCode, 400);
    assert.equal((await add(['never-verified'])).statusCode, 409);
    assert.equal((await add(['deepseek-unlisted-preview'], { api_key: 'changed-key' })).statusCode, 409);
    const added = await add(['deepseek-unlisted-preview']);
    assert.equal(added.statusCode, 200, added.body);
    const connection = added.json().providers[0];
    assert.equal(connection.models_source, 'verified');
    assert.equal(calls, 2, 'Saving must not call the model again');
    const id = connection.connection_id;
    const refreshed = await app.inject({ method: 'POST', url: `/api/settings/connections/${id}/verify`, headers });
    assert.equal(refreshed.json().ok, true);
    assert.deepEqual(refreshed.json().models, ['deepseek-unlisted-preview', 'deepseek-v4-flash']);
    const update = (models: string[]) => app.inject({ method: 'PATCH', url: `/api/settings/connections/${id}`, headers, payload: { models } });
    assert.equal((await update(['never-verified'])).statusCode, 409);
    assert.equal((await update([])).statusCode, 400);
    assert.equal((await update(['deepseek-unlisted-preview'])).statusCode, 200);
    discoveryFails = true;
    const failed = await app.inject({ method: 'POST', url: `/api/settings/connections/${id}/verify`, headers });
    assert.equal(failed.json().ok, false);
    const settings = await app.inject({ method: 'GET', url: '/api/settings', headers });
    assert.deepEqual(settings.json().providers[0].custom_models, ['deepseek-unlisted-preview']);
    assert.equal(calls, 2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refresh revokes stopped cached models without deleting keys or restoring them from draft proofs", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  let rows = [{ id: "active", status: "online" }, { id: "removed", status: "Shutdown" }];
  let fail = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://relay.example/v1/models");
    assert.ok(!init?.method || init.method === "GET", "No inference requests");
    return fail ? new Response(null, { status: 503 }) : Response.json({ data: rows });
  });
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-retired-models-"));
  const store = new FileStore(root);
  await store.init();
  const app = buildApp({ config: config(root), store, sessions: new PiSessionStore(join(root, "sessions")), memories: new PiMemoryStore(join(root, "memory")) });
  try {
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const owner = guest.json();
    await store.saveUser(owner.owner_id, { ...owner, kind: "github" });
    const headers = { cookie: `what_the_repo_identity=${cookieValue(guest.headers["set-cookie"], "what_the_repo_identity")}` };
    const saved = await store.loadSettings(owner.owner_id);
    const connection = { connection_id: "live", provider: "custom" as const, label: "Live", base_url: "https://relay.example/v1",
      custom_models: ["active", "removed", "unlisted-manual"], manually_verified_models: ["removed", "unlisted-manual"],
      models_source: "verified" as const, last_verified_at: "2026-09-01T00:00:00Z", verify_error: null };
    saved.connections = [connection, { ...connection, connection_id: "retired", provider: "hunyuan-tokenhub-api-cn", base_url: null, custom_models: ["qwen3.5-plus", "hy-mt2-pro"] }];
    await store.saveSettings(owner.owner_id, saved);
    await store.keys.set(owner.owner_id, "fake-key", "live");
    await store.keys.set(owner.owner_id, "fake-key", "retired");
    const settings = () => app.inject({ method: "GET", url: "/api/settings", headers });
    const initial = (await settings()).json();
    assert.equal(initial.providers.length, 2);
    assert.deepEqual(initial.providers.find((item: { connection_id: string }) => item.connection_id === "retired").custom_models, []);
    assert.equal(store.keys.get(owner.owner_id, "retired"), "fake-key");
    const refreshed = await app.inject({ method: "POST", url: "/api/settings/connections/live/verify", headers });
    assert.deepEqual(refreshed.json().models, ["unlisted-manual", "active"]);
    const select = await app.inject({ method: "PUT", url: "/api/settings/selection", headers, payload: { model: "provider:live:removed" } });
    assert.equal(select.statusCode, 409);
    rows = [{ id: "active", status: "online" }, { id: "unlisted-manual", status: "discontinued" }];
    const draft = await app.inject({ method: "POST", url: "/api/settings/connections/verify", headers, payload: { existing_connection_id: "live" } });
    assert.deepEqual(draft.json().models, ["active"]);
    const proof = draft.json().verification_token;
    const patch = (models: string[]) => app.inject({ method: "PATCH", url: "/api/settings/connections/live", headers, payload: { models, verification_token: proof } });
    assert.equal((await patch(["active", "unlisted-manual"])).statusCode, 409);
    assert.equal((await patch(["active"])).statusCode, 200);
    fail = true;
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/connections/live/verify", headers })).json().ok, false);
    assert.deepEqual((await store.loadSettings(owner.owner_id)).connections.find(item => item.connection_id === "live")?.custom_models, ["active"]);
    fail = false;
    rows = [{ id: "active", status: "discontinued" }];
    assert.equal((await app.inject({ method: "POST", url: "/api/settings/connections/verify", headers, payload: { existing_connection_id: "live" } })).json().ok, false);
    const final = (await settings()).json();
    assert.equal(final.providers.length, 2);
    assert.deepEqual(final.providers.find((item: { connection_id: string }) => item.connection_id === "live").custom_models, []);
    assert.equal(store.keys.get(owner.owner_id, "live"), "fake-key");
    assert.equal((await patch(["active"])).statusCode, 409, "A proof issued before revocation must not revive a stopped model");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("domestic plan presets use their provider model-list endpoints", async (t) => {
  // The HTTP responses below are mocked; DNS must also be independent of local proxy rules.
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-provider-plans-"));
  const originalFetch = globalThis.fetch;
  try {
    const expected = [
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models",
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models",
      "https://coding.dashscope.aliyuncs.com/v1/models",
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/models",
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/models",
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/models",
      "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1/models",
      "https://api.minimaxi.com/anthropic/v1/models",
      "https://api.minimaxi.com/v1/models",
      "https://api.minimaxi.com/v1/models",
      "https://api.xiaomimimo.com/anthropic/v1/models",
      "https://token-plan-cn.xiaomimimo.com/anthropic/v1/models",
      "https://open.bigmodel.cn/api/anthropic/v1/models",
      "https://api.kimi.com/coding/v1/models",
      "https://ark.cn-beijing.volces.com/api/coding/v3/models",
      "https://ark.cn-beijing.volces.com/api/plan/v3/models",
      "https://tokenhub.tencentmaas.com/v1/models",
      "https://tokenhub.tencentmaas.com/v1/models",
      "https://api.lkeap.cloud.tencent.com/plan/v3/models",
      "https://tokenhub.tencentmaas.com/plan/v3/models",
      "https://api.lkeap.cloud.tencent.com/coding/v3/models",
    ];
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (expected.includes(url)) {
        seen.push(url);
        if (url.includes("api.minimaxi.com/anthropic")) {
          const requestHeaders = new Headers(init?.headers);
           assert.match(requestHeaders.get("x-api-key") ?? "", /^plan-key-/u);
           assert.match(requestHeaders.get("authorization") ?? "", /^Bearer plan-key-/u);
          assert.equal(requestHeaders.get("anthropic-version"), "2023-06-01");
        }
        if (url.includes("xiaomimimo.com")) {
          const requestHeaders = new Headers(init?.headers);
          if (url.includes("/anthropic/")) {
            assert.match(requestHeaders.get("x-api-key") ?? "", /^plan-key-/u);
            assert.equal(requestHeaders.get("anthropic-version"), "2023-06-01");
          } else {
            assert.match(requestHeaders.get("api-key") ?? "", /^plan-key-/u);
          }
        }
        if (url === "https://tokenhub.tencentmaas.com/v1/models") {
          const requestHeaders = new Headers(init?.headers);
          assert.match(requestHeaders.get("authorization") ?? "", /^Bearer plan-key-/u);
        }
        return new Response(JSON.stringify({ data: [{ id: `live-${seen.length}`, output_modalities: ["text"] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "provider-plan-endpoints",
      display_name: "Provider Plan Endpoints",
      avatar_url: null,
      kind: "github",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const headers = { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" };
    const initialSettings = await app.inject({ method: "GET", url: "/api/settings", headers });
    assert.equal(initialSettings.statusCode, 200);
    const initialPresets = (initialSettings.json() as { provider_presets: Array<Record<string, unknown>> }).provider_presets;
    assert.equal(initialPresets.some((preset) => "compat" in preset), false);
    assert.equal(initialPresets.some((preset) => "authHeader" in preset), false);
    const providers = [
      "qwen-token-plan-personal-cn",
      "qwen-token-plan-team-cn",
      "qwen-coding-plan-cn",
      "qwen-token-plan-anthropic-cn",
      "qwen-token-plan-personal-anthropic-cn",
      "qwen-token-plan-team-anthropic-cn",
      "qwen-coding-plan-anthropic-cn",
      "minimax-token-plan-cn",
      "minimax-openai-cn",
      "minimax-token-plan-openai-cn",
      "xiaomi-anthropic-cn",
      "xiaomi-token-plan-anthropic-cn",
      "zai-anthropic-cn",
      "kimi-coding-openai",
      "doubao-coding-plan-cn",
      "doubao-agent-plan-cn",
      "hunyuan-tokenhub-api-cn",
      "hunyuan-tokenhub-anthropic-cn",
      "hunyuan-token-plan-cn",
      "hunyuan-token-plan-enterprise-cn",
      "hunyuan-coding-plan-cn",
    ] as const;
    for (const [index, provider] of providers.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/api/settings/connections/verify",
        headers,
        payload: { provider, label: `方案-${index}`, api_key: `plan-key-${index}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as { ok: boolean }).ok, true, provider);
    }
    assert.deepEqual(seen, expected);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("custom Provider settings reject private endpoints before storing the user key", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-provider-ssrf-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "provider-ssrf-test",
      display_name: "Provider SSRF Test",
      avatar_url: null,
      kind: "github",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const response = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers: { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" },
      payload: {
        provider: "custom",
        connection_id: "private-endpoint",
        base_url: "https://127.0.0.1.nip.io/v1",
        models: ["local-model"],
        api_key: "must-not-be-stored",
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(store.keys.get(identity.owner_id, "private-endpoint"), null);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("domestic Provider settings require an upstream model list and reject connection edits", async (t) => {
  t.mock.method(dns, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-domestic-providers-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("ark.cn-beijing.volces.com") && url.endsWith("/models")) {
        return new Response(null, { status: 404 });
      }
      if (url.includes("api.deepseek.com") && url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-live-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "domestic-provider-test",
      display_name: "Domestic Provider Test",
      avatar_url: null,
      kind: "github",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const headers = { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" };

    const missingModel = await app.inject({
      method: "POST",
      url: "/api/settings/connections/verify",
      headers,
      payload: {
        provider: "doubao",
        connection_id: "doubao-missing-model",
        base_url: "https://attacker.example/v1",
        api_key: "fake-doubao-key",
      },
    });
    assert.equal(missingModel.statusCode, 200);
    assert.equal((missingModel.json() as { ok: boolean }).ok, false);
    assert.equal(store.keys.get(identity.owner_id, "doubao-missing-model"), null);

    const unverifiedAdd = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers,
      payload: {
        provider: "doubao",
        connection_id: "doubao-missing-model",
        base_url: "https://attacker.example/v1",
        api_key: "fake-doubao-key",
      },
    });
    assert.equal(unverifiedAdd.statusCode, 409);
    assert.equal(store.keys.get(identity.owner_id, "doubao-missing-model"), null);

    await store.saveSettings(identity.owner_id, {
      model: "provider:stale-connection:hunyuan-pro",
      thinking_level: "medium",
      connections: [{
        connection_id: "stale-connection",
        provider: "hunyuan",
        label: "旧失败连接",
        base_url: null,
        custom_models: ["hunyuan-pro", "hunyuan-turbos-latest"],
        models_source: null,
        last_verified_at: null,
        verify_error: "验证失败：API Key 或接口权限不正确",
      }],
    });
    await store.keys.set(identity.owner_id, "stale-key", "stale-connection");
    const cleaned = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `what_the_repo_identity=${cookie}` },
    });
    assert.equal(cleaned.statusCode, 200);
    const cleanedSettings = cleaned.json() as {
      providers: Array<{ connection_id: string }>;
      model_options: Array<{ connection_id: string; model_id: string }>;
    };
    assert.equal(cleanedSettings.providers.some((row) => row.connection_id === "stale-connection"), false);
    assert.equal(cleanedSettings.model_options.some((row) => row.connection_id === "stale-connection"), false);
    assert.equal(store.keys.get(identity.owner_id, "stale-connection"), null);
    assert.equal((await store.loadSettings(identity.owner_id)).connections.some((row) => row.connection_id === "stale-connection"), false);

    const retiredProvider = await app.inject({
      method: "POST",
      url: "/api/settings/connections",
      headers,
      payload: {
        provider: "zai",
        connection_id: "retired-zai",
        api_key: "retired-key",
      },
    });
    assert.equal(retiredProvider.statusCode, 400);
    assert.equal(store.keys.get(identity.owner_id, "retired-zai"), null);

    const created = await verifyAndAddConnection(app, headers, {
      provider: "deepseek",
      connection_id: "domestic-switch",
      label: "同一个连接",
      base_url: "https://attacker.example/v1",
      api_key: "fake-deepseek-key",
    });
    assert.equal(created.statusCode, 200);
    const createdSettings = created.json() as {
      model: string;
      providers: Array<{ connection_id: string; provider: string; base_url: string | null; custom_models: string[]; last_verified_at: string | null }>;
      provider_presets: Array<{ id: string }>;
    };
    assert.equal(createdSettings.providers.find((row) => row.connection_id === "domestic-switch")?.base_url, "https://api.deepseek.com");
    assert.equal(createdSettings.provider_presets.some((row) => ["openai", "anthropic", "google", "xai"].includes(row.id)), false);
    assert.match(createdSettings.model, /^provider:domestic-switch:/);

    const createdConnection = createdSettings.providers.find((row) => row.connection_id === "domestic-switch");
    assert.ok(createdConnection);
    const verifiedAt = createdConnection?.last_verified_at;
    assert.ok(verifiedAt);
    const savedWithoutChanges = await app.inject({
      method: "PATCH",
      url: "/api/settings/connections/domestic-switch",
      headers,
      payload: {
        provider: "deepseek",
        label: "changed-label",
      },
    });
    assert.equal(savedWithoutChanges.statusCode, 405);
    const afterRejectedPatch = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `what_the_repo_identity=${cookie}` },
    });
    assert.equal(afterRejectedPatch.statusCode, 200);
    const unchangedSettings = afterRejectedPatch.json() as {
      providers: Array<{ connection_id: string; last_verified_at: string | null; custom_models: string[] }>;
      model_options: Array<{ connection_id: string }>;
    };
    const unchangedConnection = unchangedSettings.providers.find((row) => row.connection_id === "domestic-switch");
    assert.equal(unchangedConnection?.last_verified_at, verifiedAt);
    assert.deepEqual(unchangedConnection?.custom_models, ["deepseek-live-model"]);
    assert.ok(unchangedSettings.model_options.some((option) => option.connection_id === "domestic-switch"));

    const duplicateName = await app.inject({
      method: "POST",
      url: "/api/settings/connections/verify",
      headers,
      payload: {
        provider: "deepseek",
        label: " 同一个连接 ",
        api_key: "another-key",
      },
    });
    assert.equal(duplicateName.statusCode, 409);
    assert.match(String((duplicateName.json() as { detail?: string }).detail), /连接名称已存在/);

    const rejectedPut = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers,
      payload: {
        connection_id: "domestic-switch",
        provider: "doubao",
        api_key: "replacement-key",
      },
    });
    assert.equal(rejectedPut.statusCode, 405);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("profile summary endpoints sanitize legacy and edited content", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-api-memory-summary-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const memories = new PiMemoryStore(join(root, "pi-memory"));
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories,
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identity = guest.json() as { owner_id: string };
    await store.saveUser(identity.owner_id, {
      ...identity,
      login: "memory-summary-test",
      display_name: "Memory Summary Test",
      avatar_url: null,
      kind: "github",
    });
    await store.saveProfile(identity.owner_id, {
      ...emptyProfile(),
      memory_summary_mode: "edited",
      memory_summary: "旧 api_key=sk-legacy-secret；token=legacy-token-value",
    });
    const cookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const headers = { cookie: `what_the_repo_identity=${cookie}`, "content-type": "application/json" };

    const loaded = await app.inject({ method: "GET", url: "/api/profile", headers });
    assert.equal(loaded.statusCode, 200);
    const loadedProfile = (loaded.json() as { profile: { memory_summary: string; memory_summary_mode: string } }).profile;
    assert.equal(loadedProfile.memory_summary, "旧 [已隐藏]；[已隐藏]");
    assert.equal(loadedProfile.memory_summary_mode, "edited");

    const edited = await app.inject({
      method: "PUT",
      url: "/api/profile/summary",
      headers,
      payload: { summary: "保留 api_key=sk-first-secret 和 password=second-secret" },
    });
    assert.equal(edited.statusCode, 200);
    const editedProfile = (edited.json() as { profile: { memory_summary: string; memory_summary_mode: string } }).profile;
    assert.equal(editedProfile.memory_summary, "保留 [已隐藏] 和 [已隐藏]");
    assert.equal(editedProfile.memory_summary_mode, "edited");

    const regenerated = await app.inject({
      method: "POST",
      url: "/api/profile/summary/regenerate",
      headers: { cookie: headers.cookie },
    });
    assert.equal(regenerated.statusCode, 200);
    const regeneratedProfile = (regenerated.json() as { profile: { memory_summary_mode: string } }).profile;
    assert.equal(regeneratedProfile.memory_summary_mode, "generated");
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth gateway accepts a bound identity ticket and rejects its replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-gateway-"));
  const originalFetch = globalThis.fetch;
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: githubGatewayConfig(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    globalThis.fetch = (async () => {
      throw new Error("gateway OAuth must not contact GitHub from the application API");
    }) as typeof fetch;

    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const guestIdentity = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const started = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?return_to=%2Fworkspace",
      headers: { cookie: `what_the_repo_identity=${guestIdentity}` },
    });
    assert.equal(started.statusCode, 302);
    const gatewayLocation = new URL(String(started.headers.location));
    assert.equal(gatewayLocation.origin + gatewayLocation.pathname, "https://github.example.com/oauth/github/start");
    const grant = parseGithubGatewayStartGrant(
      gatewayLocation.searchParams.get("request") ?? "",
      githubGatewayConfig(root).githubGatewaySharedSecret!,
    );
    assert.ok(grant);
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    const ticket = signGithubGatewayPayload({
      version: 1,
      kind: "github_oauth_result",
      outcome: "success",
      nonce: grant!.nonce,
      ticket_id: "abcdef12-1234-1234-1234-123456789012",
      issued_at: Date.now(),
      expires_at: Date.now() + 60_000,
      github: {
        id: 42,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/583231",
      },
    }, githubGatewayConfig(root).githubGatewaySharedSecret!);
    const callbackHeaders = {
      cookie: `what_the_repo_identity=${guestIdentity}; what_the_repo_oauth_state=${stateCookie}`,
    };
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?ticket=${encodeURIComponent(ticket)}`,
      headers: callbackHeaders,
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(new URL(String(callback.headers.location)).pathname, "/workspace");
    const githubIdentity = cookieValue(callback.headers["set-cookie"], "what_the_repo_identity");
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `what_the_repo_identity=${githubIdentity}` },
    });
    assert.equal((me.json() as { owner_id: string }).owner_id, "github:42");

    const replay = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?ticket=${encodeURIComponent(ticket)}`,
      headers: callbackHeaders,
    });
    assert.equal(replay.statusCode, 400);
    assert.equal((replay.json() as { code: string }).code, "github_oauth_ticket_replayed");
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth gateway rejects a ticket issued for another browser nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-gateway-nonce-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const configured = githubGatewayConfig(root);
    const app = buildApp({
      config: configured,
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const started = await app.inject({ method: "GET", url: "/api/auth/github/start" });
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    const ticket = signGithubGatewayPayload({
      version: 1,
      kind: "github_oauth_result",
      outcome: "success",
      nonce: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ticket_id: "abcdef12-1234-1234-1234-123456789012",
      issued_at: Date.now(),
      expires_at: Date.now() + 60_000,
      github: { id: 42, login: "octocat", name: null, avatar_url: null },
    }, configured.githubGatewaySharedSecret!);
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?ticket=${encodeURIComponent(ticket)}`,
      headers: { cookie: `what_the_repo_oauth_state=${stateCookie}` },
    });
    assert.equal(callback.statusCode, 400);
    assert.equal((callback.json() as { code: string }).code, "github_oauth_ticket_invalid");
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth rejects a tampered state cookie before exchanging the code", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-tamper-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: githubConfig(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identityCookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const started = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?return_to=%2Fprojects",
      headers: { cookie: `what_the_repo_identity=${identityCookie}` },
    });
    assert.equal(started.statusCode, 302);
    const location = new URL(String(started.headers.location));
    const nonce = location.searchParams.get("state");
    assert.ok(nonce);
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    const tampered = `${stateCookie.slice(0, -1)}${stateCookie.endsWith("a") ? "b" : "a"}`;
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=test-code&state=${encodeURIComponent(nonce!)}`,
      headers: {
        cookie: `what_the_repo_identity=${identityCookie}; what_the_repo_oauth_state=${tampered}`,
      },
    });
    assert.equal(callback.statusCode, 400);
    assert.equal((callback.json() as { code: string }).code, "invalid_request");
    assert.match((callback.json() as { detail: string }).detail, /状态已失效/);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth rejects an expired signed state cookie", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-expired-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: githubConfig(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const identityCookie = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const ownerId = (guest.json() as { owner_id: string }).owner_id;
    const nonce = "01234567-89ab-cdef-0123-456789abcdef";
    const stateCookie = signOAuthCookie({
      nonce,
      owner_id: ownerId,
      return_to: "/",
      issued_at: Date.now() - 11 * 60 * 1000,
    }, "test-session-secret");
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=test-code&state=${nonce}`,
      headers: {
        cookie: `what_the_repo_identity=${identityCookie}; what_the_repo_oauth_state=${stateCookie}`,
      },
    });
    assert.equal(callback.statusCode, 400);
    assert.match((callback.json() as { detail: string }).detail, /状态已失效/);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth rejects a callback made with a different guest owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-owner-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: githubConfig(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    const first = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const second = await app.inject({ method: "POST", url: "/api/auth/guest" });
    const firstIdentity = cookieValue(first.headers["set-cookie"], "what_the_repo_identity");
    const secondIdentity = cookieValue(second.headers["set-cookie"], "what_the_repo_identity");
    const started = await app.inject({
      method: "GET",
      url: "/api/auth/github/start",
      headers: { cookie: `what_the_repo_identity=${firstIdentity}` },
    });
    const location = new URL(String(started.headers.location));
    const nonce = location.searchParams.get("state");
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    assert.ok(nonce);
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=test-code&state=${encodeURIComponent(nonce!)}`,
      headers: {
        cookie: `what_the_repo_identity=${secondIdentity}; what_the_repo_oauth_state=${stateCookie}`,
      },
    });
    assert.equal(callback.statusCode, 400);
    assert.match((callback.json() as { detail: string }).detail, /浏览器不匹配/);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth maps an unavailable token endpoint to a retryable 502", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-network-"));
  const originalFetch = globalThis.fetch;
  try {
    const store = new FileStore(root);
    await store.init();
    const app = buildApp({
      config: githubConfig(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
    });
    await app.ready();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://github.com/login/oauth/access_token") {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    const started = await app.inject({ method: "GET", url: "/api/auth/github/start" });
    const location = new URL(String(started.headers.location));
    const nonce = location.searchParams.get("state");
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    assert.ok(nonce);
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=test-code&state=${encodeURIComponent(nonce!)}`,
      headers: { cookie: `what_the_repo_oauth_state=${stateCookie}` },
    });
    assert.equal(callback.statusCode, 502);
    assert.deepEqual(callback.json(), {
      detail: "GitHub 登录服务暂时不可用，请稍后重试。",
      code: "github_oauth_unavailable",
    });
    assert.equal(callback.headers["set-cookie"], undefined);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub OAuth merges guest-owned records and rebuilds the Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-oauth-merge-"));
  const originalFetch = globalThis.fetch;
  try {
    const store = new FileStore(root);
    await store.init();
    const sessions = new PiSessionStore(join(root, "pi-sessions"));
    const memories = new PiMemoryStore(join(root, "pi-memory"));
    const app = buildApp({
      config: githubConfig(root),
      store,
      sessions,
      memories,
    });
    await app.ready();

    const guest = await app.inject({ method: "POST", url: "/api/auth/guest" });
    assert.equal(guest.statusCode, 200);
    const sourceOwnerId = (guest.json() as { owner_id: string }).owner_id;
    const sourceIdentity = cookieValue(guest.headers["set-cookie"], "what_the_repo_identity");
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: `what_the_repo_identity=${sourceIdentity}`, "content-type": "application/json" },
      payload: {
        kind: "github",
        value: "https://github.com/example/merge-repo",
        title: "待归并项目",
        model: "free:deepseek-v4-flash",
      },
    });
    assert.equal(projectResponse.statusCode, 201);
    const projectId = (projectResponse.json() as { project: { project_id: string } }).project.project_id;
    const project = await store.loadProject(projectId, sourceOwnerId);
    assert.ok(project);
    project.analysis.snapshot_id = "snapshot:merge";
    project.analysis.stage = "done";
    project.source.commit_sha = "commit-old";
    const userMessage = createMessage("user", "请解释入口。", { analysis_commit_sha: "commit-old" });
    const assistantMessage = createMessage("assistant", "入口负责启动分析。", {
      analysis_snapshot_id: "snapshot:merge",
      analysis_commit_sha: "commit-old",
      trace_id: "trace-merge",
    });
    project.messages.push(userMessage, assistantMessage);
    await store.saveProject(project);

    const targetOwnerId = "github:42";
    await store.saveUser(targetOwnerId, {
      owner_id: targetOwnerId,
      login: "octo",
      display_name: "Octo",
      avatar_url: "https://avatars.example/42.png",
      kind: "github",
    });
    await store.keys.set(sourceOwnerId, "source-provider-key");
    await store.keys.set(targetOwnerId, "target-provider-key");
    const sourceProfile = emptyProfile();
    sourceProfile.goals = ["source-goal"];
    sourceProfile.explanation_preference = "先讲原理";
    sourceProfile.inferred = [{
      claim_id: "claim-source",
      claim: "熟悉 C++",
      confidence: 0.7,
      evidence: "source message",
      observed_at: "2026-08-20T00:00:00.000Z",
      source_project_id: projectId,
    }];
    await store.saveProfile(sourceOwnerId, sourceProfile);
    const targetProfile = emptyProfile();
    targetProfile.goals = ["target-goal"];
    targetProfile.explanation_preference = "先给结论";
    targetProfile.experience_level = "初学者";
    await store.saveProfile(targetOwnerId, targetProfile);

    await memories.upsert({
      memoryId: "memory:source-only",
      ownerId: sourceOwnerId,
      scope: "user",
      key: "source-only",
      value: "来源记忆",
      sourceMessageIds: [userMessage.message_id],
      confidence: 0.8,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await memories.upsert({
      memoryId: "memory:source-shared",
      ownerId: sourceOwnerId,
      scope: "user",
      key: "shared",
      value: "来源版本",
      sourceMessageIds: [],
      confidence: 0.5,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    await memories.upsert({
      memoryId: "memory:target-shared",
      ownerId: targetOwnerId,
      scope: "user",
      key: "shared",
      value: "目标版本",
      sourceMessageIds: [],
      confidence: 0.9,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });

    const oldIdentity = {
      sessionId: projectSessionId(sourceOwnerId, projectId, project.analysis.snapshot_id),
      ownerId: sourceOwnerId,
      projectId,
      snapshotId: project.analysis.snapshot_id,
      skillId: "primary-conversational-supervisor",
      skillVersion: "test",
    } as const;
    await sessions.rebuildFromMessages(oldIdentity, [{ role: "user", content: "旧 Session 内容" }]);
    await store.saveTrace("trace-merge", {
      trace_id: "trace-merge",
      owner_id: sourceOwnerId,
      project_id: projectId,
    });
    await store.saveEvolutionFeedbackRequest({
      request_id: "feedback-merge",
      dedupe_key: "feedback-merge-key",
      trigger: "human_feedback",
      skill_ids: ["primary-conversational-supervisor"],
      reasons: ["source reason"],
      strengths: [],
      source_trace_ids: ["trace-merge"],
      source_message_ids: [assistantMessage.message_id],
      sample_count: 1,
      owner_ids: [sourceOwnerId],
      owner_id: sourceOwnerId,
      status: "pending",
      task_ids: [],
      task_id: null,
      created_at: "2026-08-21T00:00:00.000Z",
      updated_at: "2026-08-21T00:00:00.000Z",
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "token-42" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 42, login: "octo", name: "Octo", avatar_url: "https://avatars.example/42.png" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const started = await app.inject({
      method: "GET",
      url: "/api/auth/github/start?return_to=%2Fworkspace",
      headers: { cookie: `what_the_repo_identity=${sourceIdentity}` },
    });
    assert.equal(started.statusCode, 302);
    const location = new URL(String(started.headers.location));
    const nonce = location.searchParams.get("state");
    assert.ok(nonce);
    const stateCookie = cookieValue(started.headers["set-cookie"], "what_the_repo_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/github/callback?code=test-code&state=${encodeURIComponent(nonce!)}`,
      headers: {
        cookie: `what_the_repo_identity=${sourceIdentity}; what_the_repo_oauth_state=${stateCookie}`,
      },
    });
    assert.equal(callback.statusCode, 302);
    assert.match(String(callback.headers.location), /merged=1/);
    const targetIdentity = cookieValue(callback.headers["set-cookie"], "what_the_repo_identity");

    const mergedProject = await store.loadProject(projectId, targetOwnerId);
    assert.ok(mergedProject);
    assert.equal(mergedProject.messages.length, 2);
    assert.equal((await store.loadProject(projectId, sourceOwnerId)), null);
    const mergedProfile = await store.loadProfile(targetOwnerId);
    assert.deepEqual(mergedProfile.goals.sort(), ["source-goal", "target-goal"]);
    assert.equal(mergedProfile.explanation_preference, "先给结论");
    assert.equal(mergedProfile.experience_level, "初学者");
    const mergedMemories = await memories.list(targetOwnerId);
    assert.equal(mergedMemories.find((row) => row.key === "shared")?.value, "目标版本");
    assert.equal(mergedMemories.some((row) => row.key === "source-only"), true);
    assert.equal(store.keys.get(targetOwnerId), "target-provider-key");
    assert.equal(store.keys.get(sourceOwnerId), null);
    assert.deepEqual(await memories.list(sourceOwnerId), []);
    assert.deepEqual(await sessions.listOwnerSessions(sourceOwnerId), []);
    const newSessionId = projectSessionId(targetOwnerId, projectId, project.analysis.snapshot_id);
    assert.deepEqual(await sessions.listOwnerSessions(targetOwnerId), [{
      sessionId: newSessionId,
      projectId,
      snapshotId: project.analysis.snapshot_id,
    }]);
    const rebuilt = await sessions.snapshot({
      ...oldIdentity,
      ownerId: targetOwnerId,
      sessionId: newSessionId,
    });
    const rebuiltText = JSON.stringify(rebuilt.messages);
    assert.match(rebuiltText, /请解释入口。/);
    assert.match(rebuiltText, /入口负责启动分析。/);
    assert.equal((await store.listTraces(projectId))[0]?.owner_id, targetOwnerId);
    const feedback = await store.listEvolutionFeedbackRequests();
    assert.deepEqual(feedback[0]?.owner_ids, [targetOwnerId]);
    assert.equal(await store.loadUser(sourceOwnerId), null);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `what_the_repo_identity=${targetIdentity}` } });
    assert.equal(me.statusCode, 200);
    const mergeSummary = (me.json() as { merge_summary: { projects: number; messages: number; memories: number; sessions: number } | null }).merge_summary;
    assert.deepEqual(mergeSummary && {
      projects: mergeSummary.projects,
      messages: mergeSummary.messages,
      memories: mergeSummary.memories,
      sessions: mergeSummary.sessions,
    }, { projects: 1, messages: 2, memories: 1, sessions: 1 });
    const consumed = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `what_the_repo_identity=${targetIdentity}` } });
    assert.equal((consumed.json() as { merge_summary: unknown }).merge_summary, null);
    await app.close();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
