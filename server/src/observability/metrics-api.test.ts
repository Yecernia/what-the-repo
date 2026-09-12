import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../api/app.js";
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore } from "../agent/session-store.js";
import { FileStore } from "../persistence/file-store.js";
import type { ServerConfig } from "../config.js";
import { RuntimeMetrics } from "./metrics.js";

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
    retentionEnabled: false,
    keyEncryptionSecret: "test-session-secret",
    quotaMaxProjects: 20,
    quotaCreationsPerHour: 30,
    quotaActiveAnalysisJobs: 2,
    quotaStorageBytes: 4 * 1024 * 1024 * 1024,
    mcpTokens: [],
    mcpRequestsPerMinute: 60,
    metricsToken: "metrics-test-token",
  };
}

test("metrics endpoint is private when a token is configured", async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "what-the-repo-metrics-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const metrics = new RuntimeMetrics();
    let refreshes = 0;
    const app = buildApp({
      config: config(root),
      store,
      sessions: new PiSessionStore(join(root, "pi-sessions")),
      memories: new PiMemoryStore(join(root, "pi-memory")),
      metrics,
      metricsRefresh: async () => {
        refreshes += 1;
        metrics.setGauge("refresh_probe", refreshes);
      },
    });
    await app.ready();

    const denied = await app.inject({ method: "GET", url: "/metrics" });
    assert.equal(denied.statusCode, 404);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.statusCode, 200);
    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-test-token" },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/plain/);
    assert.match(response.body, /what_the_repo_http_requests_total/);
    assert.match(response.body, /route="\/api\/health"/);
    assert.match(response.body, /refresh_probe 1/);
    assert.equal(refreshes, 1);
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
