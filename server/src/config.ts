import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readAgentModelOverrides, type AgentModelOverrides } from "./agent-model-config.js";

export interface ServerConfig {
  agentModels?: AgentModelOverrides;
  root: string;
  host: string;
  port: number;
  dataDir: string;
  sessionDir: string;
  memoryDir: string;
  skillVersionsRoot: string;
  nodeEnv: string;
  sessionSecret: string;
  freeProviderBaseUrl: string | null;
  freeProviderModel: string | null;
  freeProviderApiKey: string | null;
  /** Deployment-owned model used only for repository semantic analysis. */
  analysisProviderId?: string | null;
  analysisProviderBaseUrl?: string | null;
  analysisProviderModel?: string | null;
  analysisProviderApiKey?: string | null;
  webSearchApiKey?: string | null;
  /** Deployment-owned model used only for asynchronous feedback analysis. */
  feedbackProviderId?: string | null;
  feedbackProviderBaseUrl?: string | null;
  feedbackProviderModel?: string | null;
  feedbackProviderApiKey?: string | null;
  githubClientId: string | null;
  githubClientSecret: string | null;
  githubCallbackUrl: string | null;
  githubGatewayUrl?: string | null;
  githubGatewaySharedSecret?: string | null;
  webUrl: string;
  databaseUrl: string | null;
  redisUrl?: string | null;
  redisPrefix?: string;
  analysisQueueConcurrency?: number;
  providerConcurrency?: number;
  providerGatePollMs?: number;
  retentionEnabled: boolean;
  databasePoolMax?: number;
  databaseConnectionReserve?: number;
  databaseIdleTimeoutMs?: number;
  databaseConnectionTimeoutMs?: number;
  /** Maximum time a new conversation waits to acquire its Session lock. */
  sessionLockWaitTimeoutMs?: number;
  cosBucket?: string | null;
  cosRegion?: string | null;
  cosSecretId?: string | null;
  cosSecretKey?: string | null;
  cosSecurityToken?: string | null;
  cosPrefix?: string;
  cosDomain?: string | null;
  keyEncryptionSecret: string;
  quotaMaxProjects: number;
  quotaCreationsPerHour: number;
  quotaActiveAnalysisJobs: number;
  quotaStorageBytes: number;
  quotaProviderCallsPerMinute?: number;
  quotaProviderCostUsdPerDay?: number;
  quotaProviderReservationUsd?: number;
  quotaProviderDeploymentCallsPerMinute?: number;
  quotaProviderDeploymentCostUsdPerDay?: number;
  mcpTokens: ReadonlyArray<{ token: string; ownerId: string }>;
  mcpRequestsPerMinute: number;
  /** Optional bearer token for the internal Prometheus-compatible endpoint. */
  metricsToken?: string | null;
  metricsHost?: string;
  metricsPort?: number;
}

/** API processes must never fall back to unsigned identity cookies in production. */
export function assertApiSessionSecret(config: Pick<ServerConfig, "nodeEnv" | "sessionSecret">): void {
  if (config.nodeEnv === "production" && config.sessionSecret.trim().length < 32) {
    throw new Error("生产 API 必须配置至少 32 个字符的 Session Secret");
  }
}

function optionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function positivePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const discoveredRoot = discoverRoot(process.cwd());
  if (env.WHAT_THE_REPO_LOAD_LOCAL_ENV !== "0") {
    loadEnvFile(env, resolve(discoveredRoot, ".secrets", "local.env"));
    loadEnvFile(env, resolve(discoveredRoot, ".env"));
  }
  const root = resolve(env.WHAT_THE_REPO_ROOT ?? discoveredRoot);
  const dataDir = resolve(env.WHAT_THE_REPO_DATA_DIR ?? join(root, ".local", "what-the-repo-data"));
  const sessionSecret = secretValue(
    env,
    root,
    "WHAT_THE_REPO_SESSION_SECRET",
    "WHAT_THE_REPO_SESSION_SECRET_FILE",
  ) ?? "";
  const githubGatewayUrl = optionalSecret(env.WHAT_THE_REPO_GITHUB_GATEWAY_URL);
  const githubGatewaySharedSecret = secretValue(
    env,
    root,
    "WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET",
    "WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET_FILE",
  );
  if (Boolean(githubGatewayUrl) !== Boolean(githubGatewaySharedSecret)) {
    throw new Error("GitHub 网关 URL 和共享 Secret 必须同时配置");
  }
  if (githubGatewaySharedSecret && githubGatewaySharedSecret.length < 32) {
    throw new Error("GitHub 网关共享 Secret 至少需要 32 个字符");
  }
  if (githubGatewayUrl) {
    const parsed = new URL(githubGatewayUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("WHAT_THE_REPO_GITHUB_GATEWAY_URL 必须是纯 HTTPS 地址");
    }
  }
  const githubClientId = optionalSecret(env.GITHUB_OAUTH_CLIENT_ID);
  const githubCallbackUrl = optionalSecret(env.GITHUB_OAUTH_CALLBACK_URL);
  const githubClientSecret = githubGatewayUrl || (!githubClientId && !githubCallbackUrl)
    ? null
    : secretValue(
      env,
      root,
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_OAUTH_CLIENT_SECRET_FILE",
    );
  const freeProviderBaseUrl = optionalSecret(env.WHAT_THE_REPO_FREE_PROVIDER_BASE_URL);
  const freeProviderModel = optionalSecret(env.WHAT_THE_REPO_FREE_PROVIDER_MODEL);
  const freeProviderApiKey = secretValue(
    env,
    root,
    "WHAT_THE_REPO_FREE_PROVIDER_API_KEY",
    "WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE",
  );
  return {
    root,
    host: env.WHAT_THE_REPO_SERVER_HOST ?? "127.0.0.1",
    port: positivePort(env.WHAT_THE_REPO_SERVER_PORT, 8307),
    dataDir,
    sessionDir: resolve(env.WHAT_THE_REPO_PI_SESSION_DIR ?? join(dataDir, "pi-sessions")),
    memoryDir: resolve(env.WHAT_THE_REPO_PI_MEMORY_DIR ?? join(dataDir, "pi-memory")),
    skillVersionsRoot: resolve(
      optionalSecret(env.WHAT_THE_REPO_SKILL_VERSIONS_ROOT) ?? join(dataDir, "skill-versions"),
    ),
    nodeEnv: env.NODE_ENV ?? "development",
    sessionSecret,
    freeProviderBaseUrl,
    freeProviderModel,
    freeProviderApiKey,
    agentModels: readAgentModelOverrides(root, env),
    webSearchApiKey: secretValue(env, root, "WHAT_THE_REPO_WEB_SEARCH_API_KEY", "WHAT_THE_REPO_WEB_SEARCH_API_KEY_FILE"),
    analysisProviderId: optionalSecret(env.WHAT_THE_REPO_ANALYSIS_PROVIDER_ID) ?? "deepseek",
    analysisProviderBaseUrl:
      optionalSecret(env.WHAT_THE_REPO_ANALYSIS_PROVIDER_BASE_URL)
      ?? freeProviderBaseUrl,
    analysisProviderModel:
      optionalSecret(env.WHAT_THE_REPO_ANALYSIS_PROVIDER_MODEL)
      ?? freeProviderModel,
    analysisProviderApiKey: secretValue(
      env,
      root,
      "WHAT_THE_REPO_ANALYSIS_PROVIDER_API_KEY",
      "WHAT_THE_REPO_ANALYSIS_PROVIDER_API_KEY_FILE",
    ) ?? freeProviderApiKey,
    feedbackProviderId: optionalSecret(env.WHAT_THE_REPO_FEEDBACK_PROVIDER_ID) ?? "deepseek",
    feedbackProviderBaseUrl:
      optionalSecret(env.WHAT_THE_REPO_FEEDBACK_PROVIDER_BASE_URL)
      ?? freeProviderBaseUrl,
    feedbackProviderModel:
      optionalSecret(env.WHAT_THE_REPO_FEEDBACK_PROVIDER_MODEL)
      ?? freeProviderModel,
    feedbackProviderApiKey: secretValue(
      env,
      root,
      "WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY",
      "WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY_FILE",
    ) ?? freeProviderApiKey,
    // In gateway mode the application API must not read or require the OAuth
    // Client Secret; that credential belongs only to the GitHub boundary host.
    // With all OAuth fields empty (for example, the schema migration Job),
    // OAuth is disabled and no Client Secret file is required either.
    githubClientId,
    githubClientSecret,
    githubCallbackUrl,
    githubGatewayUrl: githubGatewayUrl?.replace(/\/$/, "") ?? null,
    githubGatewaySharedSecret,
    webUrl: env.WHAT_THE_REPO_WEB_URL ?? "http://127.0.0.1:5307",
    databaseUrl: secretValue(env, root, "DATABASE_URL", "DATABASE_URL_FILE"),
    redisUrl: optionalSecret(env.WHAT_THE_REPO_REDIS_URL),
    redisPrefix: optionalSecret(env.WHAT_THE_REPO_REDIS_PREFIX) ?? "what-the-repo",
    analysisQueueConcurrency: positiveInt(env.WHAT_THE_REPO_ANALYSIS_QUEUE_CONCURRENCY, 1),
    providerConcurrency: positiveInt(env.WHAT_THE_REPO_PROVIDER_CONCURRENCY, 4),
    providerGatePollMs: positiveInt(env.WHAT_THE_REPO_PROVIDER_GATE_POLL_MS, 100),
    retentionEnabled: booleanValue(env.WHAT_THE_REPO_RETENTION_ENABLED, true),
    databasePoolMax: positiveInt(env.WHAT_THE_REPO_DB_POOL_MAX, 10),
    databaseConnectionReserve: nonNegativeInt(env.WHAT_THE_REPO_DB_CONNECTION_RESERVE, 10),
    databaseIdleTimeoutMs: positiveInt(env.WHAT_THE_REPO_DB_IDLE_TIMEOUT_MS, 30_000),
    databaseConnectionTimeoutMs: positiveInt(env.WHAT_THE_REPO_DB_CONNECTION_TIMEOUT_MS, 10_000),
    sessionLockWaitTimeoutMs: positiveInt(env.WHAT_THE_REPO_SESSION_LOCK_WAIT_TIMEOUT_MS, 10 * 60_000),
    cosBucket: optionalSecret(env.WHAT_THE_REPO_COS_BUCKET),
    cosRegion: optionalSecret(env.WHAT_THE_REPO_COS_REGION),
    cosSecretId: secretValue(
      env,
      root,
      "WHAT_THE_REPO_COS_SECRET_ID",
      "WHAT_THE_REPO_COS_SECRET_ID_FILE",
    ),
    cosSecretKey: secretValue(
      env,
      root,
      "WHAT_THE_REPO_COS_SECRET_KEY",
      "WHAT_THE_REPO_COS_SECRET_KEY_FILE",
    ),
    cosSecurityToken: secretValue(
      env,
      root,
      "WHAT_THE_REPO_COS_SECURITY_TOKEN",
      "WHAT_THE_REPO_COS_SECURITY_TOKEN_FILE",
    ),
    cosPrefix: optionalSecret(env.WHAT_THE_REPO_COS_PREFIX) ?? "what-the-repo",
    cosDomain: optionalSecret(env.WHAT_THE_REPO_COS_DOMAIN),
    keyEncryptionSecret: secretValue(
      env,
      root,
      "WHAT_THE_REPO_KEY_ENCRYPTION_SECRET",
      "WHAT_THE_REPO_KEY_ENCRYPTION_SECRET_FILE",
    ) ?? sessionSecret,
    quotaMaxProjects: positiveInt(env.WHAT_THE_REPO_QUOTA_MAX_PROJECTS, 20),
    quotaCreationsPerHour: positiveInt(env.WHAT_THE_REPO_QUOTA_CREATIONS_PER_HOUR, 30),
    quotaActiveAnalysisJobs: positiveInt(env.WHAT_THE_REPO_QUOTA_ACTIVE_ANALYSIS_JOBS, 2),
    quotaStorageBytes: positiveInt(env.WHAT_THE_REPO_QUOTA_STORAGE_BYTES, 4 * 1024 * 1024 * 1024),
    quotaProviderCallsPerMinute: positiveInt(env.WHAT_THE_REPO_QUOTA_PROVIDER_CALLS_PER_MINUTE, 60),
    quotaProviderCostUsdPerDay: positiveNumber(env.WHAT_THE_REPO_QUOTA_PROVIDER_COST_USD_PER_DAY, 10),
    quotaProviderReservationUsd: positiveNumber(env.WHAT_THE_REPO_QUOTA_PROVIDER_RESERVATION_USD, 0.01),
    quotaProviderDeploymentCallsPerMinute: positiveInt(
      env.WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_CALLS_PER_MINUTE,
      240,
    ),
    quotaProviderDeploymentCostUsdPerDay: positiveNumber(
      env.WHAT_THE_REPO_QUOTA_PROVIDER_DEPLOYMENT_COST_USD_PER_DAY,
      20,
    ),
    mcpTokens: parseMcpTokens(env, root),
    mcpRequestsPerMinute: positiveInt(env.WHAT_THE_REPO_MCP_REQUESTS_PER_MINUTE, 60),
    metricsToken: secretValue(
      env,
      root,
      "WHAT_THE_REPO_METRICS_TOKEN",
      "WHAT_THE_REPO_METRICS_TOKEN_FILE",
    ),
    metricsHost: env.WHAT_THE_REPO_METRICS_HOST ?? "127.0.0.1",
    metricsPort: positivePort(env.WHAT_THE_REPO_METRICS_PORT, 9464),
  };
}

function secretValue(
  env: NodeJS.ProcessEnv,
  root: string,
  directName: string,
  fileName: string,
): string | null {
  const direct = optionalSecret(env[directName]);
  const configuredPath = optionalSecret(env[fileName]);
  if (direct && configuredPath) {
    throw new Error(`只能配置 ${directName} 或对应的 FILE，不能同时配置`);
  }
  if (!configuredPath) return direct;
  const path = isAbsolute(configuredPath) ? configuredPath : resolve(root, configuredPath);
  if (!existsSync(path)) throw new Error(`${fileName} 不存在`);
  return optionalSecret(readFileSync(path, "utf8"));
}

function parseMcpTokens(
  env: NodeJS.ProcessEnv,
  root: string,
): ReadonlyArray<{ token: string; ownerId: string }> {
  const bindings = new Map<string, string>();
  const raw = secretValue(
    env,
    root,
    "WHAT_THE_REPO_MCP_TOKENS_JSON",
    "WHAT_THE_REPO_MCP_TOKENS_JSON_FILE",
  );
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("WHAT_THE_REPO_MCP_TOKENS_JSON 必须是 JSON 对象");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WHAT_THE_REPO_MCP_TOKENS_JSON 必须把 Token 映射到 owner ID");
    }
    for (const [token, ownerId] of Object.entries(parsed)) {
      if (typeof ownerId !== "string") {
        throw new Error("WHAT_THE_REPO_MCP_TOKENS_JSON 的 owner ID 必须是字符串");
      }
      bindings.set(token, ownerId.trim());
    }
  }
  const localToken = secretValue(
    env,
    root,
    "WHAT_THE_REPO_MCP_TOKEN",
    "WHAT_THE_REPO_MCP_TOKEN_FILE",
  );
  if (localToken) {
    bindings.set(localToken, env.WHAT_THE_REPO_MCP_OWNER_ID?.trim() || "local");
  }
  return [...bindings.entries()].map(([token, ownerId]) => {
    if (token.length < 32 || token.length > 4096 || !ownerId) {
      throw new Error("MCP Token 必须为 32-4096 个字符并绑定有效 owner ID");
    }
    return { token, ownerId };
  });
}

function discoverRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "server", "package.json")) && existsSync(join(current, "web", "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function loadEnvFile(env: NodeJS.ProcessEnv, path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (env[key] !== undefined && env[key] !== "") continue;
    const rawValue = line.slice(separator + 1).trim();
    env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}
