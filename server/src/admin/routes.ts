import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerDependencies } from '../api/app.js';
import { AdminSecurity, adminError } from './security.js';
import {
  adminDocuments,
  ADMIN_AGENT_ROLES,
  publicVersion,
  savePlatformVersion,
  verifyPlatformConnection,
  type PlatformHistory,
} from './runtime-config.js';
import {
  DEFAULT_BUDGET_POLICIES,
  BUDGET_KEYS,
  beijingBudgetDay,
  validateBudgetPolicies,
  LocalProviderUsageBudget,
} from '../agent/provider-budget.js';
import { StorageManager, type StoragePolicy } from './storage.js';
import { audienceCounts } from './audience.js';
import { AdminRepositories } from './repositories.js';
import { defaultRuntimeMetrics } from '../observability/metrics.js';
import { CONFIGURABLE_PROVIDER_IDS } from '../agent/provider-catalog.js';

export const ADMIN_SESSION = 'what_the_repo_admin';
export const ADMIN_CHALLENGE = 'what_the_repo_admin_challenge';
export function adminCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  production: boolean,
  maxAge: number,
) {
  reply.setCookie(name, value, {
    httpOnly: true,
    sameSite: 'strict',
    secure: production,
    path: '/api/admin',
    maxAge,
  });
}
const body = (request: FastifyRequest) => {
  if (
    !request.body ||
    typeof request.body !== 'object' ||
    Array.isArray(request.body)
  )
    throw adminError(400, 'admin_invalid_request');
  return request.body as Record<string, unknown>;
};
const text = (row: Record<string, unknown>, name: string, max = 256) =>
  typeof row[name] === 'string' ? (row[name] as string).slice(0, max) : '';
async function readRows(root: string, folder: string) {
  const names = await readdir(join(root, folder)).catch(() => []);
  return Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .slice(-1000)
      .map(
        async (n) =>
          JSON.parse(await readFile(join(root, folder, n), 'utf8')) as Record<
            string,
            unknown
          >,
      ),
  );
}
export function createAdminSecurity(deps: ServerDependencies) {
  if (
    deps.config.adminGithubId &&
    deps.config.nodeEnv === 'production' &&
    !adminDocuments(deps.store).pool
  )
    throw new Error('Admin production requires PostgreSQL');
  return new AdminSecurity(adminDocuments(deps.store), {
    githubId: deps.config.adminGithubId,
    encryptionSecret: deps.config.keyEncryptionSecret,
    bootstrapHash: deps.config.adminBootstrapHash,
    production: deps.config.nodeEnv === 'production',
  });
}

export function registerAdminRoutes(
  app: FastifyInstance,
  deps: ServerDependencies,
  security: AdminSecurity,
) {
  const { store, config } = deps,
    docs = adminDocuments(store),
    storage = new StorageManager(store, config),
    repositories = new AdminRepositories(store, config),
    production = config.nodeEnv === 'production';
  const actor = `github:${config.adminGithubId}`;
  void app.register(
    async (admin) => {
      admin.addHook('onRequest', async (request, reply) => {
        reply
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('x-content-type-options', 'nosniff');
        if (!security.enabled) throw adminError(404, 'admin_unavailable');
        if (request.method !== 'GET') {
          const origin = request.headers.origin;
          const allowed = [
            new URL(config.webUrl).origin,
            ...(config.adminWebUrl ? [new URL(config.adminWebUrl).origin] : []),
          ];
          if (
            request.headers['x-admin-request'] !== '1' ||
            (origin && !allowed.includes(origin))
          )
            throw adminError(403, 'admin_csrf');
        }
      });
      admin.setErrorHandler(async (error, request, reply) => {
        const status =
          typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
        const code =
          error instanceof Error &&
          /^(admin|site|storage)_[a-z_]+$/.test(error.message)
            ? error.message
            : 'admin_operation_failed';
        if (
          request.method !== 'GET' &&
          !request.routeOptions.url?.includes('/auth/')
        )
          await docs
            .audit({
              actor:
                code === 'admin_session_required' ? 'unauthenticated' : actor,
              action:
                request.method +
                ' ' +
                (request.routeOptions.url ?? '/api/admin'),
              target: 'management',
              outcome: 'failed:' + code,
            })
            .catch(() => undefined);
        void reply.code(status).send({ code, detail: code });
      });
      admin.addHook('preHandler', async (request) => {
        if (request.routeOptions.url?.startsWith('/api/admin/auth/')) return;
        await security.authorize(
          request.cookies[ADMIN_SESSION] ?? '',
          request.method === 'GET'
            ? undefined
            : String(request.headers['x-admin-csrf'] ?? ''),
        );
      });
      admin.get('/auth/status', async (request) => ({
        ...(await security.status(
          request.cookies[ADMIN_CHALLENGE] ?? '',
          request.cookies[ADMIN_SESSION] ?? '',
        )),
        isolatedPreview: config.nodeEnv === 'test',
      }));
      for (const operation of [
        'enroll',
        'confirm',
        'verify',
        'replace',
        'recover',
      ] as const)
        admin.post('/auth/' + operation, async (request, reply) => {
          const input = body(request),
            challenge = request.cookies[ADMIN_CHALLENGE] ?? '';
          try {
            const result =
              operation === 'enroll'
                ? await security.enroll(challenge, text(input, 'bootstrap'))
                : operation === 'confirm'
                  ? await security.confirm(challenge, text(input, 'code'))
                  : operation === 'verify'
                    ? await security.verify(challenge, text(input, 'code'))
                    : await security.replace(
                        challenge,
                        text(input, 'code'),
                        operation === 'recover',
                      );
            await docs.audit({
              actor,
              action: 'auth.' + operation,
              target: 'authenticator',
              outcome: 'success',
            });
            if ('token' in result) {
              adminCookie(
                reply,
                ADMIN_SESSION,
                result.token,
                production,
                8 * 3600,
              );
              reply.clearCookie(ADMIN_CHALLENGE, { path: '/api/admin' });
              const { token, ...publicResult } = result;
              void token;
              return publicResult;
            }
            return result;
          } catch (error) {
            await docs.audit({
              actor,
              action: 'auth.' + operation,
              target: 'authenticator',
              outcome: 'failed',
            });
            throw error;
          }
        });
      admin.post('/auth/logout', async (request, reply) => {
        await security.authorize(
          request.cookies[ADMIN_SESSION] ?? '',
          String(request.headers['x-admin-csrf'] ?? ''),
        );
        await security.logout(request.cookies[ADMIN_SESSION] ?? '');
        reply.clearCookie(ADMIN_SESSION, { path: '/api/admin' });
        reply.clearCookie(ADMIN_CHALLENGE, { path: '/api/admin' });
        await docs.audit({
          actor,
          action: 'auth.logout',
          target: 'session',
          outcome: 'success',
        });
        return { ok: true };
      });
      admin.get('/overview', async () => {
        const health = await store.checkHealth().then(
          () => true,
          () => false,
        );
        await deps.metricsRefresh?.().catch(() => undefined);
        const jobs = await store.listJobs();
        const now = Date.now();
        const presence = docs.pool
          ? (
              await docs.pool.query(
                `SELECT kind,COUNT(*)::int AS count FROM online_presence p JOIN app_users u USING(owner_id) WHERE u.deleted_at IS NULL AND p.seen_at>clock_timestamp()-interval '90 seconds' GROUP BY kind`,
              )
            ).rows
          : [];
        const local = await docs.read<
          Record<string, { kind: string; seen: number }>
        >('presence', {});
        const counts = docs.pool
          ? Object.fromEntries(presence.map((p) => [p.kind, p.count]))
          : Object.fromEntries(
              ['github', 'guest'].map((kind) => [
                kind,
                Object.values(local).filter(
                  (p) => p.kind === kind && p.seen > now - 90_000,
                ).length,
              ]),
            );
        const observations = docs.pool
          ? (
              await docs.pool.query(
                `SELECT role,instance_id,payload,observed_at,observed_at>clock_timestamp()-interval '45 seconds' AS fresh FROM runtime_observations ORDER BY role`,
              )
            ).rows
          : [];
        const audience = docs.pool ? await audienceCounts(docs.pool) : null;
        const audienceHistory = docs.pool ? (await docs.pool.query(
          `SELECT observed_at,github,guest,online_github,online_guest FROM admin_audience_samples WHERE minute>statement_timestamp()-interval '24 hours' ORDER BY minute`,
        )).rows : [];
        return {
          audience,
          audienceHistory,
          health: { database: health, api: true },
          observedAt: new Date().toISOString(),
          online: {
            windowSeconds: 90,
            github: counts.github ?? 0,
            guest: counts.guest ?? 0,
            guestApproximate: true,
          },
          jobs: {
            queued: jobs.filter((j) => j.status === 'queued').length,
            running: jobs.filter((j) => j.status === 'running').length,
            failed: jobs.filter((j) => j.status === 'failed').length,
          },
          metrics: (deps.metrics ?? defaultRuntimeMetrics).snapshot(),
          observations,
          budgets: (await readBudgets()).budgets,
          tuning: {
            chatConcurrency: config.chatConcurrency ?? 8,
            chatOwnerConcurrency: config.chatOwnerConcurrency ?? 2,
            chatQueueLimit: config.chatQueueLimit ?? 16,
            chatWaitTimeoutMs: config.chatWaitTimeoutMs ?? 30_000,
            chatDisconnectGraceMs: config.chatDisconnectGraceMs ?? 30_000,
            chatModelConcurrency: config.chatModelConcurrency ?? 8,
            analysisPendingLimit: config.analysisPendingLimit ?? 32,
            analysisFetchConcurrency: config.analysisFetchConcurrency ?? 2,
            analysisCpuConcurrency: config.analysisCpuConcurrency ?? 2,
            analysisPublishConcurrency: config.analysisPublishConcurrency ?? 1,
            analysisMemoryMb: config.analysisMemoryMb ?? 6144,
            objectStoreConcurrency: config.objectStoreConcurrency ?? 8,
            analysisOwnerConcurrency: config.analysisOwnerConcurrency ?? 2,
            analysisOwnerQueueLimit: config.analysisOwnerQueueLimit ?? 4,
            analysisQueueLimit: config.analysisQueueLimit ?? 32,
            analysisModelConcurrency: config.analysisModelConcurrency ?? 8,
            upstreamCapacityRules: config.upstreamCapacities?.length ?? 0,
          },
        };
      });
      admin.get('/activity', async (request) => {
        const requestedPage = Number((request.query as { user_page?: string }).user_page ?? 1);
        const pageSize = 25;
        const userFilter = "(owner_id LIKE 'github:%' OR owner_id LIKE 'guest:%')";
        const localUsers = docs.pool ? [] : (await readRows(store.root, 'users'))
          .filter(u => /^(github|guest):/.test(String(u.owner_id)))
          .sort((a, b) => String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')) || String(a.owner_id).localeCompare(String(b.owner_id)));
        const totalUsers = docs.pool ? Number((await docs.pool.query(`SELECT COUNT(*) AS count FROM app_users WHERE ${userFilter}`)).rows[0].count) : localUsers.length;
        const userPages = Math.max(1, Math.ceil(totalUsers / pageSize));
        const userPage = Math.min(userPages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
        const users = docs.pool
          ? (
              await docs.pool.query(
                `SELECT u.owner_id,u.login,u.display_name,u.last_seen_at,u.created_at,u.deleted_at,u.purge_after,
                  COALESCE(u.deleted_at IS NULL AND o.seen_at>clock_timestamp()-interval '90 seconds',false) AS online
                 FROM app_users u LEFT JOIN online_presence o ON o.owner_id=u.owner_id
                 WHERE u.owner_id LIKE 'github:%' OR u.owner_id LIKE 'guest:%'
                 ORDER BY online DESC,u.last_seen_at DESC NULLS LAST,u.owner_id LIMIT $1 OFFSET $2`,
                [pageSize, (userPage - 1) * pageSize],
              )
            ).rows
          : localUsers.slice((userPage - 1) * pageSize, userPage * pageSize);
        const projects = docs.pool
          ? (
              await docs.pool.query(
                `SELECT p.project_id,p.owner_id,u.login,u.display_name,p.payload->>'title' AS title,p.payload->'analysis' AS analysis,p.created_at,p.updated_at FROM projects p LEFT JOIN app_users u ON u.owner_id=p.owner_id ORDER BY p.updated_at DESC LIMIT 500`,
              )
            ).rows
          : (await readRows(store.root, 'projects')).map((p) => ({
              project_id: p.project_id,
              owner_id: p.owner_id,
              login: localUsers.find(u => u.owner_id === p.owner_id)?.login,
              display_name: localUsers.find(u => u.owner_id === p.owner_id)?.display_name,
              title: p.title,
              analysis: p.analysis,
              updated_at: p.updated_at,
            }));
        return {
          users,
          userPagination: { page: userPage, pageSize, total: totalUsers, pages: userPages },
          projects,
          ...(docs.pool ? await repositories.activity((request.query as { repository_page?: string }).repository_page) : { repositories:[], repositoryPagination:{total:0,pages:1,page:1,pageSize:25} }),
          jobs: (await store.listJobs()).slice(-500).reverse(),
          limit: 500,
        };
      });
      admin.get('/config', async () => ({
        roles: ADMIN_AGENT_ROLES,
        providers: CONFIGURABLE_PROVIDER_IDS,
        versions: (
          await docs.read<PlatformHistory>('platform', { versions: [] })
        ).versions.map(publicVersion),
      }));
      admin.put('/config', async (request) =>
        savePlatformVersion(
          docs,
          config.keyEncryptionSecret,
          actor,
          request.body,
        ),
      );
      admin.post('/connections/:id/verify', async (request) => {
        const id = (request.params as { id: string }).id;
        const result = await verifyPlatformConnection(
          docs,
          config.keyEncryptionSecret,
          id,
        );
        await docs.audit({
          actor,
          action: 'connection.verify',
          target: id,
          outcome: result.ok ? 'success' : 'failed',
        });
        return result;
      });
      const readBudgets = async () => {
        const policies = await docs.read('budgets', DEFAULT_BUDGET_POLICIES),
          day = beijingBudgetDay();
        const rows = docs.pool
          ? (
              await docs.pool.query(
                `SELECT business,payer,agent_role,connection_id,config_version,task_id,COUNT(*)::int AS calls,COUNT(*) FILTER(WHERE usage_known IS DISTINCT FROM true)::int AS unknown_calls,COALESCE(SUM(cost_usd) FILTER(WHERE usage_known),0)::float8 AS used,COALESCE(SUM(reserved_cost_usd) FILTER(WHERE usage_known IS DISTINCT FROM true),0)::float8 AS reserved FROM provider_usage_events WHERE started_at >= $1 GROUP BY business,payer,agent_role,connection_id,config_version,task_id`,
                [new Date(day.start).toISOString()],
              )
            ).rows
          : deps.providerBudget instanceof LocalProviderUsageBudget
            ? deps.providerBudget.events
                .filter((e) => e.startedAt >= day.start)
                .map((e) => ({
                  business: e.attribution.business,
                  payer: e.attribution.payer,
                  agent_role: e.attribution.agentRole,
                  connection_id: e.attribution.connectionId,
                  config_version: e.attribution.configVersion,
                  task_id: e.attribution.taskId,
                  calls: 1,
                  unknown_calls: e.report?.usageKnown ? 0 : 1,
                  used: e.report?.usageKnown ? e.report.costUsd : 0,
                  reserved: e.report?.usageKnown ? 0 : e.reservedCostUsd,
                }))
            : [];
        const taskRows = docs.pool
          ? (
              await docs.pool.query(
                `SELECT task_id,COALESCE(SUM(cost_usd) FILTER(WHERE usage_known),0)::float8 AS used,COALESCE(SUM(reserved_cost_usd) FILTER(WHERE usage_known IS DISTINCT FROM true),0)::float8 AS reserved,COUNT(*) FILTER(WHERE usage_known IS DISTINCT FROM true)::int AS unknown_calls FROM provider_usage_events WHERE business='evolution' AND payer='platform' GROUP BY task_id ORDER BY MAX(started_at) DESC LIMIT 100`,
              )
            ).rows
          : deps.providerBudget instanceof LocalProviderUsageBudget
            ? Object.values(
                deps.providerBudget.events
                  .filter(
                    (e) =>
                      e.attribution.business === 'evolution' &&
                      e.attribution.payer === 'platform',
                  )
                  .reduce<
                    Record<
                      string,
                      {
                        task_id: string;
                        used: number;
                        reserved: number;
                        unknown_calls: number;
                      }
                    >
                  >((acc, e) => {
                    const id = e.attribution.taskId ?? 'unknown';
                    const row = (acc[id] ??= {
                      task_id: id,
                      used: 0,
                      reserved: 0,
                      unknown_calls: 0,
                    });
                    row.used += e.report?.usageKnown ? e.report.costUsd : 0;
                    row.reserved += e.report?.usageKnown
                      ? 0
                      : e.reservedCostUsd;
                    row.unknown_calls += e.report?.usageKnown ? 0 : 1;
                    return acc;
                  }, {}),
              )
            : [];
        return {
          timezone: day.timezone,
          resetAt: day.resetAt,
          policies,
          usage: rows,
          tasks: taskRows.map((row) => ({
            ...row,
            remaining:
              policies.evolution_task === null
                ? null
                : Math.max(
                    0,
                    policies.evolution_task -
                      Number(row.used) -
                      Number(row.reserved),
                  ),
          })),
          accounting: 'program_estimate',
          budgets: BUDGET_KEYS.map((key) => {
            const relevant = rows.filter(
              (r) => r.payer === 'platform' && r.business === key.split('_')[0],
            );
            const used =
                key === 'evolution_task'
                  ? null
                  : relevant.reduce((s, r) => s + Number(r.used), 0),
              reserved =
                key === 'evolution_task'
                  ? null
                  : relevant.reduce((s, r) => s + Number(r.reserved), 0);
            return {
              key,
              limit: policies[key],
              used,
              reserved,
              remaining:
                policies[key] === null || used === null
                  ? null
                  : Math.max(0, policies[key]! - used - (reserved ?? 0)),
              unknownCalls: relevant.reduce(
                (s, r) => s + Number(r.unknown_calls),
                0,
              ),
            };
          }),
        };
      };
      admin.get('/budgets', readBudgets);
      admin.put('/budgets', async (request) => {
        let policies;
        try {
          policies = validateBudgetPolicies(request.body);
        } catch {
          throw adminError(400, 'admin_invalid_budget');
        }
        await docs.change(
          'budgets',
          DEFAULT_BUDGET_POLICIES,
          (value) => Object.assign(value, policies),
          {
            actor,
            action: 'budget.update',
            target: 'business_budgets',
            outcome: 'success',
          },
        );
        return policies;
      });
      admin.get('/feedback', async () => {
        const localUsers = docs.pool ? [] : await readRows(store.root, 'users');
        return ({
        feedback: docs.pool
          ? (
              await docs.pool.query(
                `SELECT m.message_id,m.project_id,p.owner_id,u.login,u.display_name,m.payload->'feedback' AS feedback FROM project_messages m JOIN projects p ON p.project_id=m.project_id LEFT JOIN app_users u ON u.owner_id=p.owner_id WHERE m.payload->'feedback' IS NOT NULL AND m.payload->'feedback'<>'null'::jsonb ORDER BY m.sequence DESC LIMIT 200`,
              )
            ).rows
          : (await readRows(store.root, 'projects'))
              .flatMap((p) =>
                (Array.isArray(p.messages) ? p.messages : [])
                  .filter((m) => m.feedback)
                  .map((m) => ({
                    message_id: m.message_id,
                    project_id: p.project_id,
                    owner_id: p.owner_id,
                    login: localUsers.find(u => u.owner_id === p.owner_id)?.login,
                    display_name: localUsers.find(u => u.owner_id === p.owner_id)?.display_name,
                    feedback: m.feedback,
                  })),
              )
              .slice(-200)
              .reverse(),
        requests: await store.listEvolutionFeedbackRequests(),
        tasks: docs.pool
          ? (
              await docs.pool.query(
                'SELECT task_id,skill_id,status,task_payload,ledger_payload,candidate_payload,review_decision_payload,updated_at FROM evolution_tasks ORDER BY updated_at DESC LIMIT 100',
              )
            ).rows
          : await docs.read('preview-evolution', []),
        commands: docs.pool
          ? (
              await docs.pool.query(
                'SELECT id,task_id,action,status,result,created_at FROM admin_evolution_commands ORDER BY created_at DESC LIMIT 50',
              )
            ).rows
          : [],
      }); });
      admin.post('/evolution/:id/:action', async (request) => {
        const { id, action } = request.params as { id: string; action: string };
        const input = body(request);
        if (!docs.pool)
          throw adminError(503, 'admin_evolution_worker_unavailable');
        if (!['approve', 'reject', 'rollback'].includes(action))
          throw adminError(400, 'admin_invalid_action');
        if (input.confirm !== true)
          throw adminError(400, 'admin_confirmation_required');
        if (action === 'reject' && !text(input, 'reason', 2000).trim())
          throw adminError(400, 'admin_reason_required');
        const candidate = (
          await docs.pool.query(
            'SELECT candidate_payload FROM evolution_tasks WHERE task_id=$1',
            [id],
          )
        ).rows[0]?.candidate_payload;
        if (!candidate) throw adminError(404, 'admin_candidate_missing');
        const commandId = randomUUID();
        await docs.pool.query(
          `INSERT INTO admin_evolution_commands(id,task_id,actor,action,reason,candidate_version,status) VALUES($1,$2,$3,$4,$5,$6,'pending')`,
          [
            commandId,
            id,
            actor,
            action,
            text(input, 'reason', 2000),
            candidate.candidateVersion,
          ],
        );
        await docs.audit({
          actor,
          action: 'evolution.' + action,
          target: id,
          outcome: 'queued',
        });
        return { id: commandId, status: 'pending' };
      });
      admin.get('/audit', async () => ({ entries: await docs.auditList() }));
      admin.get('/repositories/users', async (request) => {
        const q=request.query as {repository?:string;kind?:string;batch?:string};
        return repositories.users(q.repository ?? '',q.kind ?? '',q.batch ?? '');
      });
      admin.get('/repositories/delete-plan', async (request) => repositories.deletionPlan((request.query as {repository?:string}).repository ?? ''));
      admin.post('/repositories/delete', async (request) => {
        const input=body(request), repository=text(input,'repository');
        const plan=await repositories.deletionPlan(repository);
        if(input.confirm!==repository || input.token!==plan.token) throw adminError(409,'admin_repository_changed');
        if(plan.active_tasks) throw adminError(409,'admin_snapshot_busy');
        const adapter=store as typeof store & { adminDeleteRepository?: (repository:string,token:string,actor:string) => Promise<void> };
        if(!adapter.adminDeleteRepository) throw adminError(503,'admin_requires_postgres');
        try {
          await adapter.adminDeleteRepository(repository,plan.token,actor);
          await docs.audit({actor,action:'repository.delete',target:repository,outcome:'success'});
          return {deleted:true};
        } catch(error) {
          await docs.audit({actor,action:'repository.delete',target:repository,outcome:'failed'});
          throw error;
        }
      });
      admin.get('/storage', async (request) => ({...await storage.candidates(),
        ...(docs.pool ? await repositories.stored((request.query as {repository_page?:string}).repository_page) : {storedRepositories:[],storedPagination:{total:0,pages:1,page:1,pageSize:25}})}));
      admin.put('/storage/policy', async (request) => {
        await storage.updatePolicy(request.body as StoragePolicy, actor);
        return storage.status();
      });
      admin.post('/storage/inventory', async () => {
        const result = await storage.refreshInventory();
        await docs.audit({
          actor,
          action: 'storage.inventory',
          target: 'object_store',
          outcome: 'success',
        });
        return {
          observedAt: result.observedAt,
          objects: result.objects.length,
        };
      });
      admin.post('/storage/:key/delete', async (request) => {
        const key = (request.params as { key: string }).key;
        if (body(request).confirm !== key)
          throw adminError(400, 'admin_confirmation_required');
        try {
          const result = await storage.remove(key);
          await docs.audit({
            actor,
            action: 'storage.delete',
            target: key,
            outcome: 'success',
          });
          return result;
        } catch (error) {
          await docs.audit({
            actor,
            action: 'storage.delete',
            target: key,
            outcome: 'failed',
          });
          throw error;
        }
      });
    },
    { prefix: '/api/admin' },
  );
}

export async function recordPresence(
  deps: Pick<ServerDependencies,'store'>,
  owner: { owner_id: string; kind: string },
) {
  const docs = adminDocuments(deps.store);
  if (docs.pool) {
    await docs.pool.query(
      `INSERT INTO online_presence(owner_id,kind,seen_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(owner_id) DO UPDATE SET kind=EXCLUDED.kind,seen_at=EXCLUDED.seen_at`,
      [owner.owner_id, owner.kind],
    );
    await docs.pool.query(
      `DELETE FROM online_presence WHERE seen_at<clock_timestamp()-interval '1 day'`,
    );
  } else
    await docs.change<Record<string, { kind: string; seen: number }>, void>(
      'presence',
      {},
      (rows) => {
        for (const [id, row] of Object.entries(rows))
          if (row.seen < Date.now() - 90_000) delete rows[id];
        rows[owner.owner_id] = { kind: owner.kind, seen: Date.now() };
      },
    );
  return { windowSeconds: 90 };
}
