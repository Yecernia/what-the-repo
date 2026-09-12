import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RestrictedToolDescriptor } from "../src/contracts.js";
import {
  createPiSdkSessionFactory,
  PiBudgetExceededError,
  PiBudgetPreflightError,
} from "../src/pi-sdk.js";

function assistantMessage(usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.00014,
}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function completedStream(message: Record<string, unknown>): {
  result(): Promise<Record<string, unknown>>;
  [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>>;
} {
  return {
    async result() {
      return message;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: "done", message };
    },
  };
}

test("Pi SDK adapter rejects implicit model runtime or model selection", () => {
  assert.throws(
    () => createPiSdkSessionFactory(undefined as never),
    /runtime and model must be injected explicitly/,
  );
  assert.throws(
    () => createPiSdkSessionFactory({ modelRuntime: {}, model: undefined as never }),
    /runtime and model must be injected explicitly/,
  );
});

test("Pi SDK adapter rejects Bedrock before loading the SDK or dispatching a request", () => {
  let sdkLoads = 0;
  const loadSdk = async () => {
    sdkLoads += 1;
    throw new Error("SDK load must not be reached");
  };
  assert.throws(
    () => createPiSdkSessionFactory({
      modelRuntime: {},
      model: { provider: "amazon-bedrock", api: "test" },
      loadSdk,
    }),
    /Bedrock is disabled.*maxAttempts: 1/,
  );
  assert.throws(
    () => createPiSdkSessionFactory({
      modelRuntime: {},
      model: { provider: "custom", api: "bedrock-converse-stream" },
      loadSdk,
    }),
    /Bedrock is disabled.*maxAttempts: 1/,
  );
  assert.equal(sdkLoads, 0);
});

test("Pi SDK adapter caps every model request before provider dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-preflight-"));
  const requestedCaps: number[] = [];
  const model = {
    id: "test-model",
    maxTokens: 50_000,
    contextWindow: 128_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  };
  const modelRuntime = {
    streamSimple(_model: unknown, _context: unknown, options?: Record<string, unknown>) {
      requestedCaps.push(options?.maxTokens as number);
      return completedStream(assistantMessage());
    },
  };
  let capturedRuntime: typeof modelRuntime | undefined;
  const factory = createPiSdkSessionFactory({
    modelRuntime,
    model,
    loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
    loadSdk: async () => ({
      SessionManager: { create: () => ({}), inMemory: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      createExtensionRuntime: () => ({
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
        assertActive() {}, invalidate() {}, trackEventBusSubscription: (unsubscribe: () => void) => unsubscribe,
        registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
      }),
      async createAgentSession(options: Record<string, unknown>) {
        capturedRuntime = options.modelRuntime as typeof modelRuntime;
        return {
          session: {
            sessionId: "preflight-cap",
            async prompt() {
              const stream = capturedRuntime?.streamSimple(model, { messages: [{ role: "user", content: "x" }] });
              for await (const _event of stream as ReturnType<typeof completedStream>) {
                // Drain exactly as the Pi agent loop does.
              }
            },
            getSessionStats() {
              return { sessionId: "preflight-cap", tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, cost: 0.00014 };
            },
          },
        };
      },
    }),
  });
  try {
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      sessionId: "preflight-cap",
      systemPrompt: "restricted",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [],
      budget: { maxTokens: 5_000, maxCostUsd: 1 },
    });
    await session.prompt("probe");
    assert.equal(requestedCaps.length, 1);
    assert.ok(requestedCaps[0] >= 1 && requestedCaps[0] < model.maxTokens);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi SDK adapter fails closed before dispatch when pricing is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-price-"));
  let dispatches = 0;
  const model = { id: "test-model", maxTokens: 1_000, contextWindow: 8_000 };
  const modelRuntime = {
    streamSimple(_model?: unknown, _context?: unknown) {
      dispatches += 1;
      return completedStream(assistantMessage());
    },
  };
  let capturedRuntime: typeof modelRuntime | undefined;
  const factory = createPiSdkSessionFactory({
    modelRuntime,
    model,
    loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
    loadSdk: async () => ({
      SessionManager: { create: () => ({}), inMemory: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      createExtensionRuntime: () => ({
        flagValues: new Map(), pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [],
        assertActive() {}, invalidate() {}, trackEventBusSubscription: (unsubscribe: () => void) => unsubscribe,
        registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
      }),
      async createAgentSession(options: Record<string, unknown>) {
        capturedRuntime = options.modelRuntime as typeof modelRuntime;
        return {
          session: {
            sessionId: "price-missing",
            async prompt() {
              capturedRuntime?.streamSimple(model, { messages: [] });
            },
            getSessionStats() {
              return { sessionId: "price-missing", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
            },
          },
        };
      },
    }),
  });
  try {
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      sessionId: "price-missing",
      systemPrompt: "restricted",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [],
      budget: { maxTokens: 5_000, maxCostUsd: 1 },
    });
    await assert.rejects(() => session.prompt("probe"), /pricing is unavailable/);
    assert.equal(dispatches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi SDK adapter rejects an unaffordable request before provider dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-afford-"));
  let dispatches = 0;
  const model = {
    id: "test-model",
    maxTokens: 1_000,
    contextWindow: 8_000,
    cost: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
  };
  const modelRuntime = {
    streamSimple(_model?: unknown, _context?: unknown) {
      dispatches += 1;
      return completedStream(assistantMessage());
    },
  };
  let capturedRuntime: typeof modelRuntime | undefined;
  const factory = createPiSdkSessionFactory({
    modelRuntime,
    model,
    loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
    loadSdk: async () => ({
      SessionManager: { create: () => ({}), inMemory: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      createExtensionRuntime: () => ({
        flagValues: new Map(), pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [],
        assertActive() {}, invalidate() {}, trackEventBusSubscription: (unsubscribe: () => void) => unsubscribe,
        registerProvider() {}, registerNativeProvider() {}, unregisterProvider() {},
      }),
      async createAgentSession(options: Record<string, unknown>) {
        capturedRuntime = options.modelRuntime as typeof modelRuntime;
        return {
          session: {
            sessionId: "unaffordable",
            async prompt() {
              capturedRuntime?.streamSimple(model, { messages: [{ role: "user", content: "hello" }] });
            },
            getSessionStats() {
              return { sessionId: "unaffordable", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
            },
          },
        };
      },
    }),
  });
  try {
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      sessionId: "unaffordable",
      systemPrompt: "restricted",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [],
      budget: { maxTokens: 5_000, maxCostUsd: 0.00001 },
    });
    await assert.rejects(() => session.prompt("probe"), PiBudgetPreflightError);
    assert.equal(dispatches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function budgetProbe(
  budget: { maxTokens: number; maxCostUsd: number },
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
): Promise<{ aborted: boolean; error: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-budget-"));
  let aborted = false;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const factory = createPiSdkSessionFactory({
    modelRuntime: { kind: "test-runtime" },
    model: {
      id: "test-model",
      maxTokens: 4_096,
      contextWindow: 16_384,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
    loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
    loadSdk: async () => ({
      SessionManager: {
        create: () => ({}),
        inMemory: () => ({}),
      },
      SettingsManager: { inMemory: () => ({}) },
      createExtensionRuntime: () => ({
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
        assertActive() {},
        invalidate() {},
        trackEventBusSubscription(unsubscribe: () => void) {
          return unsubscribe;
        },
        registerProvider() {},
        registerNativeProvider() {},
        unregisterProvider() {},
      }),
      async createAgentSession() {
        return {
          session: {
            sessionId: "budget-probe",
            subscribe(next: (event: Record<string, unknown>) => void) {
              listener = next;
              return () => {};
            },
            async prompt() {
              listener?.({
                type: "message_end",
                message: {
                  role: "assistant",
                  usage: {
                    input: usage.input,
                    output: usage.output,
                    cacheRead: usage.cacheRead,
                    cacheWrite: usage.cacheWrite,
                    cost: { total: usage.cost },
                  },
                },
              });
            },
            async abort() {
              aborted = true;
            },
            getSessionStats() {
              return {
                sessionId: "budget-probe",
                tokens: {
                  input: usage.input,
                  output: usage.output,
                  cacheRead: usage.cacheRead,
                  cacheWrite: usage.cacheWrite,
                },
                cost: usage.cost,
              };
            },
          },
        };
      },
    }),
  });
  try {
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      sessionId: "budget-probe",
      systemPrompt: "restricted",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [],
      budget,
    });
    let error: unknown;
    try {
      await session.prompt("probe");
    } catch (caught) {
      error = caught;
    }
    return { aborted, error };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Pi SDK adapter aborts at the assistant response boundary when tokens exceed budget", async () => {
  const result = await budgetProbe(
    { maxTokens: 10, maxCostUsd: 1 },
    { input: 6, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  );
  assert.equal(result.aborted, true);
  assert.ok(result.error instanceof PiBudgetExceededError);
  assert.match((result.error as Error).message, /token budget exceeded/);
});

test("Pi SDK adapter aborts at the assistant response boundary when cost exceeds budget", async () => {
  const result = await budgetProbe(
    { maxTokens: 100, maxCostUsd: 0.01 },
    { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02 },
  );
  assert.equal(result.aborted, true);
  assert.ok(result.error instanceof PiBudgetExceededError);
  assert.match((result.error as Error).message, /cost budget exceeded/);
});

test("Pi SDK adapter disables discovered resources and exposes only restricted tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-sdk-"));
  let captured: Record<string, unknown> | undefined;
  let persistedSession: { cwd: string; sessionDir: string; options?: Record<string, unknown> } | undefined;
  const persistedEvents: string[] = [];
  let disposed = false;
  const factory = createPiSdkSessionFactory({
    modelRuntime: { kind: "test-runtime" },
    model: {
      id: "test-model",
      maxTokens: 4_096,
      contextWindow: 16_384,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
    loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
    loadSdk: async () => ({
      SessionManager: {
        create: (cwd: string, sessionDir: string, options?: Record<string, unknown>) => {
          persistedSession = { cwd, sessionDir, options };
          return persistedSession;
        },
        inMemory: () => {
          throw new Error("persistent sessions are required");
        },
      },
      SettingsManager: { inMemory: (settings?: Record<string, unknown>) => ({ settings }) },
      createExtensionRuntime: () => ({
        flagValues: new Map(),
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
        assertActive() {},
        invalidate() {},
        trackEventBusSubscription(unsubscribe: () => void) {
          return unsubscribe;
        },
        registerProvider() {},
        registerNativeProvider() {},
        unregisterProvider() {},
      }),
      async createAgentSession(options: Record<string, unknown>) {
        captured = options;
        return {
          session: {
            sessionId: "evolution-test",
            subscribe(listener: (event: Record<string, unknown>) => void) {
              listener({ type: "session_start" });
              return () => {};
            },
            async prompt() {},
            getSessionStats() {
              return { sessionId: "evolution-test", tokens: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 }, cost: 0.01 };
            },
            dispose() {
              disposed = true;
            },
          },
        };
      },
    }),
  });
  const tool: RestrictedToolDescriptor = {
    name: "read_candidate",
    description: "read",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { text: "ok" };
    },
  };
  const session = await factory({
    cwd: root,
    agentDir: join(root, ".agent"),
    sessionDir: join(root, "sessions"),
    sessionId: "evolution-test",
    systemPrompt: "restricted",
    getCompactionContext: () => "preserve task state",
    persistEvent: (event) => persistedEvents.push(event.eventType),
    tools: [tool],
    budget: { maxTokens: 100, maxCostUsd: 1 },
  });
  const report = await session.prompt("fix");
  await session.dispose?.();

  assert.equal(captured?.noTools, "all");
  assert.deepEqual(persistedSession?.options, { id: "evolution-test" });
  assert.deepEqual(captured?.tools, ["read_candidate"]);
  assert.equal((captured?.customTools as Array<unknown>).length, 1);
  const loader = captured?.resourceLoader as {
    getSkills(): { skills: unknown[] };
    getAgentsFiles(): { agentsFiles: unknown[] };
    getExtensions(): { extensions: unknown[] };
  };
  assert.deepEqual(loader.getSkills().skills, []);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  const extensions = loader.getExtensions().extensions as Array<{
    handlers: Map<string, Array<(event: Record<string, unknown>) => unknown>>;
  }>;
  assert.equal(extensions.length, 1);
  const toolGuard = extensions[0].handlers.get("tool_call")?.[0];
  assert.deepEqual(toolGuard?.({ toolName: "bash" }), {
    block: true,
    terminate: true,
    reason: "tool is outside the evolution task allowlist",
  });
  assert.equal(toolGuard?.({ toolName: "read_candidate", toolCallId: "call-1" }), undefined);
  assert.deepEqual(toolGuard?.({ toolName: "read_candidate", toolCallId: "call-1" }), {
    block: true,
    terminate: true,
    reason: "duplicate tool call id is not replayable",
  });
  const compactionGuard = extensions[0].handlers.get("session_before_compact")?.[0];
  assert.deepEqual(await compactionGuard?.({ customInstructions: undefined }), { cancel: true });
  assert.deepEqual(await compactionGuard?.({
    customInstructions: undefined,
    preparation: { firstKeptEntryId: "entry-1", tokensBefore: 123 },
  }), {
    compaction: {
      summary: "preserve task state",
      firstKeptEntryId: "entry-1",
      tokensBefore: 123,
      details: { source: "what-the-repo-evolution-ledger" },
    },
  });
  const settings = (captured?.settingsManager as { settings: Record<string, unknown> }).settings;
  assert.equal(settings.enableAnalytics, false);
  assert.equal(settings.enableInstallTelemetry, false);
  assert.deepEqual(settings.retry, { enabled: false, maxRetries: 0 });
  assert.equal(report?.usage.cachedTokens, 1);
  assert.deepEqual(persistedEvents, ["session_start", "pi_prompt_complete"]);
  assert.equal(disposed, true);
});

test("Pi SDK adapter rejects every conflicting Session identity source", async () => {
  const cases = [
    {
      name: "Session object",
      sessionObjectId: "wrong-session-object",
      statsId: "expected-session",
      rejectsDuringCreate: true,
    },
    {
      name: "session statistics",
      sessionObjectId: "expected-session",
      statsId: "wrong-session-statistics",
      rejectsDuringCreate: false,
    },
    {
      name: "missing Session object",
      sessionObjectId: undefined,
      statsId: "expected-session",
      rejectsDuringCreate: true,
    },
    {
      name: "missing session statistics",
      sessionObjectId: "expected-session",
      statsId: undefined,
      rejectsDuringCreate: false,
    },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-session-id-"));
    let disposeCalls = 0;
    let aborted = false;
    const factory = createPiSdkSessionFactory({
      modelRuntime: { kind: "test-runtime" },
      model: {
        id: "test-model",
        maxTokens: 4_096,
        contextWindow: 16_384,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
      loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
      loadSdk: async () => ({
        SessionManager: { create: () => ({}), inMemory: () => ({}) },
        SettingsManager: { inMemory: () => ({}) },
        createExtensionRuntime: () => ({
          flagValues: new Map(),
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
          assertActive() {},
          invalidate() {},
          trackEventBusSubscription: (unsubscribe: () => void) => unsubscribe,
          registerProvider() {},
          registerNativeProvider() {},
          unregisterProvider() {},
        }),
        async createAgentSession() {
          return {
            session: {
              sessionId: item.sessionObjectId as string,
              async prompt() {},
              getSessionStats() {
                return {
                  sessionId: item.statsId as string,
                  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                  cost: 0.001,
                };
              },
              async abort() {
                aborted = true;
              },
              dispose() {
                disposeCalls += 1;
              },
            },
          };
        },
      }),
    });
    try {
      const create = () => factory({
        cwd: root,
        agentDir: join(root, "agent"),
        sessionDir: join(root, "sessions"),
        sessionId: "expected-session",
        systemPrompt: "restricted",
        getCompactionContext: () => "{}",
        persistEvent: () => {},
        tools: [],
        budget: { maxTokens: 100, maxCostUsd: 1 },
      });
      if (item.rejectsDuringCreate) {
        await assert.rejects(create, /Session object ID/);
        assert.equal(aborted, true, `${item.name} mismatch must abort immediately`);
        assert.equal(disposeCalls, 1, `${item.name} mismatch must dispose the rejected Session`);
        continue;
      }
      const session = await create();
      await assert.rejects(() => session.prompt("probe"), /statistics ID/);
      assert.equal(aborted, true, `${item.name} mismatch must abort immediately`);
      assert.equal(disposeCalls, 1, `${item.name} mismatch must dispose immediately`);
      await session.dispose?.();
      assert.equal(disposeCalls, 1, "wrapper disposal must stay idempotent after rejection");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Pi SDK adapter rejects a Session object identity that drifts after prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-pi-session-drift-"));
  let disposeCalls = 0;
  let aborted = false;
  try {
    const factory = createPiSdkSessionFactory({
      modelRuntime: { kind: "test-runtime" },
      model: {
        id: "test-model",
        maxTokens: 4_096,
        contextWindow: 16_384,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
      loadTypebox: async () => ({ Type: { Unsafe: (schema) => schema } }),
      loadSdk: async () => ({
        SessionManager: { create: () => ({}), inMemory: () => ({}) },
        SettingsManager: { inMemory: () => ({}) },
        createExtensionRuntime: () => ({
          flagValues: new Map(),
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
          assertActive() {},
          invalidate() {},
          trackEventBusSubscription: (unsubscribe: () => void) => unsubscribe,
          registerProvider() {},
          registerNativeProvider() {},
          unregisterProvider() {},
        }),
        async createAgentSession() {
          const sdkSession = {
            sessionId: "expected-session",
            async prompt() {
              sdkSession.sessionId = "drifted-session";
            },
            getSessionStats() {
              return {
                sessionId: "expected-session",
                tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                cost: 0.001,
              };
            },
            async abort() {
              aborted = true;
            },
            dispose() {
              disposeCalls += 1;
            },
          };
          return { session: sdkSession };
        },
      }),
    });
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir: join(root, "sessions"),
      sessionId: "expected-session",
      systemPrompt: "restricted",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [],
      budget: { maxTokens: 100, maxCostUsd: 1 },
    });

    await assert.rejects(() => session.prompt("probe"), /Session object ID/);
    assert.equal(aborted, true);
    assert.equal(disposeCalls, 1);
    await session.dispose?.();
    assert.equal(disposeCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned Pi SDK creates a persistent restricted AgentSession without model I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-real-pi-sdk-"));
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const model = modelRuntime.getModels().find((item) =>
      item.provider !== "amazon-bedrock" && item.api !== "bedrock-converse-stream");
    assert.ok(model, "the pinned Pi package must expose at least one non-Bedrock static model");

    let manager: ReturnType<typeof sdk.SessionManager.create> | undefined;
    let toolNames: string[] = [];
    const factory = createPiSdkSessionFactory({
      modelRuntime,
      model,
      loadTypebox: async () => import("typebox"),
      loadSdk: async () => ({
        SessionManager: {
          create(cwd: string, sessionDir: string, options?: Record<string, unknown>) {
            manager = sdk.SessionManager.create(cwd, sessionDir, options);
            return manager;
          },
          inMemory: (cwd?: string) => sdk.SessionManager.inMemory(cwd),
        },
        SettingsManager: {
          inMemory: (settings?: Record<string, unknown>) => sdk.SettingsManager.inMemory(settings),
        },
        createExtensionRuntime: sdk.createExtensionRuntime,
        async createAgentSession(options: Record<string, unknown>) {
          const result = await sdk.createAgentSession(options);
          toolNames = result.session.agent.state.tools.map((tool) => tool.name);
          return result;
        },
      }),
    });
    const sessionDir = join(root, "sessions");
    const session = await factory({
      cwd: root,
      agentDir: join(root, "agent"),
      sessionDir,
      sessionId: "evolution-real-sdk-probe",
      systemPrompt: "restricted offline probe",
      getCompactionContext: () => "{}",
      persistEvent: () => {},
      tools: [{
        name: "read_candidate",
        description: "read a whitelisted candidate file",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { text: "ok" };
        },
      }],
      budget: { maxTokens: 100, maxCostUsd: 1 },
    });

    assert.equal(manager?.isPersisted(), true);
    assert.equal(manager?.getSessionId(), "evolution-real-sdk-probe");
    assert.equal(manager?.getSessionDir(), sessionDir);
    assert.deepEqual(toolNames, ["read_candidate"]);
    await session.abort?.();
    await session.dispose?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
