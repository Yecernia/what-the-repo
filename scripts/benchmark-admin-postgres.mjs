// Compile server/tsconfig.test.json, then run:
// node scripts/test-admin-postgres.mjs --performance
// WTR_ADMIN_PERF_ROWS controls total directory nodes (default: 1,000,000).
// This fixture measures PostgreSQL work, not COS, HTTP/network or model latency.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PostgresStore } from '../server/dist-test/persistence/postgres-store.js';
import { AdminRepositories } from '../server/dist-test/admin/repositories.js';
import { createAdminSecurity, registerAdminRoutes, ADMIN_SESSION } from '../server/dist-test/admin/routes.js';
import { runAdminRead } from '../server/dist-test/admin/read-context.js';
import { digest, totp } from '../server/dist-test/admin/security.js';
import { loadConfig } from '../server/dist-test/config.js';
import { createProject, createMessage } from '../server/dist-test/domain/conversation.js';

const url = new URL(process.env.WTR_ADMIN_TEST_DATABASE_URL ?? 'http://invalid');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '15432');
assert.match(url.pathname, /^\/wtr_admin_test_\d+_performance$/);
const rows = Number(process.env.WTR_ADMIN_PERF_ROWS ?? 1_000_000);
assert.ok(Number.isSafeInteger(rows) && rows >= 25 && rows <= 5_000_000);
const root = await mkdtemp(join(tmpdir(), 'wtr-admin-perf-'));
const store = new PostgresStore({ root, databaseUrl: url.toString(),
  migrationsRoot: join(process.cwd(), 'migrations'), poolMax: 1,
  encryptionSecret: 'isolated-admin-performance-secret'.repeat(2) });
const config = { ...loadConfig({}), dataDir: root };
const require = createRequire(new URL('../server/package.json', import.meta.url));
const queries = [];
function traced(pool) {
  return new Proxy(pool, { get(target, name) {
    if (name !== 'query') return Reflect.get(target, name, target);
    return async (sql, params) => {
      queries.push({ sql, params });
      return target.query(sql, params);
    };
  } });
}
const admin = new AdminRepositories(store, config, traced(store.adminPool));
const accounting = new AdminRepositories(store, config, traced(store.collectorPool ?? store.pool));
async function timed(label, fn) {
  const start = performance.now();
  const value = await fn();
  console.log(JSON.stringify({ label, ms: +(performance.now() - start).toFixed(2) }));
  return value;
}
async function explain(label, query) {
  const result = await store.pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.sql, query.params);
  const plan = result.rows[0]['QUERY PLAN'][0];
  const nodes = [];
  const visit = node => {
    nodes.push({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
      rows: node['Actual Rows'], loops: node['Actual Loops'],
      hit: node['Shared Hit Blocks'], read: node['Shared Read Blocks'] });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan.Plan);
  console.log(JSON.stringify({ label, executionMs: plan['Execution Time'],
    planningMs: plan['Planning Time'], nodes }));
}
try {
  await store.init();
  console.log(JSON.stringify({ repositories: 25, rows,
    postgres: (await store.pool.query('SHOW server_version')).rows[0].server_version,
    cache_scope: 'First application call after seeding; PostgreSQL/OS caches are not flushed.' }));
  const keys = [];
  await timed('seed', async () => {
    await store.saveUser('github:perf', { login: 'perf', display_name: 'Performance fixture' });
    for (let i = 0; i < 25; i++) {
      const key = createHash('sha256').update('perf-' + i).digest('hex');
      keys.push(key);
      const repository = 'perf/r' + i.toString().padStart(2, '0');
      await store.pool.query(`INSERT INTO canonical_public_repository_snapshots
        (public_snapshot_key,repository_identity,commit_sha,analyzer_bundle_version,analysis_config_digest,
         analysis_snapshot_id,source_storage_key)
        VALUES($1,$2,'commit','perf','perf',$3,'')`, [key, repository, 'perf-' + i]);
      const generation = await store.pool.query(`INSERT INTO snapshot_directory_generations
        (public_snapshot_key,snapshot_id) VALUES($1,$2) RETURNING directory_id`, [key, 'perf-' + i]);
      const count = Math.floor(rows / 25) + (i < rows % 25 ? 1 : 0);
      await store.pool.query(`INSERT INTO snapshot_directory_nodes
        (directory_id,row_no,node_key,entity_kind,depth,path,search_text,projection_kinds)
        SELECT $1,n-1,'fact:n'||n,'file',0,'src/'||n||'.ts','node '||n,ARRAY[]::text[]
        FROM generate_series(1,$2::int) n`, [generation.rows[0].directory_id, count]);
      await store.pool.query(`INSERT INTO snapshot_query_directories
        (public_snapshot_key,snapshot_id,directory_id,schema_version,directory_digest,node_count,edge_count,evidence_count,layer_count,value_point_count)
        VALUES($1,$2,$3,3,'perf',$4,0,0,0,0)`, [key, 'perf-' + i, generation.rows[0].directory_id, count]);
      const project = createProject('github:perf', 'https://github.com/' + repository, 'Fixture');
      project.analysis.canonical_snapshot_key = key;
      project.analysis.snapshot_id = 'perf-' + i;
      project.analysis.stage = 'done';
      project.messages.push(createMessage('user', 'fixture', { analysis_snapshot_id: 'perf-' + i }));
      await store.saveProject(project);
    }
    await store.pool.query('ANALYZE');
  });
  const first = await timed('stored_first', () => admin.stored(1));
  assert.equal(first.storedRepositories.length, 25);
  assert.ok(first.storedRepositories.every(row => row.user_count === 1 && row.last_conversation_at));
  await timed('stored_warm_10', async () => { for (let i = 0; i < 10; i++) await admin.stored(1); });
  queries.length = 0;
  await timed('accounting_first', () => accounting.refreshAccounting());
  const accountingQueries = queries.slice();
  await timed('accounting_remaining_24', async () => {
    for (let i = 0; i < 24; i++) await accounting.refreshAccounting();
  });
  const measured = await admin.stored(1);
  assert.ok(measured.storedRepositories.every(row => row.database_bytes > 0));
  assert.ok(measured.storedRepositories.every(row => row.database_index_bytes > 0));
  // Explain the real SQL emitted by accounting, without maintaining a SQL copy.
  const relevant = accountingQueries.filter(q => typeof q.sql === 'string' &&
    /^\s*(SELECT|WITH)/i.test(q.sql) && !/\b(UPDATE|INSERT|DELETE)\b/i.test(q.sql) &&
    /pg_class|snapshot_directory|AS selected/.test(q.sql));
  for (const query of relevant) {
    // Keep large tables and catalog/metadata reads; omit dozens of empty tables.
    if (/pg_class|snapshot_directory_nodes|snapshot_directory_generations/.test(query.sql)) {
      await explain('sql_first_explain', query);
      await explain('sql_warm_explain', query);
    }
  }
  const deps = { store, config: { ...config, nodeEnv: 'test', adminGithubId: '123',
    keyEncryptionSecret: 'isolated-admin-performance-secret'.repeat(2),
    adminBootstrapHash: digest('performance-bootstrap') } };
  const security = createAdminSecurity(deps);
  const challenge = await security.beginGithub('github:123');
  const enrollment = await security.enroll(challenge, 'performance-bootstrap');
  const session = await security.confirm(challenge, totp(enrollment.seed, Math.floor(Date.now() / 30_000)));
  const app = require('fastify')();
  await app.register(require('@fastify/cookie'));
  registerAdminRoutes(app, deps, security);
  await app.ready();
  // Hold every ordinary and collector connection throughout concurrent reads.
  const held = await store.pool.connect();
  let collectorHeld;
  try {
    collectorHeld = await store.collectorPool.connect();
    let timeout;
    await timed('stored_ordinary_pool_exhausted_8', () => Promise.race([
      Promise.all(Array.from({ length: 8 }, () => admin.stored(1))).then(results => {
        assert.ok(results.every(result => result.storedRepositories.length === 25));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('admin_pool_isolation_timeout')), 10_000); }),
    ]).finally(() => clearTimeout(timeout)));
    await timed('overview_authenticated_exhausted_pools_8', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => app.inject({
        url: '/api/admin/overview', headers: { cookie: `${ADMIN_SESSION}=${session.token}` },
      })));
      for (const result of results) {
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().health.database, true);
      }
    });
  } finally { held.release(); collectorHeld?.release(); await app.close(); }
  await timed('admin_statement_timeout', async () => {
    await assert.rejects(runAdminRead('/performance', () => store.adminPool.query('SELECT pg_sleep(5)')),
      { code: '57014' });
  });
  assert.equal((await store.adminPool.query('SELECT 1 AS n')).rows[0].n, 1);
  assert.equal(store.adminPool.waitingCount, 0);
  assert.equal(store.adminPool.idleCount, store.adminPool.totalCount);
  console.log(JSON.stringify({ verified: '25 repositories, cached accounting, conversation attribution and isolated reads',
    ordinaryPoolMax: 1, adminPoolMax: store.adminPool.options.max }));
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
