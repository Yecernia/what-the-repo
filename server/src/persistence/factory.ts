import { join } from "node:path";
import type { ServerConfig } from "../config.js";
import { FileStore } from "./file-store.js";
import { PostgresStore } from "./postgres-store.js";
import type { ProductStore, QuotaLimits } from "./store.js";
import { LocalSnapshotObjectStore, TencentCosObjectStore, type SnapshotObjectStore } from "./snapshot-object-store.js";

function quotas(config: ServerConfig): QuotaLimits {
  return {
    maxProjects: config.quotaMaxProjects,
    maxCreationsPerHour: config.quotaCreationsPerHour,
    maxStorageBytes: config.quotaStorageBytes,
  };
}

function analysisLimits(config: ServerConfig) {
  return { running: config.analysisPendingLimit ?? 32, pending: config.analysisPendingLimit ?? 32, ownerRunning: config.analysisOwnerConcurrency ?? 2,
    ownerWaiting: config.analysisOwnerQueueLimit ?? 4, waiting: config.analysisQueueLimit ?? 32 };
}

export function createProductStore(config: ServerConfig, applicationRole = "api"): ProductStore {
  if (!config.databaseUrl) return new FileStore(config.dataDir, quotas(config), undefined, analysisLimits(config));
  if (config.keyEncryptionSecret.length < 16) {
    throw new Error("PostgreSQL 模式需要至少 16 字符的 WHAT_THE_REPO_KEY_ENCRYPTION_SECRET 或 SESSION_SECRET");
  }
  return new PostgresStore({
    databaseUrl: config.databaseUrl,
    root: config.dataDir,
    migrationsRoot: join(config.root, "server", "migrations"),
    encryptionSecret: config.keyEncryptionSecret,
    applicationRole,
    quotaLimits: quotas(config),
    analysisLimits: analysisLimits(config),
    poolMax: config.databasePoolMax,
    idleTimeoutMs: config.databaseIdleTimeoutMs,
    connectionTimeoutMs: config.databaseConnectionTimeoutMs,
    objectStore: createSnapshotObjectStore(config),
    objectStoreConcurrency: config.objectStoreConcurrency,
  });
}

export function createSnapshotObjectStore(config: ServerConfig): SnapshotObjectStore {
  const required = [config.cosBucket, config.cosRegion, config.cosSecretId, config.cosSecretKey];
  const enabled = Boolean(
    config.cosBucket
    || config.cosSecretId
    || config.cosSecretKey
    || config.cosSecurityToken
    || config.cosDomain,
  );
  if (!enabled) return new LocalSnapshotObjectStore(config.dataDir);
  if (required.every(Boolean)) {
    return new TencentCosObjectStore({
      bucket: config.cosBucket as string,
      region: config.cosRegion as string,
      secretId: config.cosSecretId as string,
      secretKey: config.cosSecretKey as string,
      securityToken: config.cosSecurityToken ?? undefined,
      prefix: config.cosPrefix,
      domain: config.cosDomain ?? undefined,
    });
  }
  throw new Error(
    "COS 配置不完整：必须同时设置 WHAT_THE_REPO_COS_BUCKET、COS_REGION、COS_SECRET_ID 和 COS_SECRET_KEY（或 COS_SECRET_KEY_FILE）；临时密钥还要设置 COS_SECURITY_TOKEN（或对应 FILE）",
  );
}
