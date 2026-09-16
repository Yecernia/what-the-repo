import { createAdminSecurity, registerAdminRoutes, recordPresence, adminCookie, ADMIN_CHALLENGE, ADMIN_SESSION } from '../admin/routes.js';
import { runtimeConfig } from '../admin/runtime-config.js';
import { StorageManager } from '../admin/storage.js';
import { resolveAnalysisExecution } from "../analysis/execution-identity.js";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { assertApiSessionSecret, type ServerConfig } from "../config.js";
import {
  emptyProfile,
  nowIso,
  type ProviderConnectionSettings,
  type ProviderPreset,
  type LearnerProfile,
  type Project,
  type ProviderSettings,
} from "../domain/conversation.js";
import { DEFAULT_DISPLAY_LANGUAGE, normalizeDisplayLanguage } from "../domain/display-language.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { OwnerMergeSummary } from "../domain/lifecycle.js";
import type { PiRunEvent } from "../agent/types.js";
import { displayForEvent, displayFromRecord } from "../agent/run-display.js";
import { FAILURE_MESSAGES, failureMessage, analysisFailureCode } from "../agent/provider-error.js";
import type { PiMemoryRepository } from "../agent/memory-store.js";
import { generateMemorySummary, sanitizeMemorySummary } from "../agent/memory-summary.js";
import { PiSessionStore, projectSessionId } from "../agent/session-store.js";
import type { UiSelection } from "../agent/prompts.js";
import {
  availableModels,
  decodeModelSelector,
  effectiveModelSelector,
  FREE_SELECTOR,
  PROVIDER_PRESETS,
  providerDefaultLabel,
  presetBaseUrl,
  CONFIGURABLE_PROVIDER_IDS,
  hasTrustedProviderModels,
} from "../agent/provider-resolver.js";
import {
  filterLikelyConversationalModelIds,
  providerModelIds,
  providerPreset,
  type ProviderApi,
} from "../agent/provider-catalog.js";
import { verifyManualModel } from "../agent/provider-verification.js";
import type { ProviderGateFactory } from "../agent/provider-gate.js";
import type { ProviderUsageBudget } from "../agent/provider-budget.js";
import type { ProductStore } from "../persistence/store.js";
import type { AnalysisCoordinator } from "../analysis/coordinator.js";
import { ConversationService } from "../services/conversation-service.js";
import { DEFAULT_CHAT_MAX_ROUNDS, DEFAULT_CHAT_MAX_CONTENT_BYTES } from '../services/chat-history-limits.js';
import { RepositoryService } from "../services/repository-service.js";
import { ProductServiceError } from "../services/errors.js";
import { registerMcpRoutes } from "../mcp/server.js";
import { configureProductSkillRegistry } from "../agent/skill-registry.js";
import { KeyedMutex } from "../agent/mutex.js";
import type { TaskQueue } from "../queue/task-queue.js";
import { ConversationStreamHub, type ConversationStreamClient } from "./conversation-stream.js";
import { defaultRuntimeMetrics, METRIC_NAMES, type RuntimeMetrics } from "../observability/metrics.js";
import { performance } from "node:perf_hooks";
import { createPublicFetch, safePublicHttpsUrl } from "../security/outbound-url.js";
import {
  parseGithubGatewayIdentityTicket,
  signGithubGatewayPayload,
} from "../github-gateway/protocol.js";

const IDENTITY_COOKIE = "what_the_repo_identity";
const OAUTH_STATE_COOKIE = "what_the_repo_oauth_state";
const OWNER_TOUCH_INTERVAL_MS = 60_000;
const GITHUB_OAUTH_TIMEOUT_MS = 8_000;
const PROVIDER_VERIFICATION_TTL_MS = 10 * 60_000;

export interface ServerDependencies {
  config: ServerConfig;
  store: ProductStore;
  sessions: PiSessionStore;
  memories: PiMemoryRepository;
  analysis?: AnalysisCoordinator;
  taskQueue?: TaskQueue;
  providerGateFactory?: ProviderGateFactory;
  providerBudget?: ProviderUsageBudget;
  metrics?: RuntimeMetrics;
  metricsRefresh?: () => Promise<void>;
}

interface Owner {
  owner_id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  kind: "guest" | "github";
}

interface RequestWithBody extends FastifyRequest {
  body: unknown;
}

function objectBody(request: RequestWithBody): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw httpError(400, "请求格式不正确");
  return request.body as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, key: string, max: number, required = false): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (required && !value) throw httpError(400, `${key} 不能为空`);
  return value.slice(0, max);
}

function httpError(statusCode: number, message: string, code?: string): Error & { statusCode: number; code?: string } {
  const error = new Error(message) as Error & { statusCode: number; code?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

interface GithubRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string;
}

function networkErrorDetails(error: unknown): { name: string; code: string | null; causeCode: string | null } {
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  return {
    name: typeof value?.name === "string" ? value.name : "unknown",
    code: typeof value?.code === "string" ? value.code : null,
    causeCode: typeof value?.cause?.code === "string" ? value.cause.code : null,
  };
}

function githubUnavailable(stage: string, error: unknown, elapsedMs: number): Error & { statusCode: number; code: string } {
  const details = networkErrorDetails(error);
  console.error("[oauth] GitHub network request failed", {
    stage,
    elapsed_ms: elapsedMs,
    error_name: details.name,
    error_code: details.code,
    cause_code: details.causeCode,
  });
  return httpError(502, "GitHub 登录服务暂时不可用，请稍后重试", "github_oauth_unavailable") as Error & { statusCode: number; code: string };
}

async function fetchGithub(
  url: string,
  init: GithubRequestInit,
  stage: string,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_OAUTH_TIMEOUT_MS) });
  } catch (error) {
    throw githubUnavailable(stage, error, Date.now() - startedAt);
  }
}

function isGithubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
      && url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function safeReturnTo(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

interface OAuthStatePayload {
  nonce: string;
  owner_id: string | null;
  return_to: string;
  issued_at: number;
}

function oauthStateSecret(config: ServerConfig): string {
  return config.sessionSecret || config.githubGatewaySharedSecret || config.githubClientSecret || "";
}

function encodeOAuthState(payload: OAuthStatePayload, secret: string): string {
  if (!secret) throw httpError(503, "OAuth 状态签名尚未配置");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeOAuthState(value: string, secret: string): OAuthStatePayload | null {
  if (!value || !secret) return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.toString("base64url") !== signature) return null;
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<OAuthStatePayload>;
    if (
      typeof parsed.nonce !== "string"
      || !/^[a-f0-9-]{16,80}$/i.test(parsed.nonce)
      || (typeof parsed.owner_id !== "string" && parsed.owner_id !== null)
      || typeof parsed.return_to !== "string"
      || typeof parsed.issued_at !== "number"
    ) return null;
    return {
      nonce: parsed.nonce,
      owner_id: parsed.owner_id,
      return_to: safeReturnTo(parsed.return_to),
      issued_at: parsed.issued_at,
    };
  } catch {
    return null;
  }
}

interface ProviderVerificationTicket {
  owner_id: string;
  provider: ProviderPreset;
  label: string;
  base_url: string | null;
  key_digest: string;
  issued_at: number;
  models: string[];
  manual_models: string[];
}

function providerVerificationSecret(config: ServerConfig): string {
  return config.sessionSecret.trim() || config.keyEncryptionSecret.trim();
}

function encodeProviderVerificationTicket(
  payload: ProviderVerificationTicket,
  config: ServerConfig,
): string {
  const secret = providerVerificationSecret(config);
  if (!secret) throw httpError(503, "模型连接验证暂不可用，请稍后重试", "server_error");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeProviderVerificationTicket(
  value: string,
  config: ServerConfig,
): ProviderVerificationTicket | null {
  const secret = providerVerificationSecret(config);
  if (!secret) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBytes = Buffer.from(signature, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.toString("base64url") !== signature) return null;
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ProviderVerificationTicket>;
    if (
      typeof parsed.owner_id !== "string"
      || !parsed.owner_id
      || typeof parsed.provider !== "string"
      || !CONFIGURABLE_PROVIDER_IDS.includes(parsed.provider as ProviderPreset)
      || typeof parsed.label !== "string"
      || !parsed.label
      || (typeof parsed.base_url !== "string" && parsed.base_url !== null)
      || !/^[a-f0-9]{64}$/iu.test(String(parsed.key_digest ?? ""))
      || typeof parsed.issued_at !== "number"
      || !Number.isFinite(parsed.issued_at)
      || !Array.isArray(parsed.models) || parsed.models.length > 100
      || !parsed.models.every(id => typeof id === "string" && id.length <= 500)
      || !Array.isArray(parsed.manual_models)
      || !parsed.manual_models.every(id => parsed.models!.includes(id))
    ) return null;
    const age = Date.now() - parsed.issued_at;
    if (age < -60_000 || age > PROVIDER_VERIFICATION_TTL_MS) return null;
    return {
      owner_id: parsed.owner_id,
      provider: parsed.provider as ProviderPreset,
      label: parsed.label,
      base_url: parsed.base_url ?? null,
      key_digest: String(parsed.key_digest).toLowerCase(),
      issued_at: parsed.issued_at,
      models: filterLikelyConversationalModelIds(parsed.models),
      manual_models: filterLikelyConversationalModelIds(parsed.manual_models),
    };
  } catch {
    return null;
  }
}

function providerKeyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function projectSummary(project: Project): Record<string, unknown> {
  return {
    project_id: project.project_id,
    title: project.title,
    source_kind: project.source.kind,
    source_value: project.source.value,
    analysis_stage: project.analysis.stage,
    teaching_phase: project.study.phase,
    message_count: project.messages.length,
    updated_at: project.updated_at,
  };
}

function jobResponse(job: AnalysisJob | null): Record<string, unknown> | null {
  if (!job) return null;
  return {
    ...job,
    error: job.error
      ? failureMessage(analysisFailureCode(job.error))
      : null,
    error_code: job.error_code
      ? publicErrorCode(job.status === "failed" ? 500 : 409, job.error_code)
      : null,
  };
}

function sanitizeProjectForResponse(project: Project): Project {
  const result = structuredClone(project);
  if (result.analysis.error) {
    result.analysis.error = result.analysis.error === "分析已停止，可重新分析。"
      ? result.analysis.error
      : failureMessage(analysisFailureCode(result.analysis.error));
  }
  for (const message of result.messages) {
    if (message.error) message.error = "message_failed";
    if (message.learning_action?.error) message.learning_action.error = "learning_action_failed";
  }
  if (result.repository_migration?.error) {
    result.repository_migration.error = "仓库迁移暂时未完成，请稍后重试。";
  }
  return result;
}

function projectDetail(project: Project, job: AnalysisJob | null, snapshotAvailable: boolean, config: ServerConfig): Record<string, unknown> {
  return {
    project: {
      ...sanitizeProjectForResponse(project),
      chat_limits: {
        max_rounds: config.chatMaxRounds ?? DEFAULT_CHAT_MAX_ROUNDS,
        max_content_bytes: config.chatMaxContentBytes ?? DEFAULT_CHAT_MAX_CONTENT_BYTES,
      },
    },
    snapshot_available: snapshotAvailable, analysis_job: jobResponse(job), analysis_error_code: null,
  };
}

async function profileWithSummary(
  ownerId: string,
  store: ProductStore,
  memories: PiMemoryRepository,
  profile?: LearnerProfile,
): Promise<LearnerProfile> {
  const current = profile ?? await store.loadProfile(ownerId);
  if (current.memory_summary_mode === "edited") return structuredClone(current);
  const generated = generateMemorySummary(current, await memories.list(ownerId));
  if (current.memory_summary !== generated || !current.memory_summary_updated_at) {
    current.memory_summary = generated;
    current.memory_summary_mode = "generated";
    current.memory_summary_updated_at = nowIso();
    current.updated_at = nowIso();
    await store.saveProfile(ownerId, current);
  }
  return structuredClone(current);
}

function safeProviderVerificationMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (value === "验证失败：Base URL 必须是 HTTPS 公网地址"
    || value === "验证失败：API Key 或接口权限不正确"
    || value === "验证失败：Provider 地址不可访问"
    || value === "验证失败：无法连接 Provider") {
    return value;
  }
  if (value === "Provider 没有返回可用模型列表") return "Provider 没有返回可用模型列表，请检查 Key 权限或方案";
  if (value === "Provider 没有返回可对话模型") return "Provider 返回的模型不是可对话模型，请检查接口或方案";
  if (value === "验证失败：Provider 模型列表格式不可用") return "Provider 模型列表暂时不可读取，请稍后重试";
  if (value === "Provider 未提供模型列表接口") return "Provider 未提供模型列表，请手动添加并验证模型";
  if (/^验证失败：Provider 返回 HTTP \d{3}$/u.test(value)) return "验证失败：上游服务暂时不可用，请稍后重试。";
  if (value.startsWith("该接口不支持模型列表")) return "Provider 未提供模型列表，请手动添加并验证模型";
  if (value.startsWith("Key 有效")) return "Key 有效，Provider 已响应。";
  if (value.startsWith("验证成功")) return "验证成功，已完成模型连接检查。";
  return "验证失败：上游网络暂时不可用，请稍后重试。";
}

function publicProviderPresets(): Array<(typeof PROVIDER_PRESETS)[number]> {
  return PROVIDER_PRESETS.map(({ compat: _compat, authHeader: _authHeader, ...preset }) => ({ ...preset }));
}

async function discardUnverifiedConnections(
  owner: Owner,
  store: ProductStore,
  settings: ProviderSettings,
  config: ServerConfig,
): Promise<void> {
  const removed = settings.connections.filter((connection) => !hasTrustedProviderModels(connection));
  if (!removed.length) return;
  const removedIds = new Set(removed.map((connection) => connection.connection_id));
  settings.connections = settings.connections.filter((connection) => !removedIds.has(connection.connection_id));
  await Promise.all(removed.map((connection) => store.keys.clear(owner.owner_id, connection.connection_id)));
  const selected = decodeModelSelector(settings.model);
  if (selected && removedIds.has(selected.connectionId)) settings.model = "";
  settings.model = effectiveModelSelector(config, store, owner, settings, settings.model);
  await store.saveSettings(owner.owner_id, settings);
}

async function settingsResponse(config: ServerConfig, store: ProductStore, owner: Owner, settings: ProviderSettings): Promise<Record<string, unknown>> {
  config = await runtimeConfig(config, store);
  const options = availableModels(config, store, owner, settings);
  const selected = effectiveModelSelector(config, store, owner, settings);
  const personalConnections = settings.connections.map((connection) => ({
    ...connection,
    base_url: connection.base_url ?? presetBaseUrl(connection.provider),
    custom_models: hasTrustedProviderModels(connection)
      ? filterLikelyConversationalModelIds(connection.custom_models)
      : [],
    models_source: hasTrustedProviderModels(connection) ? connection.models_source : null,
    retired: !CONFIGURABLE_PROVIDER_IDS.includes(connection.provider),
    has_api_key: Boolean(store.keys.get(owner.owner_id, connection.connection_id)),
    api_key_masked: store.keys.masked(owner.owner_id, connection.connection_id),
    verify_error: safeProviderVerificationMessage(connection.verify_error),
  }));
  const selectedConnection = decodeModelSelector(selected)?.connectionId;
  const selectedKey = selectedConnection
    ? store.keys.get(owner.owner_id, selectedConnection)
    : null;
  return {
    model: selected,
    thinking_level: settings.thinking_level,
    api_key_management: "interactive",
    model_options: options,
    available_models: options.map((option) => option.selector),
    providers: personalConnections,
    provider_presets: publicProviderPresets(),
    selected_model_option: options.find((option) => option.selector === selected) ?? null,
    has_api_key: Boolean(selectedKey),
    api_key_masked: selectedConnection ? store.keys.masked(owner.owner_id, selectedConnection) : null,
    last_verified_at: selectedConnection
      ? settings.connections.find((connection) => connection.connection_id === selectedConnection)?.last_verified_at ?? null
      : null,
    verify_error: selectedConnection
      ? safeProviderVerificationMessage(settings.connections.find((connection) => connection.connection_id === selectedConnection)?.verify_error)
      : null,
    // These fields keep older clients readable while the Web UI moves to connections/model_options.
    base_url: settings.connections.find((connection) => connection.provider === "custom")?.base_url ?? "",
    models_endpoint_supported: null,
    can_manage_api_key: owner.kind === "github",
    free_experience_model: FREE_SELECTOR,
    free_experience_provider_model: config.freeProviderModel ?? "deepseek-v4-flash",
    free_experience_configured: Boolean(config.freeProviderBaseUrl && config.freeProviderModel && config.freeProviderApiKey),
  };
}

async function ownerFromRequest(request: FastifyRequest, store: ProductStore, config: ServerConfig): Promise<Owner | null> {
  const raw = request.cookies[IDENTITY_COOKIE];
  if (!raw) return null;
  if (config.nodeEnv === "production" && !config.sessionSecret) return null;
  const parsed = config.sessionSecret ? request.unsignCookie(raw) : { valid: true, value: raw };
  if (!parsed.valid || !parsed.value) return null;
  const owner = await store.loadUser(parsed.value) as Owner | null;
  if (!owner) return null;
  const lifecycle = await store.touchOwner(owner.owner_id, nowIso(), OWNER_TOUCH_INTERVAL_MS);
  if (!lifecycle) return null;
  return owner;
}

async function requiredOwner(request: FastifyRequest, store: ProductStore, config: ServerConfig): Promise<Owner> {
  const owner = await ownerFromRequest(request, store, config);
  if (!owner) throw httpError(401, "请先登录或选择访客体验");
  return owner;
}

function setIdentity(reply: FastifyReply, config: ServerConfig, ownerId: string): void {
  if (config.nodeEnv === "production" && !config.sessionSecret) throw new Error("session_secret_missing");
  reply.setCookie(IDENTITY_COOKIE, ownerId, {
    signed: Boolean(config.sessionSecret),
    httpOnly: true,
    sameSite: "lax",
    secure: config.nodeEnv === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

function providerEndpoint(
  baseUrl: string,
  path: string,
  api: ProviderApi = "openai-completions",
): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : "/" + path;
  if (!normalized) return suffix;
  // Anthropic-compatible endpoints consistently expose Messages and model
  // discovery below /v1, including bases that already contain /api/anthropic.
  // OpenAI-compatible presets retain the older /api/* handling.
  const versioned = /\/v\d+(?:\.\d+)?$/i.test(normalized)
    || (api !== "anthropic-messages" && /\/api\//i.test(normalized));
  const root = versioned ? normalized : `${normalized}/v1`;
  return root + suffix;
}

function customProviderBaseUrl(value: string): string {
  const normalized = safePublicHttpsUrl(value);
  if (!normalized) throw httpError(400, "自定义 Provider 的 Base URL 必须是 HTTPS 公网地址");
  return normalized;
}

function normalizeConnectionLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").slice(0, 80);
}

function connectionLabelKey(value: string): string {
  return normalizeConnectionLabel(value).toLowerCase();
}

function connectionBaseUrl(connection: ProviderConnectionSettings): string {
  return connection.provider === "custom"
    ? connection.base_url ?? ""
    : presetBaseUrl(connection.provider) ?? "";
}

interface ConnectionInput {
  connection: ProviderConnectionSettings;
  apiKey: string;
}

function parseConnectionInput(body: Record<string, unknown>): ConnectionInput {
  const provider = textField(body, "provider", 40) as ProviderPreset;
  if (!CONFIGURABLE_PROVIDER_IDS.includes(provider)) throw httpError(400, "不支持这个 Provider 预设");
  const label = normalizeConnectionLabel(textField(body, "label", 80)) || providerDefaultLabel(provider);
  const baseUrl = provider === "custom"
    ? customProviderBaseUrl(textField(body, "base_url", 500))
    : null;
  const apiKey = textField(body, "api_key", 500);
  if (!apiKey) throw httpError(400, "请填写 API Key");
  return {
    connection: {
      connection_id: "verification",
      provider,
      label,
      base_url: baseUrl,
      custom_models: [],
      models_source: null,
      last_verified_at: null,
      verify_error: null,
    },
    apiKey,
  };
}

function hasConnectionLabel(settings: ProviderSettings, label: string): boolean {
  const key = connectionLabelKey(label);
  return settings.connections.some((connection) => connectionLabelKey(connection.label) === key);
}

function matchingVerificationTicket(
  body: Record<string, unknown>, connection: ProviderConnectionSettings, apiKey: string, owner: Owner, config: ServerConfig,
): ProviderVerificationTicket | null {
  const token = textField(body, "verification_token", 100_000);
  const ticket = token ? decodeProviderVerificationTicket(token, config) : null;
  return ticket && ticket.owner_id === owner.owner_id && ticket.provider === connection.provider
    && ticket.label === connection.label && ticket.base_url === connection.base_url
    && ticket.key_digest === providerKeyDigest(apiKey) ? ticket : null;
}

function selectedVerifiedModels(raw: unknown, allowed: string[], allowEmpty = false): string[] {
  const models = raw === undefined ? allowed : raw;
  if (!Array.isArray(models) || models.length > 100
    || !models.every(id => typeof id === "string" && allowed.includes(id))) {
    throw httpError(409, "模型列表含未验证的模型，请先验证", "connection_verification_required");
  }
  const selected = filterLikelyConversationalModelIds(models);
  if (!allowEmpty && !selected.length) throw httpError(400, "模型列表至少保留一个已验证模型");
  return selected;
}

function setConnectionModels(connection: ProviderConnectionSettings, models: string[], manual: string[]): void {
  connection.custom_models = models;
  connection.manually_verified_models = manual.filter(id => models.includes(id));
  connection.models_source = connection.manually_verified_models.length ? "verified" : "provider";
  connection.last_verified_at = nowIso();
  connection.verify_error = null;
}

interface ProviderVerificationResult {
  ok: boolean;
  models: string[];
  supported: boolean;
  message: string;
}

async function verifyProvider(
  baseUrl: string,
  apiKey: string,
  api: ProviderApi = "openai-completions",
  authHeader?: "api-key" | "authorization",
  provider?: string,
): Promise<ProviderVerificationResult> {
  const safeBaseUrl = safePublicHttpsUrl(baseUrl);
  if (!safeBaseUrl) {
    return {
      ok: false,
      models: [],
      supported: false,
      message: "验证失败：Base URL 必须是 HTTPS 公网地址",
    };
  }
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(api === "anthropic-messages"
      ? {
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
        authorization: "Bearer " + apiKey,
      }
      : {
        authorization: "Bearer " + apiKey,
        ...(authHeader === "api-key" ? { "api-key": apiKey } : {}),
      }),
  };
  let models: string[] = [];
  let response: Response;
  try {
    response = await createPublicFetch()(providerEndpoint(safeBaseUrl, "/models", api), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      ok: false,
      models: [],
      supported: false,
      message: "验证失败：Provider 地址不可访问",
    };
  }
  if (response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        ok: false,
        models: [],
        supported: true,
        message: "验证失败：Provider 模型列表格式不可用",
      };
    }
    models = providerModelIds(payload, provider);
    if (!models.length) {
      return {
        ok: false,
        models,
        supported: true,
        message: "Provider 没有返回可对话模型",
      };
    }
    return {
      ok: true,
      models,
      supported: true,
      message: "已读取上游模型列表，正在验证连接",
    };
  }
  if (![404, 405].includes(response.status)) {
    return {
      ok: false,
      models: [],
      supported: true,
      message: response.status === 401 || response.status === 403
        ? "验证失败：API Key 或接口权限不正确"
        : "验证失败：Provider 返回 HTTP " + response.status,
    };
  }
  return {
    ok: false,
    models: [],
    supported: false,
    message: "Provider 未提供模型列表接口",
  };
}

async function discoverConnectionModels(
  connection: ProviderConnectionSettings,
  apiKey: string,
): Promise<ProviderVerificationResult> {
  const baseUrl = connectionBaseUrl(connection);
  const preset = providerPreset(connection.provider);
  const discovered = await verifyProvider(baseUrl, apiKey, preset?.api, preset?.authHeader, connection.provider);
  if (!discovered.ok || !discovered.models.length) return discovered;
  return {
    ...discovered,
    ok: true,
    message: `验证成功，已读取 ${discovered.models.length} 个可对话模型`,
  };
}

function applyVerificationResult(
  config: ServerConfig,
  store: ProductStore,
  owner: Owner,
  settings: ProviderSettings,
  connection: ProviderConnectionSettings,
  result: ProviderVerificationResult,
): void {
  // A temporary discovery failure must not erase a user's working configuration.
  if (!result.ok) return;
  result.models = filterLikelyConversationalModelIds([...(connection.manually_verified_models ?? []), ...result.models]);
  setConnectionModels(connection, result.models, connection.manually_verified_models ?? []);
  settings.model = effectiveModelSelector(config, store, owner, settings, settings.model);
}

export function progressPayload(event: PiRunEvent): Record<string, unknown> {
  const display = event.display ?? displayForEvent({
    type: event.type,
    summary: event.summary,
    toolName: event.toolName,
    isError: event.isError,
    errorCode: event.errorCode,
  });
  return {
    run_id: event.runId,
    stage: event.type,
    event_type: event.type,
    display_stage: display.stage,
    kind: display.kind,
    label: display.label,
    ...(display.text ? { text: display.text } : {}),
    status: display.status,
    visible: display.visible,
    timestamp: event.timestamp,
    elapsed_ms: event.elapsedMs ?? 0,
    sequence: event.sequence,
    delta: event.delta,
    tool_name: display.toolName ?? event.toolName,
    tool_error: event.isError,
  };
}

function replayEventPayload(
  row: Record<string, unknown>,
  fallbackRunId: string,
  fallbackTimestamp: string,
): Record<string, unknown> | null {
  const sequence = typeof row.sequence === "number" ? row.sequence : Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  const display = displayFromRecord(row);
  if (!display) return null;
  const eventType = typeof row.stage === "string"
    ? row.stage
    : typeof row.type === "string" ? row.type : "runtime";
  const runId = typeof row.run_id === "string" ? row.run_id : fallbackRunId;
  const timestamp = typeof row.timestamp === "string"
    ? row.timestamp
    : typeof row.created_at === "string" ? row.created_at : fallbackTimestamp;
  const elapsed = typeof row.elapsed_ms === "number" && Number.isFinite(row.elapsed_ms)
    ? Math.max(0, row.elapsed_ms)
    : 0;
  const payload: Record<string, unknown> = {
    run_id: runId,
    stage: eventType,
    event_type: eventType,
    display_stage: display.stage,
    kind: display.kind,
    label: display.label,
    status: display.status,
    visible: display.visible,
    timestamp,
    elapsed_ms: elapsed,
    sequence,
  };
  if (display.text) payload.text = display.text;
  if (display.toolName) payload.tool_name = display.toolName;
  if (typeof row.delta === "string" && eventType === "assistant_delta") {
    payload.delta = row.delta.slice(0, 8_000);
  }
  if (typeof row.tool_error === "boolean") payload.tool_error = row.tool_error;
  return payload;
}

function streamFailureMessage(error: unknown): string {
  if (error instanceof ProductServiceError) {
    return safePublicErrorMessage(error.statusCode, error.code, error.message);
  }
  return failureMessage("server_error");
}

function openConversationStream(reply: FastifyReply, _projectId: string): ConversationStreamClient {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return {
    write(type, payload) {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write("event: " + type + "\ndata: " + JSON.stringify(payload) + "\n\n");
      }
    },
    end() {
      if (!reply.raw.writableEnded) reply.raw.end();
    },
    isOpen() {
      return !reply.raw.writableEnded && !reply.raw.destroyed;
    },
  };
}

function streamAfterSequence(request: FastifyRequest): number {
  const query = request.query as { after?: string } | undefined;
  const header = request.headers["last-event-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  return parseNonNegativeInt(query?.after ?? headerValue, 0);
}

const PUBLIC_ERROR_CODES = new Set([
  ...Object.keys(FAILURE_MESSAGES), "last_message_changed", "analysis_retry_scheduled",
  "cancelled", "no_result", "invalid_request", "not_found", "forbidden",
  "auth_required", "rate_limited", "provider_unavailable", "provider_key_required",
  "session_busy", "snapshot_unavailable", "snapshot_mismatch", "analysis_in_progress",
  "analysis_not_active", "analysis_cancelled", "repository_migration_not_pending",
  "repository_migration_target_missing", "learning_action_not_pending",
  "learning_action_not_confirmed", "learning_action_invalid", "invalid_feedback_target",
  "github_oauth_unavailable", "github_oauth_access_denied", "github_oauth_ticket_invalid",
  "github_oauth_ticket_replayed", "github_oauth_invalid_response", "github_oauth_token_invalid",
  "github_oauth_token_rejected", "github_oauth_user_rejected", "invalid_oauth_start",
  "invalid_oauth_state", "invalid_github_request", "invalid_github_repository", "invalid_github_ref",
  "invalid_github_commit", "github_unavailable", "github_response_too_large",
  "server_error", "upstream_network_error", "connection_name_duplicate",
  "connection_verification_required",
]);

function publicErrorCode(status: number, rawCode: unknown): string {
  const code = typeof rawCode === "string" ? rawCode : "";
  if (PUBLIC_ERROR_CODES.has(code)) return code;
  if (status === 401) return "auth_required";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 502 || status === 504) return "upstream_network_error";
  if (status >= 500) return "server_error";
  return "invalid_request";
}

function safePublicErrorMessage(status: number, code: unknown, rawMessage: unknown): string {
  const normalizedCode = typeof code === "string" ? code : "";
  if (FAILURE_MESSAGES[normalizedCode]) return failureMessage(normalizedCode);
  if (normalizedCode === "last_message_changed") return "只能编辑最后一条消息，请刷新后重试。";
  if (normalizedCode === "no_result") return failureMessage("server_error");
  if (normalizedCode === "session_busy") return "上一轮仍在处理，请等待它结束或取消后再试";
  if (normalizedCode === "rate_limited") return "请求过于频繁，请稍后重试";
  if (normalizedCode === "not_found") return "项目不存在";
  if (normalizedCode === "snapshot_unavailable") return "项目图谱尚未完成";
  if (normalizedCode === "snapshot_mismatch") return "请求的证据快照不是项目当前快照";
  if (normalizedCode === "analysis_in_progress") return "分析正在进行，请先停止当前分析";
  if (normalizedCode === "analysis_not_active") return "分析任务已结束或不存在";
  if (normalizedCode === "learning_action_not_pending") return "这个学习选择已经处理或不存在";
  if (normalizedCode === "learning_action_not_confirmed") return "学习路线请求已经失效";
  if (normalizedCode === "learning_action_invalid") return "学习目标无效";
  if (normalizedCode === "invalid_feedback_target") return "只能评价已经生成的回答";
  if (normalizedCode === "github_oauth_unavailable") return "GitHub 登录服务暂时不可用，请稍后重试。";
  if (normalizedCode === "github_oauth_access_denied") return "GitHub 登录已取消。";
  if (/^github_oauth_(?:ticket|state|token|user|invalid)/u.test(normalizedCode)) {
    return "GitHub 登录状态已失效，请重新登录。";
  }
  if (normalizedCode === "upstream_network_error") return "上游网络暂时不可用，请稍后重试。";
  if (normalizedCode === "connection_name_duplicate") return "连接名称已存在，请换一个名称";
  if (normalizedCode === "connection_verification_required") return "请先验证并拉取模型列表";
  if (status === 401) return "请先登录或选择访客体验。";
  if (status === 403) return "当前操作没有权限，或访客模式不支持。";
  if (status === 404) return "请求的内容不存在或已被移除。";
  if (status === 409) return "当前状态已发生变化，请刷新后重试。";
  if (status === 429) return "请求过于频繁，请稍后再试。";
  if (status === 502 || status === 504) return "上游网络暂时不可用，请稍后重试。";
  if (status >= 500) return "服务暂时无法完成请求，请稍后重试。";
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  // Preserve short, deliberately authored validation text, but reject URLs,
  // paths, SQL/stack traces and credential-shaped fragments.
  if (
    message
    && message.length <= 180
    && !/(?:https?:\/\/|[A-Za-z]:[\\/]|(?:^|\s)\/[^\s]+|bearer\s+|(?:api[_ -]?key|secret|password|token)\s*[:=]|sk-[A-Za-z0-9_-]{8,}|(?:stack|traceback|postgres|sql|exception| at ))/iu.test(message)
    && /^(?:请|访客|当前|公开|项目|模型|模型连接|这个模型连接|自定义 Provider|记忆摘要|画像|仓库|本轮回答|回答反馈|分析|GitHub 登录)/u.test(message)
  ) return message;
  return "请求内容不符合要求，请检查后重试。";
}

export function buildApp(dependencies: ServerDependencies): FastifyInstance {
  const { config, store, sessions, memories } = dependencies;
  assertApiSessionSecret(config);
  const metrics = dependencies.metrics ?? defaultRuntimeMetrics;
  const adminSecurity = createAdminSecurity(dependencies);
  const storageManager = new StorageManager(store, config);
  const conversationStreams = new ConversationStreamHub();
  configureProductSkillRegistry(config.skillVersionsRoot);
  const conversation = new ConversationService(
    config,
    store,
    sessions,
    memories,
    dependencies.taskQueue,
    dependencies.providerGateFactory,
    metrics,
    dependencies.providerBudget,
  );
  // OAuth migration touches projects, memories and Pi sessions across two
  // owners. Keep the whole orchestration serialized inside this process; the
  // persistence adapters add their own database/file locks for the commit.
  const ownerMergeMutex = new KeyedMutex();
  // Connection creation is owner-scoped so duplicate labels cannot slip
  // through when two browser requests arrive at the same time.
  const connectionMutationMutex = new KeyedMutex();
  // The first production shape has one API replica. This bounded cache closes
  // the short replay window for a signed gateway ticket without adding a new
  // database table solely for a 60-second OAuth handoff.
  const consumedGithubGatewayTickets = new Map<string, number>();
  const consumeGithubGatewayTicket = (ticketId: string, expiresAt: number): boolean => {
    const currentTime = Date.now();
    for (const [id, expiry] of consumedGithubGatewayTickets) {
      if (expiry < currentTime) consumedGithubGatewayTickets.delete(id);
    }
    if (consumedGithubGatewayTickets.has(ticketId)) return false;
    if (consumedGithubGatewayTickets.size >= 10_000) {
      const oldest = consumedGithubGatewayTickets.keys().next().value as string | undefined;
      if (oldest) consumedGithubGatewayTickets.delete(oldest);
    }
    consumedGithubGatewayTickets.set(ticketId, expiresAt);
    return true;
  };
  const repository = new RepositoryService(store, {
    analysisExecution: async () => { const current = await runtimeConfig(config, store); return { digest: (await resolveAnalysisExecution(current)).digest, configVersion: current.adminConfigVersion ?? 0 }; },
    analysisConfigDigest: async () => (await resolveAnalysisExecution(await runtimeConfig(config, store))).digest,
    admitWork: (job, operation) => storageManager.admit(job, operation),
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    githubGateway: config.githubGatewayUrl && config.githubGatewaySharedSecret
      ? { baseUrl: config.githubGatewayUrl, sharedSecret: config.githubGatewaySharedSecret }
      : null,
    // Unit/API tests must never turn a harmless project contract check into a
    // real GitHub request. Production keeps the normal lightweight resolver.
    resolveGithubHead: config.nodeEnv === "test" ? async () => null : undefined,
    taskQueue: dependencies.taskQueue,
  });
  const app = Fastify({ logger: false });
  const requestStartedAt = new WeakMap<object, number>();
  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, performance.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request) ?? performance.now();
    // Keep labels bounded: a raw fallback URL could contain project/run IDs.
    const route = request.routeOptions?.url ?? "unmatched";
    metrics.increment(METRIC_NAMES.httpRequests, 1, {
      method: request.method,
      route,
      status: reply.statusCode,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    });
    metrics.observe(METRIC_NAMES.httpDuration, performance.now() - startedAt, { method: request.method, route });
  });
  void app.register(cookie, config.sessionSecret ? { secret: config.sessionSecret } : {});
  registerMcpRoutes(app, { config, store, repository, conversation });
  registerAdminRoutes(app, dependencies, adminSecurity);
  app.post("/api/presence", async request => recordPresence(dependencies, await requiredOwner(request, store, config)));

  app.setErrorHandler((error, request, reply) => {
    const status = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
    const rawMessage = error instanceof Error ? error.message : "请求失败";
    const rawCode = (error as { code?: unknown }).code;
    const code = publicErrorCode(status, rawCode);
    if (status >= 500) {
      const details = networkErrorDetails(error);
      console.error("[http] request failed", {
        method: request.method,
        route: request.routeOptions.url,
        status,
        code,
        error_name: details.name,
        error_code: details.code,
        cause_code: details.causeCode,
      });
    }
    const safeDetail = safePublicErrorMessage(status, rawCode, rawMessage);
    void reply.code(status).send({ detail: safeDetail, code, ...((error as { resetAt?: string }).resetAt ? { reset_at: (error as { resetAt: string }).resetAt } : {}) });
  });
  app.get("/health", async (_request, reply) => {
    try {
      await store.checkHealth();
      return { ok: true, runtime: "typescript-pi", sessions: "pi-agent-core", storage: store.kind };
    } catch {
      return reply.code(503).send({ ok: false, runtime: "typescript-pi", sessions: "pi-agent-core", storage: store.kind });
    }
  });
  app.get("/api/health", async (_request, reply) => {
    const modelConfigured = Boolean(config.freeProviderBaseUrl && config.freeProviderModel && config.freeProviderApiKey);
    try {
      await store.checkHealth();
      return { ok: true, storage: store.kind, model_configured: modelConfigured };
    } catch {
      return reply.code(503).send({ ok: false, storage: store.kind, model_configured: modelConfigured });
    }
  });
  app.get("/metrics", async (request, reply) => {
    const expected = config.metricsToken?.trim();
    const provided = request.headers.authorization;
    if (!expected && config.nodeEnv === "production") {
      return reply.code(404).send({ detail: "Not Found" });
    }
    if (expected && provided !== `Bearer ${expected}`) {
      return reply.code(404).send({ detail: "Not Found" });
    }
    await dependencies.metricsRefresh?.();
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return reply.send(metrics.prometheus());
  });

  app.get("/api/auth/config", async () => ({
    auth_mode: "github",
    guest_enabled: true,
    guest_retention: {
      empty_days: 7,
      project_inactive_days: 30,
      recovery_days: 7,
      notice: "访客空间无项目且连续 7 天未使用会删除；有项目但连续 30 天未使用会先软删除，并保留 7 天恢复窗口。",
    },
  }));
  app.get("/api/auth/me", async (request) => {
    const owner = await ownerFromRequest(request, store, config);
    if (!owner) throw httpError(401, "未登录");
    return {
      ...owner,
      auth_mode: "github",
      merge_summary: await store.consumeOwnerMergeReceipt(owner.owner_id),
    };
  });
  app.post("/api/auth/guest", async (_request, reply) => {
    const owner: Owner = { owner_id: `guest:${randomUUID().replaceAll("-", "")}`, login: "guest", display_name: "访客", avatar_url: null, kind: "guest" };
    await store.saveUser(owner.owner_id, owner as unknown as Record<string, unknown>);
    setIdentity(reply, config, owner.owner_id);
    return owner;
  });
  app.post("/api/auth/logout", async (request, reply) => {
    if (adminSecurity.enabled && request.cookies[ADMIN_SESSION]) await adminSecurity.logout(request.cookies[ADMIN_SESSION]!);
    return reply.clearCookie(IDENTITY_COOKIE, { path: "/" }).clearCookie(ADMIN_SESSION, { path: "/api/admin" }).code(204).send();
  });
  app.get("/api/auth/github/start", async (request, reply) => {
    const gatewayUrl = config.githubGatewayUrl;
    const gatewaySecret = config.githubGatewaySharedSecret;
    if (!gatewayUrl && (!config.githubClientId || !config.githubCallbackUrl)) throw httpError(503, "GitHub OAuth 尚未配置");
    const stateSecret = oauthStateSecret(config);
    if (!stateSecret) throw httpError(503, "OAuth 状态签名尚未配置");
    const currentOwner = await ownerFromRequest(request, store, config);
    const query = request.query as { return_to?: string };
    const payload: OAuthStatePayload = {
      nonce: randomUUID(),
      owner_id: currentOwner?.kind === "guest" ? currentOwner.owner_id : null,
      return_to: safeReturnTo(query.return_to ?? "/"),
      issued_at: Date.now(),
    };
    const encoded = encodeOAuthState(payload, stateSecret);
    reply.setCookie(OAUTH_STATE_COOKIE, encoded, { httpOnly: true, sameSite: "lax", secure: config.nodeEnv === "production", path: "/", maxAge: 600 });
    if (gatewayUrl && gatewaySecret) {
      const grant = signGithubGatewayPayload({
        version: 1,
        kind: "github_oauth_start",
        ...(payload.return_to.startsWith("/admin") && config.adminWebUrl ? { audience: "admin" } : {}),
        nonce: payload.nonce,
        issued_at: payload.issued_at,
        expires_at: payload.issued_at + 60_000,
      }, gatewaySecret);
      const url = new URL(`${gatewayUrl}/oauth/github/start`);
      url.searchParams.set("request", grant);
      return reply.redirect(url.toString());
    }
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", config.githubClientId!);
    url.searchParams.set("redirect_uri", config.githubCallbackUrl!);
    url.searchParams.set("state", payload.nonce);
    return reply.redirect(url.toString());
  });
  app.get("/api/auth/github/callback", async (request, reply) => {
    let oauthStage = "validate_configuration";
    try {
      const gatewaySecret = config.githubGatewaySharedSecret;
      const gatewayMode = Boolean(config.githubGatewayUrl && gatewaySecret);
      if (!gatewayMode && (!config.githubClientId || !config.githubClientSecret || !config.githubCallbackUrl)) {
        throw httpError(503, "GitHub OAuth 尚未配置");
      }
      const query = request.query as { code?: string; state?: string; ticket?: string };
      oauthStage = "validate_state";
      const state = decodeOAuthState(request.cookies[OAUTH_STATE_COOKIE] ?? "", oauthStateSecret(config));
      if (
        !state
        || Date.now() - state.issued_at > 10 * 60 * 1000
      ) throw httpError(400, "GitHub 登录状态已失效");
      oauthStage = "load_current_owner";
      const currentOwner = await ownerFromRequest(request, store, config);
      const stateOwnerExists = state.owner_id ? Boolean(await store.loadUser(state.owner_id)) : false;
      if (state.owner_id && stateOwnerExists && (!currentOwner || currentOwner.owner_id !== state.owner_id || currentOwner.kind !== "guest")) {
        throw httpError(400, "访客登录状态与当前浏览器不匹配");
      }
      let github: { id: number; login: string; name?: string | null; avatar_url?: string | null };
      if (gatewayMode) {
        oauthStage = "validate_gateway_ticket";
        const ticket = parseGithubGatewayIdentityTicket(query.ticket ?? "", gatewaySecret!);
        if (!ticket || ticket.nonce !== state.nonce) throw httpError(400, "GitHub 登录票据已失效", "github_oauth_ticket_invalid");
        if (!consumeGithubGatewayTicket(ticket.ticket_id, ticket.expires_at)) {
          throw httpError(400, "GitHub 登录票据已经使用", "github_oauth_ticket_replayed");
        }
        if (ticket.outcome === "error") {
          reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
          if (ticket.error === "access_denied") throw httpError(400, "GitHub 登录已取消", "github_oauth_access_denied");
          if (ticket.error === "github_unavailable") {
            throw httpError(502, "GitHub 登录服务暂时不可用，请稍后重试", "github_oauth_unavailable");
          }
          throw httpError(502, "GitHub 登录返回了无效结果，请重试", "github_oauth_invalid_response");
        }
        github = ticket.github;
      } else {
        if (!query.code || !query.state || query.state !== state.nonce) throw httpError(400, "GitHub 登录状态已失效");
        oauthStage = "exchange_token";
        const tokenResponse = await fetchGithub(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code: query.code, redirect_uri: config.githubCallbackUrl }),
          },
          "exchange_token",
        );
        oauthStage = "parse_token";
        let token: { access_token?: string; error?: string };
        try {
          token = await tokenResponse.json() as { access_token?: string; error?: string };
        } catch (error) {
          console.error("[oauth] GitHub token response was not JSON", { status: tokenResponse.status, ...networkErrorDetails(error) });
          throw httpError(502, "GitHub 登录未返回有效响应", "github_oauth_token_invalid");
        }
        if (!tokenResponse.ok || !token.access_token) {
          console.warn("[oauth] GitHub token exchange rejected", { status: tokenResponse.status, error: token.error ?? null });
          throw httpError(502, "GitHub 登录未返回访问令牌", "github_oauth_token_rejected");
        }
        oauthStage = "load_github_user";
        const userResponse = await fetchGithub(
          "https://api.github.com/user",
          { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "what-the-repo" } },
          "load_user",
        );
        if (!userResponse.ok) {
          console.warn("[oauth] GitHub user endpoint rejected token", { status: userResponse.status });
          throw httpError(502, "无法读取 GitHub 用户信息", "github_oauth_user_rejected");
        }
        github = await userResponse.json() as { id: number; login: string; name?: string | null; avatar_url?: string | null };
      }
      const owner: Owner = { owner_id: `github:${github.id}`, login: github.login, display_name: github.name || github.login, avatar_url: github.avatar_url ?? null, kind: "github" };
      let mergeSummary: OwnerMergeSummary | null = null;
      const mergeKey = state.owner_id && state.owner_id !== owner.owner_id
        ? `owner-merge:${[state.owner_id, owner.owner_id].sort().join(":")}`
        : null;
      const merge = async (): Promise<OwnerMergeSummary | null> => {
        await store.saveUser(owner.owner_id, owner as unknown as Record<string, unknown>);
        if (!state.owner_id || state.owner_id === owner.owner_id) return null;
        // A callback can be replayed after a successful merge (the source guest
        // owner has already been deleted). Treat that as an idempotent login.
        if (!(await store.loadUser(state.owner_id))) return null;
        const sourceProjects = await store.listProjects(state.owner_id);
        const sourceMemories = await memories.list(state.owner_id);
        const targetMemories = await memories.list(owner.owner_id);
        const targetMemoryKeys = new Set(targetMemories.map((memory) => memory.key));
        let migratedMemoryCount = 0;
        for (const memory of sourceMemories) {
          if (targetMemoryKeys.has(memory.key)) continue;
          await memories.upsert({ ...memory, ownerId: owner.owner_id });
          targetMemoryKeys.add(memory.key);
          migratedMemoryCount += 1;
        }
        const sourceSessions = await sessions.listOwnerSessions(state.owner_id);
        for (const project of sourceProjects) {
          await sessions.rebuildFromMessages({
            sessionId: projectSessionId(owner.owner_id, project.project_id, project.analysis.snapshot_id),
            ownerId: owner.owner_id,
            projectId: project.project_id,
            snapshotId: project.analysis.snapshot_id,
            skillId: "primary-conversational-supervisor",
            skillVersion: "owner-merge-rebuild",
          }, project.messages.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.created_at,
          })));
        }
        const summary = await store.mergeOwners({
          sourceOwnerId: state.owner_id,
          targetOwnerId: owner.owner_id,
          memoryCount: migratedMemoryCount,
          sessionCount: sourceSessions.length,
        });
        await profileWithSummary(owner.owner_id, store, memories);
        await memories.clear(state.owner_id);
        await sessions.deleteOwner(state.owner_id);
        return summary;
      };
      oauthStage = "persist_owner";
      mergeSummary = mergeKey
        ? await ownerMergeMutex.runExclusive(mergeKey, merge)
        : await merge();
      oauthStage = "redirect_to_web";
      if (state.return_to === "/admin" || state.return_to.startsWith("/admin?")) {
        const challenge = await adminSecurity.beginGithub(owner.owner_id);
        adminCookie(reply, ADMIN_CHALLENGE, challenge, config.nodeEnv === "production", 300);
      }
      setIdentity(reply, config, owner.owner_id);
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
      // The receipt is persisted as well; the query makes the first redirect
      // self-describing while /api/auth/me consumes the durable copy once.
      const returnUrl = new URL(`${state.return_to.startsWith("/admin") ? config.adminWebUrl ?? config.webUrl : config.webUrl}${safeReturnTo(state.return_to)}`);
      if (mergeSummary) returnUrl.searchParams.set("merged", String(mergeSummary.projects));
      return reply.redirect(returnUrl.toString());
    } catch (error) {
      if (!(error as { statusCode?: unknown }).statusCode || Number((error as { statusCode?: unknown }).statusCode) >= 500) {
        const details = networkErrorDetails(error);
        console.error("[oauth] callback failed", {
          stage: oauthStage,
          error_name: details.name,
          error_code: details.code,
          cause_code: details.causeCode,
        });
      }
      throw error;
    }
  });

  app.get("/api/projects", async (request) => {
    const owner = await requiredOwner(request, store, config);
    return (await store.listProjects(owner.owner_id)).map(projectSummary);
  });
  app.post("/api/projects", async (request: RequestWithBody, reply) => {
    const owner = await requiredOwner(request, store, config);
    const body = objectBody(request);
    if (body.kind !== "github") throw httpError(400, "当前只支持公开 GitHub 仓库");
    const value = textField(body, "value", 1000, true);
    if (!isGithubUrl(value)) throw httpError(400, "请输入公开 GitHub 仓库地址");
    const headerLanguage = Array.isArray(request.headers["accept-language"])
      ? request.headers["accept-language"][0]
      : request.headers["accept-language"];
    const displayLanguage = normalizeDisplayLanguage(
      textField(body, "display_language", 40)
        || headerLanguage?.split(",")[0]
        || DEFAULT_DISPLAY_LANGUAGE,
    );
    const { project, job } = await repository.startAnalysis({
      owner,
      kind: "github",
      value,
      title: textField(body, "title", 200),
      displayLanguage,
    });
    return reply.code(201).send(projectDetail(project, job, false, config));
  });
  app.get("/api/projects/:projectId", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const project = await repository.refreshMigrationNotice(owner.owner_id, projectId);
    if (!project) throw httpError(404, "项目不存在");
    return projectDetail(project, await store.latestJob(projectId), Boolean(await store.loadSnapshot(projectId)), config);
  });
  app.patch("/api/projects/:projectId", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const title = textField(objectBody(request), "title", 200, true);
    const project = await store.updateProject(projectId, owner.owner_id, (row) => { row.title = title; });
    if (!project) throw httpError(404, "项目不存在");
    return projectSummary(project);
  });
  app.put("/api/projects/:projectId/model", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const selected = textField(objectBody(request), "model", 200) || FREE_SELECTOR;
    if (owner.kind === "guest" && selected !== FREE_SELECTOR) throw httpError(403, "访客只能使用免费体验模型");
    const project = await store.updateProject(projectId, owner.owner_id, (row) => { row.model_override = selected; });
    if (!project) throw httpError(404, "项目不存在");
    return projectSummary(project);
  });
  app.delete("/api/projects/:projectId", async (request, reply) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    if (!(await store.deleteProject(projectId, owner.owner_id))) throw httpError(404, "项目不存在");
    return reply.code(204).send();
  });
  app.post("/api/projects/:projectId/reanalyze", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const { project, job } = await repository.startAnalysis({ owner, projectId });
    return {
      project_id: projectId,
      ...sanitizeProjectForResponse(project).analysis,
      error_code: job.error_code ? publicErrorCode(500, job.error_code) : null,
      job_id: job.job_id,
      job_status: job.status,
      job_attempt: job.attempt,
      job_max_attempts: job.max_attempts,
      lease_owner: job.lease_owner,
      heartbeat_at: job.heartbeat_at,
      retryable: true,
    };
  });
  app.get("/api/projects/:projectId/analysis", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const status = await repository.getAnalysisStatus(owner.owner_id, projectId);
    return {
      ...status,
      error: typeof status.error === "string" && status.error
        ? status.error === "分析已停止，可重新分析。" ? status.error : failureMessage(analysisFailureCode(status.error))
        : null,
      error_code: status.error_code ? publicErrorCode(500, status.error_code) : null,
    };
  });

  app.get("/api/settings", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const settings = await store.loadSettings(owner.owner_id);
    await discardUnverifiedConnections(owner, store, settings, config);
    return settingsResponse(config, store, owner, settings);
  });
  app.put("/api/settings", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const body = objectBody(request);
    const connectionMutationFields = ["connection_id", "provider", "label", "base_url", "api_key", "model", "models"];
    if (connectionMutationFields.some((field) => field in body)) {
      throw httpError(405, "模型连接只支持新增或删除，请删除后重新添加");
    }
    const settings = await store.loadSettings(owner.owner_id);
    await discardUnverifiedConnections(owner, store, settings, config);
    const thinking = textField(body, "thinking_level", 20);
    if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
      settings.thinking_level = thinking as ProviderSettings["thinking_level"];
    }
    await store.saveSettings(owner.owner_id, settings);
    return settingsResponse(config, store, owner, settings);
  });
  app.post("/api/settings/connections/verify", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能管理个人 API Key");
    const body = objectBody(request);
    const settings = await store.loadSettings(owner.owner_id);
    const existingId = textField(body, "existing_connection_id", 64);
    const existing = existingId ? settings.connections.find(item => item.connection_id === existingId) : undefined;
    if (existingId && !existing) throw httpError(404, "模型连接不存在");
    const { connection, apiKey } = existing
      ? { connection: existing, apiKey: store.keys.get(owner.owner_id, existing.connection_id) ?? "" }
      : parseConnectionInput(body);
    if (!apiKey) throw httpError(400, "请先填写 API Key");
    if (!existing && hasConnectionLabel(settings, connection.label)) {
      throw httpError(409, "连接名称已存在，请换一个名称", "connection_name_duplicate");
    }
    const previous = matchingVerificationTicket(body, connection, apiKey, owner, config);
    const storedModels = existing && hasTrustedProviderModels(existing) ? existing.custom_models : [];
    const allowed = filterLikelyConversationalModelIds([...storedModels, ...(previous?.models ?? [])]);
    const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
    if ("model_id" in body && !modelId) throw httpError(400, "请填写模型名称");
    // A fresh discovery can recover from an expired ticket. It never trusts
    // unsigned draft IDs; only prior manual proofs may be retained.
    const selected = selectedVerifiedModels(modelId ? body.models
      : Array.isArray(body.models) ? body.models.filter(id => allowed.includes(id)) : allowed, allowed, true);
    if (modelId && selected.length >= 100 && !selected.includes(modelId)) throw httpError(400, "模型列表最多保留 100 个模型，请先删除一个");
    const previousManual = [...(existing?.manually_verified_models ?? []), ...(previous?.manual_models ?? [])].filter(id => selected.includes(id));
    const manualResult = modelId ? await verifyManualModel(connection, apiKey, modelId, {
      attribution: { business: "chat", payer: "user", agentRole: "connection-verification", configVersion: 0 },
      ownerId: owner.owner_id, providerGateFactory: dependencies.providerGateFactory, providerBudget: dependencies.providerBudget, metrics,
    }) : null;
    const verification: ProviderVerificationResult = manualResult
      ? { ...manualResult, models: manualResult.ok ? filterLikelyConversationalModelIds([modelId, ...selected]) : [], supported: false }
      : await discoverConnectionModels(connection, apiKey);
    if (verification.ok && !manualResult) verification.models = filterLikelyConversationalModelIds([...previousManual, ...verification.models]);
    const manual = manualResult?.ok ? [...new Set([modelId, ...previousManual])] : previousManual;
    const message = verification.ok
      ? verification.message
      : manualResult?.message ?? safeProviderVerificationMessage(verification.message) ?? "验证失败：上游网络暂时不可用，请稍后重试。";
    if (!verification.ok || !verification.models.length) {
      return {
        ok: false,
        models: [],
        models_endpoint_supported: verification.supported,
        message,
      };
    }
    return {
      ok: true,
      models: verification.models,
      models_endpoint_supported: verification.supported,
      message,
      verification_token: encodeProviderVerificationTicket({
        owner_id: owner.owner_id,
        provider: connection.provider,
        label: connection.label,
        base_url: connection.base_url,
        key_digest: providerKeyDigest(apiKey),
        issued_at: Date.now(),
        models: verification.models,
        manual_models: manual.filter(id => verification.models.includes(id)),
      }, config),
    };
  });
  app.post("/api/settings/connections", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能管理个人 API Key");
    const body = objectBody(request);
    const { connection, apiKey } = parseConnectionInput(body);
    const ticket = matchingVerificationTicket(body, connection, apiKey, owner, config);
    if (!ticket) {
      throw httpError(409, "请先获取或验证模型", "connection_verification_required");
    }
    // Save only a subset of the server-signed model list; never rediscover here.
    const models = selectedVerifiedModels(body.models, ticket.models);

    return connectionMutationMutex.runExclusive(owner.owner_id, async () => {
      const settings = await store.loadSettings(owner.owner_id);
      await discardUnverifiedConnections(owner, store, settings, config);
      const connectionId = textField(body, "connection_id", 64)
        || `${connection.provider}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connectionId)) throw httpError(400, "连接 ID 格式不正确");
      if (settings.connections.some((item) => item.connection_id === connectionId)) {
        throw httpError(409, "这个模型连接已经存在");
      }
      if (hasConnectionLabel(settings, connection.label)) {
        throw httpError(409, "连接名称已存在，请换一个名称", "connection_name_duplicate");
      }
      connection.connection_id = connectionId;
      setConnectionModels(connection, models, ticket.manual_models);
      settings.connections.push(connection);
      await store.keys.set(owner.owner_id, apiKey, connectionId);
      settings.model = effectiveModelSelector(config, store, owner, settings, settings.model);
      await store.saveSettings(owner.owner_id, settings);
      return settingsResponse(config, store, owner, settings);
    });
  });
  app.patch("/api/settings/connections/:connectionId", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能管理个人 API Key");
    const body = objectBody(request);
    if (Object.keys(body).some(key => !["models", "verification_token"].includes(key)) || !Array.isArray(body.models)) {
      throw httpError(405, "模型连接只支持新增或删除，请删除后重新添加");
    }
    const { connectionId } = request.params as { connectionId: string };
    return connectionMutationMutex.runExclusive(owner.owner_id, async () => {
      const settings = await store.loadSettings(owner.owner_id);
      const connection = settings.connections.find(item => item.connection_id === connectionId);
      if (!connection) throw httpError(404, "模型连接不存在");
      const apiKey = store.keys.get(owner.owner_id, connectionId) ?? "";
      const ticket = matchingVerificationTicket(body, connection, apiKey, owner, config);
      const allowed = filterLikelyConversationalModelIds([
        ...(hasTrustedProviderModels(connection) ? connection.custom_models : []), ...(ticket?.models ?? []),
      ]);
      const models = selectedVerifiedModels(body.models, allowed);
      setConnectionModels(connection, models, [...(connection.manually_verified_models ?? []), ...(ticket?.manual_models ?? [])]);
      settings.model = effectiveModelSelector(config, store, owner, settings, settings.model);
      await store.saveSettings(owner.owner_id, settings);
      return settingsResponse(config, store, owner, settings);
    });
  });
  app.delete("/api/settings/connections/:connectionId", async (request, reply) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能管理个人 API Key");
    const { connectionId } = request.params as { connectionId: string };
    const settings = await store.loadSettings(owner.owner_id);
    await discardUnverifiedConnections(owner, store, settings, config);
    const before = settings.connections.length;
    settings.connections = settings.connections.filter((item) => item.connection_id !== connectionId);
    if (settings.connections.length === before) throw httpError(404, "模型连接不存在");
    await store.keys.clear(owner.owner_id, connectionId);
    if (decodeModelSelector(settings.model)?.connectionId === connectionId) settings.model = "";
    settings.model = effectiveModelSelector(config, store, owner, settings, settings.model);
    await store.saveSettings(owner.owner_id, settings);
    return reply.send(await settingsResponse(config, store, owner, settings));
  });
  app.put("/api/settings/selection", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const body = objectBody(request);
    const settings = await store.loadSettings(owner.owner_id);
    await discardUnverifiedConnections(owner, store, settings, config);
    const options = availableModels(config, store, owner, settings);
    const requestedModel = textField(body, "model", 500);
    const model = requestedModel
      || settings.model
      || (owner.kind === "guest" ? FREE_SELECTOR : options[0]?.selector ?? FREE_SELECTOR);
    if (owner.kind === "guest" && model !== FREE_SELECTOR) throw httpError(403, "访客只能使用免费体验模型");
    if (owner.kind !== "guest" && model !== FREE_SELECTOR && !options.some((option) => option.selector === model)) {
      throw httpError(409, "这个模型连接尚未配置或不可用");
    }
    settings.model = model;
    const selectedOption = options.find((option) => option.selector === model);
    const thinking = textField(body, "thinking_level", 20);
    if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
      settings.thinking_level = selectedOption?.thinking_levels.includes(thinking as ProviderSettings["thinking_level"])
        ? thinking as ProviderSettings["thinking_level"]
        : selectedOption?.thinking_levels.at(-1) ?? "off";
    }
    await store.saveSettings(owner.owner_id, settings);
    return settingsResponse(config, store, owner, settings);
  });
  app.delete("/api/settings/key", async (request) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能管理个人 API Key");
    const settings = await store.loadSettings(owner.owner_id);
    await discardUnverifiedConnections(owner, store, settings, config);
    await Promise.all(settings.connections.map((connection) => store.keys.clear(owner.owner_id, connection.connection_id)));
    return settingsResponse(config, store, owner, settings);
  });
  app.post("/api/settings/verify", async (request) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能验证个人 API Key");
    const settings = await store.loadSettings(owner.owner_id);
    const connectionId = (request.query as { connection_id?: string }).connection_id
      || settings.connections[0]?.connection_id
      || "legacy";
    const connection = settings.connections.find((item) => item.connection_id === connectionId);
    const apiKey = store.keys.get(owner.owner_id, connectionId);
    if (!apiKey) throw httpError(400, "请先填写 API Key");
    try {
      if (!connection) throw new Error("connection_not_found");
      const result = await discoverConnectionModels(
        connection,
        apiKey,
      );
      applyVerificationResult(config, store, owner, settings, connection, result);
      await store.saveSettings(owner.owner_id, settings);
      return {
        ok: result.ok,
        models: result.models,
        models_endpoint_supported: result.supported,
        message: result.message,
      };
    } catch {
      if (connection) {
        applyVerificationResult(config, store, owner, settings, connection, {
          ok: false,
          models: [],
          supported: false,
          message: "验证失败：无法连接 Provider",
        });
      }
      await store.saveSettings(owner.owner_id, settings);
      return {
        ok: false,
        models: [],
        models_endpoint_supported: false,
        message: "验证失败：无法连接 Provider",
      };
    }
  });
  app.post("/api/settings/connections/:connectionId/verify", async (request) => {
    const owner = await requiredOwner(request, store, config);
    if (owner.kind === "guest") throw httpError(403, "访客不能验证个人 API Key");
    const { connectionId } = request.params as { connectionId: string };
    const settings = await store.loadSettings(owner.owner_id);
    const connection = settings.connections.find((item) => item.connection_id === connectionId);
    if (!connection) throw httpError(404, "模型连接不存在");
    const apiKey = store.keys.get(owner.owner_id, connectionId);
    if (!apiKey) throw httpError(400, "请先填写 API Key");
    const result = await discoverConnectionModels(
      connection,
      apiKey,
    );
    applyVerificationResult(config, store, owner, settings, connection, result);
    await store.saveSettings(owner.owner_id, settings);
    return { ...result, models_endpoint_supported: result.supported, settings: await settingsResponse(config, store, owner, settings) };
  });

  app.get("/api/profile", async (request) => {
    const owner = await requiredOwner(request, store, config);
    return { profile: await profileWithSummary(owner.owner_id, store, memories) };
  });
  app.put("/api/profile", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const body = objectBody(request);
    const profile = await store.loadProfile(owner.owner_id);
    if (typeof body.enabled === "boolean") profile.enabled = body.enabled;
    if (Array.isArray(body.languages)) profile.languages = body.languages.filter((value): value is string => typeof value === "string").slice(0, 50);
    if (Array.isArray(body.goals)) profile.goals = body.goals.filter((value): value is string => typeof value === "string").slice(0, 50);
    if (typeof body.explanation_preference === "string") profile.explanation_preference = body.explanation_preference.slice(0, 500);
    if (typeof body.experience_level === "string") profile.experience_level = body.experience_level.slice(0, 100);
    if (profile.memory_summary_mode !== "edited") {
      profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
      profile.memory_summary_mode = "generated";
      profile.memory_summary_updated_at = nowIso();
    }
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });
  app.put("/api/profile/summary", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const body = objectBody(request);
    if (typeof body.summary !== "string") throw httpError(400, "记忆摘要内容不正确");
    const profile = await store.loadProfile(owner.owner_id);
    const summary = sanitizeMemorySummary(body.summary);
    if (!summary) {
      profile.memory_summary_mode = "generated";
      profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
    } else {
      profile.memory_summary = summary;
      profile.memory_summary_mode = "edited";
    }
    profile.memory_summary_updated_at = nowIso();
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });
  app.post("/api/profile/summary/regenerate", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const profile = await store.loadProfile(owner.owner_id);
    profile.memory_summary_mode = "generated";
    profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
    profile.memory_summary_updated_at = nowIso();
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });
  app.delete("/api/profile", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const profile = emptyProfile();
    await store.saveProfile(owner.owner_id, profile);
    return { profile };
  });
  app.delete("/api/profile/inferred", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const profile = await store.loadProfile(owner.owner_id);
    profile.inferred = [];
    profile.last_inferred_message_id = null;
    if (profile.memory_summary_mode !== "edited") {
      profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
      profile.memory_summary_updated_at = nowIso();
    }
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });
  app.delete("/api/profile/inferred/:claimId", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { claimId } = request.params as { claimId: string };
    const profile = await store.loadProfile(owner.owner_id);
    profile.inferred = profile.inferred.filter((claim) => claim.claim_id !== claimId);
    if (profile.memory_summary_mode !== "edited") {
      profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
      profile.memory_summary_updated_at = nowIso();
    }
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });
  app.patch("/api/profile/inferred/:claimId", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { claimId } = request.params as { claimId: string };
    const body = objectBody(request);
    const profile = await store.loadProfile(owner.owner_id);
    const claim = profile.inferred.find((row) => row.claim_id === claimId);
    if (!claim) throw httpError(404, "画像推断不存在");
    if (typeof body.claim === "string") {
      const value = body.claim.trim().slice(0, 500);
      if (!value) throw httpError(400, "画像内容不能为空");
      claim.claim = value;
    }
    if (typeof body.confidence === "number" && Number.isFinite(body.confidence)) {
      claim.confidence = Math.max(0, Math.min(1, body.confidence));
    }
    if (profile.memory_summary_mode !== "edited") {
      profile.memory_summary = generateMemorySummary(profile, await memories.list(owner.owner_id));
      profile.memory_summary_updated_at = nowIso();
    }
    profile.updated_at = nowIso();
    await store.saveProfile(owner.owner_id, profile);
    return { profile: structuredClone(profile) };
  });

  const sendMessage = async (
    request: RequestWithBody,
    reply: FastifyReply,
    stream: boolean,
  ): Promise<unknown> => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    await repository.refreshMigrationNotice(owner.owner_id, projectId);
    const body = objectBody(request);
    const content = textField(body, "content", 20_000, true);
    const rawSelection = body.ui_context;
    const selection = (
      rawSelection
      && typeof rawSelection === "object"
      && !Array.isArray(rawSelection)
      && typeof (rawSelection as Record<string, unknown>).snapshot_id === "string"
      && typeof (rawSelection as Record<string, unknown>).stable_id === "string"
      && typeof (rawSelection as Record<string, unknown>).kind === "string"
    ) ? {
        snapshot_id: String((rawSelection as Record<string, unknown>).snapshot_id),
        stable_id: String((rawSelection as Record<string, unknown>).stable_id),
        kind: String((rawSelection as Record<string, unknown>).kind),
        label: String((rawSelection as Record<string, unknown>).label ?? "").slice(0, 500),
        entity_id: typeof (rawSelection as Record<string, unknown>).entity_id === "string"
          ? String((rawSelection as Record<string, unknown>).entity_id).slice(0, 256)
          : null,
        evidence_id: typeof (rawSelection as Record<string, unknown>).evidence_id === "string"
          ? String((rawSelection as Record<string, unknown>).evidence_id).slice(0, 256)
          : null,
      } as UiSelection : null;
    const requestedRunId = typeof body.run_id === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(body.run_id)
      ? body.run_id
      : null;
    const runId = requestedRunId ?? randomUUID();
    const existingStream = stream ? conversationStreams.get(runId) : undefined;
    if (existingStream) {
      if (existingStream.projectId !== projectId || existingStream.ownerId !== owner.owner_id) {
        throw httpError(404, "本轮回答不存在", "not_found");
      }
      const client = openConversationStream(reply, projectId);
      conversationStreams.attach(existingStream, client, streamAfterSequence(request));
      reply.raw.once("close", () => conversationStreams.detach(existingStream, client));
      return undefined;
    }
    const controller = new AbortController();
    if (!stream) request.raw.once("aborted", () => controller.abort());
    const startedAt = Date.now();
    const streamRun = stream
      ? conversationStreams.create({ runId, projectId, ownerId: owner.owner_id, controller })
      : null;
    const run = () => conversation.run({
      owner,
      projectId,
      content,
      displayLanguage: typeof body.display_language === "string"
        ? normalizeDisplayLanguage(textField(body, "display_language", 40)) : undefined,
      replaceMessageId: typeof body.replace_message_id === "string" ? body.replace_message_id : undefined,
      retryRunId: typeof body.retry_run_id === "string" ? body.retry_run_id.slice(0, 128) : undefined,
      selection,
      reviewEvidence: body.review_evidence === true,
      runId,
      signal: controller.signal,
      onEvent: (event) => {
        if (!streamRun) return;
        if (event.type === "run_cancelled") streamRun.cancelled = true;
        conversationStreams.publishProgress(streamRun, progressPayload(event));
      },
    });

    if (stream) {
      if (!streamRun) throw new Error("conversation stream was not initialized");
      const client = openConversationStream(reply, projectId);
      conversationStreams.attach(streamRun, client, 0);
      reply.raw.once("close", () => conversationStreams.detach(streamRun, client));
      try {
        const payload = await run();
        if (!payload) {
          conversationStreams.finish(streamRun, {
            type: "error",
            payload: streamRun.cancelled
              ? { message: failureMessage("cancelled"), code: "cancelled" }
              : { message: failureMessage("server_error"), code: "server_error" },
          });
        } else {
          conversationStreams.finish(streamRun, { type: "result", payload });
        }
      } catch (error) {
        const errorCode = controller.signal.aborted
          ? "cancelled"
          : error instanceof ProductServiceError
            ? error.code
            : "internal_error";
        await store.saveTrace(runId, {
          trace_id: runId,
          run_id: runId,
          project_id: projectId,
          owner_id: owner.owner_id,
          stop_reason: errorCode,
          stream_failed: true,
          latency_ms: Date.now() - startedAt,
          created_at: nowIso(),
        }).catch(() => undefined);
        conversationStreams.finish(streamRun, {
          type: "error",
          payload: {
            message: controller.signal.aborted ? "本轮回答已取消。" : streamFailureMessage(error),
            code: errorCode,
          },
        });
      }
      return undefined;
    }
    return run();
  };
  app.post("/api/projects/:projectId/messages", async (request: RequestWithBody, reply) => sendMessage(request, reply, false));
  app.post("/api/projects/:projectId/messages/stream", async (request: RequestWithBody, reply) => sendMessage(request, reply, true));
  app.get("/api/projects/:projectId/runs/:runId/stream", async (request, reply) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    if (!(await store.loadProject(projectId, owner.owner_id))) throw httpError(404, "项目不存在");
    const streamRun = conversationStreams.get(runId);
    if (!streamRun || streamRun.projectId !== projectId || streamRun.ownerId !== owner.owner_id) {
      throw httpError(404, "本轮回答不存在", "not_found");
    }
    const client = openConversationStream(reply, projectId);
    conversationStreams.attach(streamRun, client, streamAfterSequence(request));
    reply.raw.once("close", () => conversationStreams.detach(streamRun, client));
    return undefined;
  });
  app.post("/api/projects/:projectId/messages/:messageId/feedback", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, messageId } = request.params as { projectId: string; messageId: string };
    const body = objectBody(request);
    const vote = body.vote === "up" || body.vote === "down" ? body.vote : null;
    if (!vote) throw httpError(400, "反馈必须是 up 或 down");
    return conversation.recordFeedback({
      owner,
      projectId,
      messageId,
      vote,
    });
  });
  app.post("/api/projects/:projectId/learning-actions/:actionId", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, actionId } = request.params as { projectId: string; actionId: string };
    const body = objectBody(request);
    const decision = body.decision === "confirm" || body.decision === "decline"
      ? body.decision
      : null;
    if (!decision) throw httpError(400, "学习选择必须是 confirm 或 decline");
    const result = await conversation.resolveLearningAction({
      owner,
      projectId,
      actionId,
      decision,
    });
    return { ...result, project: sanitizeProjectForResponse(result.project) };
  });
  app.post("/api/projects/:projectId/runs/:runId/pause", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    if (!conversation.controlRun({ owner, projectId, runId, action: "pause" })) {
      throw httpError(409, "本轮回答已经结束或不属于当前项目");
    }
    return { run_id: runId, status: "pausing" };
  });
  app.post("/api/projects/:projectId/runs/:runId/cancel", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    if (!conversation.controlRun({ owner, projectId, runId, action: "cancel" })) {
      throw httpError(409, "本轮回答已经结束或不属于当前项目");
    }
    conversationStreams.markCancelled(runId);
    return { run_id: runId, status: "cancelling" };
  });
  app.get("/api/projects/:projectId/snapshot", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const project = await store.loadProject(projectId, owner.owner_id);
    if (!project) throw httpError(404, "项目不存在");
    const { display_language: language } = request.query as { display_language?: string };
    if (language !== undefined && language !== "zh-CN" && language !== "en") throw httpError(400, "不支持的显示语言");
    const snapshot = await store.loadSnapshot<Record<string, unknown>>(projectId, language);
    if (!snapshot) throw httpError(404, "项目图谱尚未完成");
    return { ...snapshot, display_language: snapshot.display_language ?? normalizeDisplayLanguage(project.display_language) };
  });
  app.get("/api/projects/:projectId/source", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const project = await store.loadProject(projectId, owner.owner_id);
    if (!project) throw httpError(404, "项目不存在");
    const query = request.query as { snapshot_id?: string; path?: string; start?: string; end?: string; stable_id?: string };
    if (!query.snapshot_id || !query.path) throw httpError(409, "源码证据缺少快照或路径");
    const start = Number(query.start ?? 1);
    const end = Number(query.end ?? start + 40);
    try {
      if (query.snapshot_id === project.analysis.snapshot_id) {
        const result = await store.readSourceLines(projectId, query.snapshot_id, query.path, start, end);
        return { snapshot_id: query.snapshot_id, path: query.path, start_line: Math.max(1, Math.floor(start)), end_line: Math.max(1, Math.floor(start)) + result.lines.length - 1, lines: result.lines, truncated: result.truncated, redirect: null };
      }
      const fromPublicKey = await store.findPublicSnapshotKeyBySnapshotId(query.snapshot_id);
      const toPublicKey = project.analysis.canonical_snapshot_key;
      if (!fromPublicKey || !toPublicKey || !project.analysis.snapshot_id) throw httpError(409, "源码证据与当前快照不匹配");
      const redirect = await store.resolveRevisionRedirect({
        fromPublicKey,
        toPublicKey,
        oldPath: query.path,
        oldStableId: typeof query.stable_id === "string" ? query.stable_id : null,
      });
      if (!redirect) throw httpError(409, "旧引用尚无可确认的新版位置");
      if (redirect.kind === "deleted") {
        throw httpError(410, `新版 commit 已删除文件 ${query.path}，不能编造删除原因`);
      }
      const candidate = redirect.candidates[0];
      if (!candidate) throw httpError(409, "旧引用已变化，但尚无可打开的新位置");
      const result = await store.readPublicSourceLines(toPublicKey, project.analysis.snapshot_id, candidate.path, start, end);
      return { snapshot_id: project.analysis.snapshot_id, path: candidate.path, start_line: Math.max(1, Math.floor(start)), end_line: Math.max(1, Math.floor(start)) + result.lines.length - 1, lines: result.lines, truncated: result.truncated, redirect };
    } catch (error) {
      if (typeof (error as { statusCode?: unknown }).statusCode === "number") throw error;
      throw httpError(404, "源码片段不存在");
    }
  });
  app.put("/api/projects/:projectId/study/value-point", async (request: RequestWithBody) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    const body = objectBody(request);
    const snapshotId = textField(body, "snapshot_id", 256, true);
    const selected = textField(body, "selected_value_point", 512, true);
    return repository.getLearningPlan(owner.owner_id, projectId, snapshotId, selected);
  });
  app.get("/api/projects/:projectId/traces", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId } = request.params as { projectId: string };
    if (!(await store.loadProject(projectId, owner.owner_id))) throw httpError(404, "项目不存在");
    return store.listTraces(projectId);
  });
  app.get("/api/projects/:projectId/runs/:runId/events", async (request) => {
    const owner = await requiredOwner(request, store, config);
    const { projectId, runId } = request.params as { projectId: string; runId: string };
    if (!(await store.loadProject(projectId, owner.owner_id))) throw httpError(404, "项目不存在");
    const query = request.query as { after?: string; limit?: string };
    const header = request.headers["last-event-id"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    const after = parseNonNegativeInt(query.after ?? headerValue, 0);
    const limit = Math.max(1, Math.min(500, parseNonNegativeInt(query.limit, 100)));
    const traces = await store.listRunTraces(projectId, runId);
    const finalTraceRow = traces.find((row) => row.run_id === runId && Array.isArray(row.events));
    const fallbackTimestamp = typeof finalTraceRow?.created_at === "string"
      ? finalTraceRow.created_at
      : nowIso();
    const nestedEvents = Array.isArray(finalTraceRow?.events)
      ? finalTraceRow.events.flatMap((value) => (
        value && typeof value === "object" && !Array.isArray(value)
          ? [{ ...(value as Record<string, unknown>), run_id: runId }]
          : []
      ))
      : [];
    const bySequence = new Map<number, Record<string, unknown>>();
    for (const row of nestedEvents) {
      const payload = replayEventPayload(row, runId, fallbackTimestamp);
      if (!payload) continue;
      const sequence = payload.sequence as number;
      bySequence.set(sequence, payload);
    }
    const orderedEvents = [...bySequence.entries()]
      .filter(([sequence]) => sequence > after)
      .sort(([left], [right]) => left - right)
    const events = orderedEvents
      .slice(0, limit)
      .map(([, payload]) => payload);
    const hasMore = orderedEvents.length > events.length;
    const finalTrace = Boolean(finalTraceRow);
    return {
      run_id: runId,
      after,
      events,
      next_sequence: (events.at(-1)?.sequence as number | undefined) ?? after,
      completed: finalTrace && !hasMore,
      has_more: hasMore,
    };
  });
  return app;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
