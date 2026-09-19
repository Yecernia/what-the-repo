export interface UpstreamCapacityRule {
  account: string;
  baseUrl: string;
  credentialHashes: string[];
  model?: string;
  concurrency: number;
}

export interface ConcurrencyConfig {
  chatModelConcurrency?: number;
  analysisFetchConcurrency?: number;
  analysisCpuConcurrency?: number;
  analysisPublishConcurrency?: number;
  analysisPendingLimit?: number;
  analysisMemoryMb?: number;
  objectStoreConcurrency?: number;
  upstreamCapacities?: UpstreamCapacityRule[];
}

export function integerSetting(env: NodeJS.ProcessEnv, suffix: string, fallback: number, min: number, max: number): number {
  const name = 'WHAT_THE_REPO_' + suffix;
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function concurrencyConfig(env: NodeJS.ProcessEnv): ConcurrencyConfig {
  const removed = ['ANALYSIS_CONCURRENCY', 'ANALYSIS_QUEUE_CONCURRENCY', 'PROVIDER_CONCURRENCY',
    'PROVIDER_GATE_POLL_MS', 'SESSION_LOCK_WAIT_TIMEOUT_MS', 'UPSTREAM_CONCURRENCY', 'QUOTA_ACTIVE_ANALYSIS_JOBS'];
  for (const suffix of removed) if (env['WHAT_THE_REPO_' + suffix]?.trim())
    throw new Error(`WHAT_THE_REPO_${suffix} was removed; see docs/runtime-capacity.md for migration`);
  let rules: unknown = [];
  try { rules = JSON.parse(env.WHAT_THE_REPO_UPSTREAM_CAPACITIES ?? '[]'); }
  catch { throw new Error('WHAT_THE_REPO_UPSTREAM_CAPACITIES must be a JSON array'); }
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('invalid upstream capacities');
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule.account !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.account)
      || typeof rule.baseUrl !== 'string' || !Array.isArray(rule.credentialHashes) || !rule.credentialHashes.length
      || !rule.credentialHashes.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
      || (rule.model !== undefined && (typeof rule.model !== 'string' || !rule.model.trim()))
      || !Number.isSafeInteger(rule.concurrency) || rule.concurrency < 1 || rule.concurrency > 256)
      throw new Error('invalid upstream capacity rule');
    const url = new URL(rule.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('invalid upstream capacity URL');
    const key = rule.account + ':' + (rule.model ?? '*');
    if (seen.has(key)) throw new Error('duplicate upstream capacity account/model');
    seen.add(key);
  }
  return {
    chatModelConcurrency: integerSetting(env, 'CHAT_MODEL_CONCURRENCY', 8, 1, 256),
    analysisFetchConcurrency: integerSetting(env, 'ANALYSIS_FETCH_CONCURRENCY', 2, 1, 32),
    analysisCpuConcurrency: integerSetting(env, 'ANALYSIS_CPU_CONCURRENCY', 2, 1, 32),
    analysisPublishConcurrency: integerSetting(env, 'ANALYSIS_PUBLISH_CONCURRENCY', 1, 1, 16),
    analysisPendingLimit: integerSetting(env, 'ANALYSIS_PENDING_LIMIT', 32, 1, 256),
    analysisMemoryMb: integerSetting(env, 'ANALYSIS_MEMORY_MB', 6144, 1024, 1048576),
    objectStoreConcurrency: integerSetting(env, 'OBJECT_STORE_CONCURRENCY', 8, 1, 64),
    upstreamCapacities: rules as UpstreamCapacityRule[],
  };
}
