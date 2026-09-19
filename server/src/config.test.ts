import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertApiSessionSecret, loadConfig } from "./config.js";

test("production API configuration requires a sufficiently strong Session Secret", () => {
  assert.throws(
    () => assertApiSessionSecret({ nodeEnv: "production", sessionSecret: "" }),
    /生产 API 必须配置至少 32 个字符/,
  );
  assert.throws(
    () => assertApiSessionSecret({ nodeEnv: "production", sessionSecret: "too-short" }),
    /生产 API 必须配置至少 32 个字符/,
  );
  assert.doesNotThrow(() => assertApiSessionSecret({ nodeEnv: "production", sessionSecret: "s".repeat(32) }));
  assert.doesNotThrow(() => assertApiSessionSecret({ nodeEnv: "development", sessionSecret: "" }));
});

test("provider deployment budget has independent defaults and overrides", () => {
  const defaults = loadConfig({ WHAT_THE_REPO_LOAD_LOCAL_ENV: "0" });
  assert.equal(defaults.quotaProviderCallsPerMinute, 60);
  assert.equal(defaults.quotaProviderCostUsdPerDay, null);
  assert.equal(defaults.quotaProviderDeploymentCallsPerMinute, 240);
  assert.equal(defaults.quotaProviderDeploymentCostUsdPerDay, null);
  assert.equal(defaults.databaseConnectionReserve, 10);
  assert.equal(defaults.chatModelConcurrency, 8);
  assert.equal(defaults.metricsHost, "127.0.0.1");
  assert.equal(defaults.metricsPort, 9464);
  assert.equal(defaults.analysisProviderId, "deepseek");
  assert.equal(defaults.analysisProviderBaseUrl, null);
  assert.equal(defaults.analysisProviderModel, null);
  assert.equal(defaults.analysisProviderApiKey, null);

  const configured = loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_QUOTA_PROVIDER_CALLS_PER_MINUTE: "12",
    WHAT_THE_REPO_QUOTA_PROVIDER_COST_USD_PER_DAY: "3.5",
    WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_CALLS_PER_MINUTE: "80",
    WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_COST_USD_PER_DAY: "7.25",
    WHAT_THE_REPO_DB_CONNECTION_RESERVE: "12",
    WHAT_THE_REPO_CHAT_MODEL_CONCURRENCY: "12",
    WHAT_THE_REPO_METRICS_HOST: "0.0.0.0",
    WHAT_THE_REPO_METRICS_PORT: "19464",
  });
  assert.equal(configured.quotaProviderCallsPerMinute, 12);
  assert.equal(configured.quotaProviderCostUsdPerDay, null);
  assert.equal(configured.quotaProviderDeploymentCallsPerMinute, 80);
  assert.equal(configured.quotaProviderDeploymentCostUsdPerDay, null);
  assert.equal(configured.databaseConnectionReserve, 12);
  assert.equal(configured.chatModelConcurrency, 12);
  assert.equal(configured.metricsHost, "0.0.0.0");
  assert.equal(configured.metricsPort, 19464);

  const freeProvider = loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_FREE_PROVIDER_BASE_URL: "https://free.example/v1",
    WHAT_THE_REPO_FREE_PROVIDER_MODEL: "free-model",
    WHAT_THE_REPO_FREE_PROVIDER_API_KEY: "free-key",
  });
  assert.equal(freeProvider.analysisProviderId, "deepseek");
  assert.equal(freeProvider.analysisProviderBaseUrl, "https://free.example/v1");
  assert.equal(freeProvider.analysisProviderModel, "free-model");
  assert.equal(freeProvider.analysisProviderApiKey, "free-key");

  const dedicatedAnalysis = loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_FREE_PROVIDER_BASE_URL: "https://free.example/v1",
    WHAT_THE_REPO_FREE_PROVIDER_MODEL: "free-model",
    WHAT_THE_REPO_FREE_PROVIDER_API_KEY: "free-key",
    WHAT_THE_REPO_ANALYSIS_PROVIDER_ID: "qwen",
    WHAT_THE_REPO_ANALYSIS_PROVIDER_BASE_URL: "https://analysis.example/v1",
    WHAT_THE_REPO_ANALYSIS_PROVIDER_MODEL: "analysis-model",
    WHAT_THE_REPO_ANALYSIS_PROVIDER_API_KEY: "analysis-key",
  });
  assert.equal(dedicatedAnalysis.analysisProviderId, "qwen");
  assert.equal(dedicatedAnalysis.analysisProviderBaseUrl, "https://analysis.example/v1");
  assert.equal(dedicatedAnalysis.analysisProviderModel, "analysis-model");
  assert.equal(dedicatedAnalysis.analysisProviderApiKey, "analysis-key");

  const zeroReserve = loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_DB_CONNECTION_RESERVE: "0",
  });
  assert.equal(zeroReserve.databaseConnectionReserve, 0);

  const temporaryCos = loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_COS_SECURITY_TOKEN: "temporary-session-token",
  });
  assert.equal(temporaryCos.cosSecurityToken, "temporary-session-token");
});

test("production secrets can be loaded from read-only mounted files", () => {
  const root = mkdtempSync(join(tmpdir(), "what-the-repo-config-"));
  try {
    const values = {
      github: "github-secret-from-file",
      session: "session-secret-from-file-0123456789",
      encryption: "encryption-secret-from-file-012345",
      free: "free-provider-key-from-file",
      feedback: "feedback-provider-key-from-file",
      search: "search-key-from-file",
      cosId: "cos-secret-id-from-file",
      cosKey: "cos-secret-key-from-file",
      metrics: "metrics-token-from-file-0123456789",
      mcp: "mcp-token-from-file-0123456789012345",
      database: "postgresql://runtime:secret@postgres:5432/what_the_repo",
    };
    for (const [name, value] of Object.entries(values)) {
      writeFileSync(join(root, name), `${value}\n`, { mode: 0o400 });
    }

    const configured = loadConfig({
      WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
      WHAT_THE_REPO_ROOT: root,
      GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      GITHUB_OAUTH_CALLBACK_URL: "https://example.com/api/auth/github/callback",
      GITHUB_OAUTH_CLIENT_SECRET_FILE: join(root, "github"),
      WHAT_THE_REPO_SESSION_SECRET_FILE: join(root, "session"),
      WHAT_THE_REPO_KEY_ENCRYPTION_SECRET_FILE: join(root, "encryption"),
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE: join(root, "free"),
      WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY_FILE: join(root, "feedback"),
      WHAT_THE_REPO_WEB_SEARCH_API_KEY_FILE: join(root, "search"),
      WHAT_THE_REPO_COS_SECRET_ID_FILE: join(root, "cosId"),
      WHAT_THE_REPO_COS_SECRET_KEY_FILE: join(root, "cosKey"),
      WHAT_THE_REPO_METRICS_TOKEN_FILE: join(root, "metrics"),
      WHAT_THE_REPO_MCP_TOKEN_FILE: join(root, "mcp"),
      WHAT_THE_REPO_MCP_OWNER_ID: "github:12345",
      DATABASE_URL_FILE: join(root, "database"),
    });

    assert.equal(configured.githubClientSecret, values.github);
    assert.equal(configured.githubGatewayUrl, null);
    assert.equal(configured.githubGatewaySharedSecret, null);
    assert.equal(configured.sessionSecret, values.session);
    assert.equal(configured.keyEncryptionSecret, values.encryption);
    assert.equal(configured.freeProviderApiKey, values.free);
    assert.equal(configured.feedbackProviderApiKey, values.feedback);
    assert.equal(configured.webSearchApiKey, values.search);
    assert.equal(configured.cosSecretId, values.cosId);
    assert.equal(configured.cosSecretKey, values.cosKey);
    assert.equal(configured.metricsToken, values.metrics);
    assert.deepEqual(configured.mcpTokens, [{ token: values.mcp, ownerId: "github:12345" }]);
    assert.equal(configured.databaseUrl, values.database);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub gateway mode does not require the direct OAuth Client Secret", () => {
  const root = mkdtempSync(join(tmpdir(), "what-the-repo-gateway-config-"));
  try {
    const gateway = "github-gateway-shared-secret-from-file-0123456789";
    const gatewayPath = join(root, "gateway");
    writeFileSync(gatewayPath, `${gateway}\n`, { mode: 0o400 });

    const configured = loadConfig({
      WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
      WHAT_THE_REPO_ROOT: root,
      GITHUB_OAUTH_CLIENT_ID: "github-client-id",
      GITHUB_OAUTH_CALLBACK_URL: "https://example.com/api/auth/github/callback",
      WHAT_THE_REPO_GITHUB_GATEWAY_URL: "https://github.example.com",
      WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET_FILE: gatewayPath,
      // This path intentionally does not exist. Gateway mode must not read it.
      GITHUB_OAUTH_CLIENT_SECRET_FILE: join(root, "direct-client-secret-that-is-not-mounted"),
    });

    assert.equal(configured.githubClientSecret, null);
    assert.equal(configured.githubGatewaySharedSecret, gateway);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OAuth-disabled jobs do not require a Client Secret file", () => {
  const root = mkdtempSync(join(tmpdir(), "what-the-repo-oauth-disabled-"));
  try {
    const configured = loadConfig({
      WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
      WHAT_THE_REPO_ROOT: root,
      GITHUB_OAUTH_CLIENT_ID: "",
      GITHUB_OAUTH_CALLBACK_URL: "",
      GITHUB_OAUTH_CLIENT_SECRET_FILE: join(root, "client-secret-not-mounted"),
    });

    assert.equal(configured.githubClientId, null);
    assert.equal(configured.githubCallbackUrl, null);
    assert.equal(configured.githubClientSecret, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub gateway configuration is all-or-nothing", () => {
  assert.throws(() => loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_GITHUB_GATEWAY_URL: "https://github.example.com",
  }), /必须同时配置/);
  assert.throws(() => loadConfig({
    WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
    WHAT_THE_REPO_GITHUB_GATEWAY_URL: "http://github.example.com",
    WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET: "x".repeat(40),
  }), /纯 HTTPS/);
});

test("MCP token maps support file loading and reject duplicate secret sources", () => {
  const root = mkdtempSync(join(tmpdir(), "what-the-repo-mcp-config-"));
  try {
    const token = "mcp-json-token-from-file-012345678901";
    const path = join(root, "mcp.json");
    writeFileSync(path, JSON.stringify({ [token]: "github:owner" }), { mode: 0o400 });

    const configured = loadConfig({
      WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
      WHAT_THE_REPO_ROOT: root,
      WHAT_THE_REPO_MCP_TOKENS_JSON_FILE: path,
    });
    assert.deepEqual(configured.mcpTokens, [{ token, ownerId: "github:owner" }]);

    assert.throws(() => loadConfig({
      WHAT_THE_REPO_LOAD_LOCAL_ENV: "0",
      WHAT_THE_REPO_ROOT: root,
      WHAT_THE_REPO_SESSION_SECRET: "direct-secret",
      WHAT_THE_REPO_SESSION_SECRET_FILE: join(root, "mcp.json"),
    }), /只能配置 WHAT_THE_REPO_SESSION_SECRET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
