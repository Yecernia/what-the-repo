import type { ServerConfig } from '../config.js';
import {
  AGENT_MODEL_ROLES,
  type AgentModelRole,
} from '../agent-model-config.js';
import type { ProductStore } from '../persistence/store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { AdminDocuments } from './documents.js';
import { adminError, seal, unseal } from './security.js';
import {
  safePublicHttpsUrl,
  createPublicFetch,
} from '../security/outbound-url.js';
import { providerPreset } from '../agent/provider-catalog.js';
import {resolveDeploymentProvider} from '../agent/provider-resolver.js';
import {createModelRuntime} from '../agent/model-runtime.js';

export const ADMIN_AGENT_ROLES = [
  'primary-chat',
  'repository-analysis',
  'feedback-analysis',
  'evolution',
  'component-explanation',
  'architecture-planning',
  'repository-value-discovery',
  'snapshot-language-overlay',
] as const;
export type AdminAgentRole = (typeof ADMIN_AGENT_ROLES)[number];
export interface PlatformConnection {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  models: string[];
  secret: string;
  masked: string;
  verifiedAt: string | null;
}
export interface PlatformVersion {
  version: number;
  createdAt: string;
  actor: string;
  connections: PlatformConnection[];
  agents: Partial<
    Record<AdminAgentRole, { connectionId: string; model: string }>
  >;
  evolutionModel?: {model:ReturnType<typeof createModelRuntime>['model'];authHeader?:string};
}
export interface PlatformHistory {
  versions: PlatformVersion[];
}
const instances = new WeakMap<ProductStore, AdminDocuments>();
export function adminDocuments(store: ProductStore) {
  let docs = instances.get(store);
  if (!docs) {
    docs = new AdminDocuments(
      store.root,
      store instanceof PostgresStore ? store.pool : undefined,
    );
    instances.set(store, docs);
  }
  return docs;
}
export function publicVersion(version: PlatformVersion) {
  return {
    ...version,
    connections: version.connections.map(({ secret, ...row }) => ({
      ...row,
      hasKey: !!secret,
    })),
  };
}
export async function savePlatformVersion(
  docs: AdminDocuments,
  secret: string,
  actor: string,
  input: unknown,
) {
  const body = input as {
    baseVersion?: number;
    connections?: Array<Partial<PlatformConnection> & { apiKey?: string }>;
    agents?: PlatformVersion['agents'];
  };
  if (
    !body ||
    !Array.isArray(body.connections) ||
    body.connections.length > 30 ||
    !body.agents ||
    typeof body.agents !== 'object' ||
    secret.length < 32
  )
    throw adminError(400, 'admin_invalid_config');
  return docs.change<PlatformHistory, ReturnType<typeof publicVersion>>(
    'platform',
    { versions: [] },
    (history) => {
      const previous = history.versions.at(-1);
      if (body.baseVersion !== (previous?.version ?? 0))
        throw adminError(409, 'admin_config_conflict');
      const ids = new Set<string>();
      const connections = body.connections!.map((row) => {
        if (
          typeof row.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) ||
          ids.has(row.id) ||
          !row.label?.trim() ||
          row.label.length > 80 ||
          !row.provider ||
          !providerPreset(row.provider) ||
          !row.baseUrl ||
          !safePublicHttpsUrl(row.baseUrl) ||
          new URL(row.baseUrl).search ||
          !Array.isArray(row.models) ||
          !row.models.length ||
          row.models.length > 100 ||
          row.models.some(
            (m) => typeof m !== 'string' || !m.trim() || m.length > 240,
          )
        )
          throw adminError(400, 'admin_invalid_config');
        ids.add(row.id);
        const old = previous?.connections.find((c) => c.id === row.id);
        const destinationSame =
          old?.provider === row.provider && old.baseUrl === row.baseUrl;
        if (
          row.apiKey !== undefined &&
          (typeof row.apiKey !== 'string' ||
            !row.apiKey.trim() ||
            row.apiKey.length > 16384)
        )
          throw adminError(400, 'admin_invalid_config');
        if (!row.apiKey && (!old || !destinationSame))
          throw adminError(400, 'admin_key_required');
        return {
          id: row.id,
          label: row.label.trim(),
          provider: row.provider,
          baseUrl: row.baseUrl,
          models: [...new Set(row.models)],
          secret: row.apiKey
            ? seal(secret, 'connection:' + row.id, row.apiKey.trim())
            : old!.secret,
          masked: row.apiKey ? '••••' + row.apiKey.slice(-4) : old!.masked,
          verifiedAt:
            !row.apiKey && destinationSame ? (old?.verifiedAt ?? null) : null,
        };
      });
      for (const [role, selection] of Object.entries(body.agents!)) {
        if (
          !(ADMIN_AGENT_ROLES as readonly string[]).includes(role) ||
          !selection ||
          !connections.some(
            (c) =>
              c.id === selection.connectionId &&
              c.models.includes(selection.model),
          )
        )
          throw adminError(400, 'admin_invalid_config');
      }
      const version: PlatformVersion = {
        version: (previous?.version ?? 0) + 1,
        createdAt: new Date().toISOString(),
        actor,
        connections,
        agents: structuredClone(body.agents!),
      };
      const evolution=version.agents.evolution;
      if(evolution){
        const connection=connections.find(c=>c.id===evolution.connectionId)!;
        const resolved=resolveDeploymentProvider({providerId:connection.provider,baseUrl:connection.baseUrl,model:evolution.model,apiKey:'descriptor-only',connectionId:connection.id});
        if(!resolved)throw adminError(400,'admin_invalid_config');
        const {headers:_headers,...model}=createModelRuntime(resolved).model;
        version.evolutionModel={model,authHeader:providerPreset(connection.provider)?.authHeader};
      }
      history.versions.push(version);
      return publicVersion(version);
    },
    { actor, action: 'config.publish', target: 'platform', outcome: 'success' },
  );
}
/** A connection check requests the model catalogue only; it never performs paid inference. */
export async function verifyPlatformConnection(
  docs: AdminDocuments,
  secret: string,
  id: string,
  fetcher = createPublicFetch(),
) {
  const version = (
    await docs.read<PlatformHistory>('platform', { versions: [] })
  ).versions.at(-1);
  const connection = version?.connections.find((c) => c.id === id);
  if (!connection) throw adminError(404, 'admin_connection_missing');
  const url = connection.baseUrl.replace(/\/$/, '') + '/models';
  const key = unseal(secret, 'connection:' + id, connection.secret);
  let ok = false;
  const headers: Record<string, string> =
    connection.provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : connection.provider === 'google'
        ? { 'x-goog-api-key': key }
        : { authorization: 'Bearer ' + key };
  try {
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    ok = response.ok;
    await response.body?.cancel();
  } catch {
    /* Never retain upstream bodies or credential-bearing errors. */
  }
  if (ok)
    await docs.change<PlatformHistory, void>(
      'platform',
      { versions: [] },
      (history) => {
        const current = history.versions.at(-1);
        if (current?.version === version?.version) {
          const row = current?.connections.find((c) => c.id === id);
          if (row) row.verifiedAt = new Date().toISOString();
        }
      },
    );
  return {
    ok,
    method: 'model_catalogue',
    paid_inference: false,
    version: version?.version,
  };
}
/** Select by creation time so queued jobs and resumed attempts retain one immutable configuration. */
export async function runtimeConfig(
  config: ServerConfig,
  store: ProductStore,
  createdAt?: string,
  pinnedVersion?: number,
): Promise<ServerConfig> {
  const history = await adminDocuments(store).read<PlatformHistory>(
    'platform',
    { versions: [] },
  );
  const version = history.versions
    .filter((v) =>
      pinnedVersion !== undefined
        ? v.version === pinnedVersion
        : !createdAt || v.createdAt <= createdAt,
    )
    .at(-1);
  if (pinnedVersion && !version)
    throw new Error('platform_config_version_missing');
  if (!version) return { ...config, adminConfigVersion: 0 };
  const result: ServerConfig = {
    ...config,
    agentModels: { ...config.agentModels },
    adminConfigVersion: version.version,
  };
  for (const [role, selection] of Object.entries(version.agents)) {
    const connection = version.connections.find(
      (c) => c.id === selection.connectionId,
    )!;
    const apiKey = unseal(
      config.keyEncryptionSecret,
      'connection:' + connection.id,
      connection.secret,
    );
    const override = {
      model: selection.model,
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      apiKey,
      connectionId: connection.id,
    };
    if ((AGENT_MODEL_ROLES as readonly string[]).includes(role))
      result.agentModels![role as AgentModelRole] = override;
    else if (role === 'primary-chat') {
      result.freeProviderId = connection.provider;
      result.freeProviderBaseUrl = connection.baseUrl;
      result.freeProviderModel = selection.model;
      result.freeProviderApiKey = apiKey;
      result.freeConnectionId = connection.id;
    } else if (role === 'repository-analysis') {
      result.analysisProviderId = connection.provider;
      result.analysisProviderBaseUrl = connection.baseUrl;
      result.analysisProviderModel = selection.model;
      result.analysisProviderApiKey = apiKey;
      result.analysisConnectionId = connection.id;
    } else if (role === 'feedback-analysis') {
      result.feedbackProviderId = connection.provider;
      result.feedbackProviderBaseUrl = connection.baseUrl;
      result.feedbackProviderModel = selection.model;
      result.feedbackProviderApiKey = apiKey;
      result.feedbackConnectionId = connection.id;
    }
  }
  return result;
}
