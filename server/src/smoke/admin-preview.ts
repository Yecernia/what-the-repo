/** Dedicated loopback fixture. Never imported by production entry points. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { FileStore } from '../persistence/file-store.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { buildApp } from '../api/app.js';
import { digest } from '../admin/security.js';
import { adminDocuments,savePlatformVersion } from '../admin/runtime-config.js';
import {
  DEFAULT_BUDGET_POLICIES,
  LocalProviderUsageBudget,
} from '../agent/provider-budget.js';
import { RuntimeMetrics, METRIC_NAMES } from '../observability/metrics.js';
import {
  parseGithubGatewayStartGrant,
  signGithubGatewayPayload,
} from '../github-gateway/protocol.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Preview cannot run in production');
const root = resolve(process.cwd(), '..');
const dataDir = resolve(
  process.env.WTR_ADMIN_PREVIEW_DIR ??
    join(root, '.local', 'admin-preview-' + Date.now()),
);
const port = 8390,
  webPort = 5390,
  gatewayPort = 8490;
const secret = randomBytes(40).toString('hex'),
  bootstrap = randomBytes(32).toString('base64url');
const config = {
  ...loadConfig({ WHAT_THE_REPO_ROOT: root, NODE_ENV: 'test' }),
  host: '127.0.0.1',
  port,
  dataDir,
  sessionDir: join(dataDir, 'sessions'),
  memoryDir: join(dataDir, 'memory'),
  skillVersionsRoot: join(dataDir, 'skills'),
  nodeEnv: 'test',
  retentionEnabled: false,
  databaseUrl: null,
  redisUrl: null,
  freeProviderApiKey: null,
  analysisProviderApiKey: null,
  feedbackProviderApiKey: null,
  webSearchApiKey: null,
  webUrl: `http://127.0.0.1:${webPort}`,
  adminGithubId: '900000001',
  adminBootstrapHash: digest(bootstrap),
  keyEncryptionSecret: secret,
  sessionSecret: secret,
  githubGatewayUrl: `http://127.0.0.1:${gatewayPort}`,
  githubGatewaySharedSecret: secret,
};
const store = new FileStore(dataDir);
await store.init();
const docs = adminDocuments(store);
await mkdir(dataDir, { recursive: true });
await writeFile(
  join(dataDir, 'preview-credentials.json'),
  JSON.stringify({ bootstrap, githubId: config.adminGithubId }),
  { mode: 0o600 },
);
const metrics = new RuntimeMetrics();
metrics.setGauge(METRIC_NAMES.providerActive, 0);
metrics.setGauge(METRIC_NAMES.queueWaiting, 0);
metrics.increment(METRIC_NAMES.httpRequests, 42, {
  method: 'GET',
  route: '/api/health',
  status: 200,
});
const budget = new LocalProviderUsageBudget({
  maxCallsPerMinute: 60,
  deploymentMaxCallsPerMinute: 240,
  minimumReservationUsd: 0.01,
  loadPolicies: () => docs.read('budgets', DEFAULT_BUDGET_POLICIES),
});
for (const [i, name] of ['react', 'fastify', 'typescript', 'redis'].entries()) {
  const ownerId = i % 2 ? 'guest:preview-browser' : 'github:900000001';
  await store.saveUser(ownerId, {
    owner_id: ownerId,
    login: i % 2 ? 'guest' : 'isolated-admin',
    display_name: i % 2 ? '隔离预览访客' : '隔离预览管理员',
    kind: i % 2 ? 'guest' : 'github',
    avatar_url: null,
  });
  const project = createProject(
    ownerId,
    `https://github.com/example/${name}`,
    '示例 · ' + name,
    null,
  );
  project.analysis.stage = i === 3 ? 'failed' : 'done';
  const job = newAnalysisJob(project.project_id, 'preview:' + name);
  job.status = i === 3 ? 'failed' : 'succeeded';
  job.created_at = new Date(Date.now() - (i + 1) * 600_000).toISOString();
  job.completed_at = new Date(
    Date.parse(job.created_at) + 43_000 + i * 7100,
  ).toISOString();
  job.error_code = i === 3 ? 'site_analysis_budget_exhausted' : null;
  job.config_version = 0;
  await store.createProjectWithJob(project, job);
  const permit = await budget.acquire({
    ownerId,
    provider: 'mock',
    model: 'isolated-model',
    attribution: {
      business: 'analysis',
      payer: 'platform',
      agentRole: 'component-explanation',
      taskId: job.job_id,
      configVersion: 0,
      connectionId: 'preview-only',
    },
  });
  await permit.release({
    usageKnown: true,
    inputTokens: 1800,
    outputTokens: 800,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.015 * (i + 1),
    status: 'completed',
  });
}
await savePlatformVersion(docs,secret,'fixture',{baseVersion:0,connections:[{id:'preview-connection',label:'示例连接（无真实 Key）',provider:'custom',baseUrl:'https://models.example.invalid/v1',apiKey:randomBytes(20).toString('hex'),models:['example-model']}],agents:{}});
await docs.change('preview-evolution',[] as unknown[],rows=>{rows.push({task_id:'example-evolution',skill_id:'component-explanation',status:'awaiting_review',task_payload:{source:'隔离演示反馈',note:'仅作界面示例；审核需要已连接的自进化 Worker。'},candidate_payload:{status:'candidate',candidateVersion:'example-candidate',baseVersion:'example-base',changeSummary:'示例：明确解释代码前先提供文件与行号依据。',diff:'--- before/SKILL.md\n+++ after/SKILL.md\n@@ -1 +1 @@\n- Explain each component.\n+ Explain each component with file and line references.',checks:[{checkId:'example-contract-check',passed:true,elapsedMs:34}]},ledger_payload:{usage:{inputTokens:2400,outputTokens:620,costUsd:0.012},note:'示例数据，不是真实付费调用。'}});});
await docs.audit({
  actor: 'fixture',
  action: 'preview.initialized',
  target: 'isolated_local_data',
  outcome: 'success',
});
const gateway = Fastify({ logger: false });
gateway.get('/oauth/github/start', async (request, reply) => {
  const grant = parseGithubGatewayStartGrant(
    (request.query as { request: string }).request,
    secret,
  );
  if (!grant) return reply.code(403).send({ error: 'invalid_test_grant' });
  const ticket = signGithubGatewayPayload(
    {
      version: 1,
      kind: 'github_oauth_result',
      outcome: 'success',
      nonce: grant.nonce,
      ticket_id: randomUUID(),
      issued_at: Date.now(),
      expires_at: Date.now() + 60000,
      github: {
        id: 900000001,
        login: 'isolated-admin',
        name: '隔离预览管理员',
        avatar_url: null,
      },
    },
    secret,
  );
  return reply
    .header('cache-control', 'no-store')
    .redirect(config.webUrl + '/api/auth/github/callback?ticket=' + ticket);
});
await gateway.listen({ host: '127.0.0.1', port: gatewayPort });
const app = buildApp({
  config,
  store,
  sessions: new PiSessionStore(config.sessionDir),
  memories: new PiMemoryStore(config.memoryDir),
  providerBudget: budget,
  metrics,
});
await app.listen({ host: '127.0.0.1', port });
await writeFile(join(dataDir,'preview-process.json'),JSON.stringify({pid:process.pid,apiPort:port,webPort,gatewayPort}));
console.log(
  `Isolated admin preview API ready at http://127.0.0.1:${port}; fixture root: ${dataDir}`,
);
const stop = async () => {
  await app.close();
  await gateway.close();
  await store.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
