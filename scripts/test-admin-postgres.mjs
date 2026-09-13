import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
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
const name = 'wtr_admin_test_' + Date.now();
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname = '/' + name;
  const child = spawn(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      'dist-test/admin/postgres.test.js',
      'dist-test/admin/routes.test.js',
      'dist-test/admin/repositories.test.js',
    ],
    {
      cwd: join(root, 'server'),
      env: { ...process.env, WTR_ADMIN_TEST_DATABASE_URL: url.toString() },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once('exit', (code) => resolve(code ?? 1)),
  );
} catch (error) {
  console.error('Isolated PostgreSQL test failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}
