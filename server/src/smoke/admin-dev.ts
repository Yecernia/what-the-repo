/** Persistent loopback development environment. Never imported by production. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { buildApp } from '../api/app.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import { AdminSecurity, digest, totp } from '../admin/security.js';
import { adminDocuments } from '../admin/runtime-config.js';
import { PostgresProviderUsageBudget } from '../agent/provider-budget.js';
import { RuntimeMetrics, METRIC_NAMES } from '../observability/metrics.js';
import { collectRuntimeObservations } from '../admin/observations.js';
import { parseGithubGatewayStartGrant, signGithubGatewayPayload } from '../github-gateway/protocol.js';
import { developmentStore, seedDevelopmentRecords, seedDevelopmentRepositories, setDevelopmentAudience, SCENARIOS, type Scenario } from './admin-dev-data.js';

if (process.env.NODE_ENV === 'production') throw new Error('Development entry cannot run in production');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = join(root, '.local/admin-preview-dev');
await mkdir(dataDir, { recursive: true });
const credentialPath = join(dataDir, 'credentials.json');
let credentials: { secret: string; bootstrap: string; seed?: string };
try { credentials = JSON.parse(await readFile(credentialPath, 'utf8')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  credentials = { secret: randomBytes(40).toString('hex'), bootstrap: randomBytes(32).toString('base64url') };
  await writeFile(credentialPath, JSON.stringify(credentials), { mode: 0o600 });
}
const webUrl = 'http://127.0.0.1:5391', controlUrl = 'http://127.0.0.1:8491';
const config = { ...loadConfig({ WHAT_THE_REPO_ROOT: root, NODE_ENV: 'test' }),
  nodeEnv: 'test', host: '127.0.0.1', port: 8391, dataDir, retentionEnabled: false,
  sessionDir: join(dataDir, 'sessions'), memoryDir: join(dataDir, 'memory'), skillVersionsRoot: join(dataDir, 'skills'),
  freeProviderApiKey: null, analysisProviderApiKey: null, feedbackProviderApiKey: null, webSearchApiKey: null,
  redisUrl: null, webUrl, adminGithubId: '900000001', adminBootstrapHash: digest(credentials.bootstrap),
  keyEncryptionSecret: credentials.secret, sessionSecret: credentials.secret,
  githubGatewayUrl: controlUrl, githubGatewaySharedSecret: credentials.secret };
const store = await developmentStore(root, dataDir, credentials.secret);
const docs = adminDocuments(store);
await seedDevelopmentRecords(store);
await seedDevelopmentRepositories(store);
// Bind a dedicated test authenticator through the existing security service.
// The real administrator's identity, seed and sessions are never read or reused.
const security = new AdminSecurity(docs, { githubId: config.adminGithubId,
  bootstrapHash: config.adminBootstrapHash, encryptionSecret: credentials.secret, production: false });
if (!(await security.status('', '')).enrolled) {
  const challenge = await security.beginGithub('github:' + config.adminGithubId);
  const enrollment = await security.enroll(challenge, credentials.bootstrap);
  credentials.seed = enrollment.seed;
  await writeFile(credentialPath, JSON.stringify(credentials), { mode: 0o600 });
  await security.confirm(challenge, totp(enrollment.seed, Math.floor(Date.now() / 30_000)));
}
if (!credentials.seed) throw new Error('Development authenticator file missing');
let scenario = (await docs.read('development-scenario', { value: 'normal' as Scenario })).value;
let sampling: Promise<void> | null = null;
const refresh = () => sampling ??= setDevelopmentAudience(store, scenario).finally(() => { sampling = null; });
await refresh();
const timer = setInterval(() => { void refresh().catch(() => console.error('development_fixture_refresh_failed')); }, 60_000);
const metrics = new RuntimeMetrics();
metrics.setGauge(METRIC_NAMES.providerActive, 0);
const stopObservations = collectRuntimeObservations(store, 'api', metrics);
const app = buildApp({ config, store, metrics,
  sessions: new PiSessionStore(config.sessionDir), memories: new PiMemoryStore(config.memoryDir),
  providerBudget: new PostgresProviderUsageBudget(store.pool, { maxCallsPerMinute: 60,
    deploymentMaxCallsPerMinute: 240, minimumReservationUsd: 0.01 }) });
app.get('/api/__admin-dev/status', async () => ({ environment: 'isolated-admin-development', scenario, synthetic: true }));
// Avoid leaving a synthetic publication command waiting forever: no worker exists here.
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'GET' && /^\/api\/admin\/evolution\//.test(request.url))
    return reply.code(409).send({ error: 'admin_development_preview_only', message: '模拟候选仅供界面验收，不执行发布。' });
});
const gateway = Fastify({ logger: false });
gateway.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_, body, done) => done(null, new URLSearchParams(body as string)));
gateway.addHook('onRequest', async (request, reply) => {
  if (request.headers.host !== '127.0.0.1:8491') return reply.code(403).send('Loopback only');
  reply.header('cache-control', 'no-store').header('x-frame-options', 'DENY');
});
gateway.get('/oauth/github/start', async (request, reply) => {
  const grant = parseGithubGatewayStartGrant((request.query as { request: string }).request, credentials.secret);
  if (!grant) return reply.code(403).send({ error: 'invalid_test_grant' });
  const ticket = signGithubGatewayPayload({ version: 1, kind: 'github_oauth_result', outcome: 'success',
    nonce: grant.nonce, ticket_id: randomUUID(), issued_at: Date.now(), expires_at: Date.now() + 60_000,
    github: { id: 900000001, login: 'sample-maintainer', name: '本机模拟维护者', avatar_url: null } }, credentials.secret);
  return reply.redirect(webUrl + '/api/auth/github/callback?ticket=' + ticket);
});
const labels: Record<Scenario, string> = { normal: '完整 24 小时 · 日间起伏与高峰', low: '低人数 · 0–2 人', gap: '采集缺口 · 小时和分钟断点', empty: '没有历史数据', stale: '采集过期 · 最后数据在 15 分钟前' };
gateway.get('/', async (_, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理台 · 本机开发数据</title><style>body{max-width:720px;margin:60px auto;padding:24px;font:16px/1.7 system-ui;color:#263b32;background:#f8f7f3}section{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}a{color:#285b47}button,select{font:inherit;padding:10px;max-width:100%;margin:8px 0}code{font-size:32px;letter-spacing:8px}small{color:#68736e}</style><h1>管理台 · 本机开发数据</h1><p>此处全部是可重复生成的模拟数据，存放在独立的本机 PostgreSQL 数据库。没有连接生产数据库、COS 或付费模型。</p><section><h2>打开管理台</h2><a href="${webUrl}/admin">进入可热更新的管理台 →</a><p>点击 GitHub 登录后会使用本机模拟身份。二步验证请输入下面的测试验证码：</p><code>${totp(credentials.seed!, Math.floor(Date.now() / 30_000))}</code><p><small>仅用于这个本机测试账号；每 30 秒变化，刷新此页可获取新码。无需使用你手机上的真实验证器。</small></p></section><section><h2>切换图表数据</h2><p>当前场景：${labels[scenario]}</p><form method="post" action="/scenario"><label>数据场景<br><select name="scenario">${SCENARIOS.map(s => `<option value="${s}" ${s === scenario ? 'selected' : ''}>${labels[s]}</option>`).join('')}</select></label><br><button>应用场景</button></form><small>仅替换这个开发库中的模拟人数数据。切换后回管理台点击刷新；配置和登录状态保留。</small></section><p>前端修改自动热更新；服务端修改自动重启；模拟趋势每分钟更新。候选与发布历史用于展示，没有连接发布 Worker。</p></html>`));
gateway.post('/scenario', async (request, reply) => {
  if (request.headers.origin !== controlUrl) return reply.code(403).send('Origin rejected');
  const value = (request.body as URLSearchParams).get('scenario');
  if (!SCENARIOS.includes(value as Scenario)) return reply.code(400).send('Unknown scenario');
  if (sampling) await sampling;
  scenario = value as Scenario;
  await refresh();
  await docs.change('development-scenario', { value: scenario }, v => { v.value = scenario; });
  return reply.redirect('/');
});
await gateway.listen({ host: '127.0.0.1', port: 8491 });
await app.listen({ host: '127.0.0.1', port: 8391 });
console.log('Admin development ready: http://127.0.0.1:5391/admin; data controls: http://127.0.0.1:8491/');
const stop = async () => { clearInterval(timer); stopObservations(); if (sampling) await sampling;
  await app.close(); await gateway.close(); await store.close(); process.exit(0); };
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
