import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
// Compile server/tsconfig.test.json first. Default: management integration tests;
// --publication: publication/reclamation regressions; --performance: 25-repository benchmark.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/package.json'));
const { Pool } = require('pg');
const data = await readFile(join(root, '.secrets/local.env'), 'utf8');
const env = {};
for (const line of data.split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const source =
  env.DATABASE_URL ??
  env.WHAT_THE_REPO_DATABASE_URL ??
  (env.POSTGRES_PASSWORD
    ? `postgresql://${encodeURIComponent(env.POSTGRES_USER ?? 'repo_onboarding')}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:15432/${encodeURIComponent(env.POSTGRES_DB ?? 'repo_onboarding')}`
    : undefined);
if (!source) throw new Error('Local database URL unavailable');
const url = new URL(source);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '15432')
  throw new Error('Only the local development database is allowed');
url.hostname = '127.0.0.1';
const admin = new Pool({ connectionString: url.toString(), max: 1 });
// Each test file owns its fixture: queued jobs in one suite must not block
// cleanup/accounting in another. The optional performance suite is opt-in.
const performance = process.argv.includes('--performance');
const publication = process.argv.includes('--publication');
if (performance && publication) throw new Error('Choose one test mode');
const tests = performance ? [['performance', 'WTR_ADMIN_TEST_DATABASE_URL']]
  : publication ? [
    ['persistence/directory-parallel.postgres', 'WTR_ADMIN_TEST_DATABASE_URL'],
    ['persistence/publication-pipeline.postgres', 'WTR_PUBLICATION_TEST_DATABASE_URL'],
    ['persistence/publication-concurrency.postgres', 'WTR_PUBLICATION_TEST_DATABASE_URL'],
    ['persistence/directory-reclamation.postgres', 'WTR_RECLAMATION_TEST_DATABASE_URL'],
  ] : ['postgres', 'routes', 'repositories', 'storage-accounting.postgres']
    .map(test => ['admin/' + test, 'WTR_ADMIN_TEST_DATABASE_URL']);
try {
  for (const [test, variable] of tests) {
    const suffix = test.split('/').at(-1).replaceAll('.', '_').replaceAll('-', '_');
    const prefix = variable === 'WTR_RECLAMATION_TEST_DATABASE_URL' ? 'wtr_admin_test_reclamation_' : 'wtr_admin_test_';
    const name = `${prefix}${Date.now()}_${suffix.slice(0, 20)}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      url.pathname = '/' + name;
      const child = spawn(
        process.execPath,
        performance ? [join(root, 'scripts/benchmark-admin-postgres.mjs')] : [
          '--test', '--test-concurrency=1', `dist-test/${test}.test.js`,
        ],
        {
          cwd: join(root, 'server'),
          env: { ...process.env, [variable]: url.toString() },
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
      });
      if (code) process.exitCode = code;
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  }
} catch (error) {
  console.error('Isolated PostgreSQL test failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await admin.end();
}
