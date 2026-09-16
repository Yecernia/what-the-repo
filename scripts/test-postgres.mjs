import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server');
const source = process.env.WTR_TEST_POSTGRES_URL;
if (!source) throw new Error('Set WTR_TEST_POSTGRES_URL to a disposable local wtr_test_bootstrap database');
const endpoint = new URL(source);
if (!['postgres:', 'postgresql:'].includes(endpoint.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  || endpoint.pathname !== '/wtr_test_bootstrap' || endpoint.port === '15432') {
  throw new Error('Only a disposable local wtr_test_bootstrap database is accepted; development and production databases are not used');
}
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
childEnv.WHAT_THE_REPO_LOAD_LOCAL_ENV = '0';
childEnv.NODE_ENV = 'test';
function run(args, environment = childEnv) {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: server, env: environment, stdio: 'inherit', windowsHide: true });
    child.once('error', no);
    child.once('exit', code => code === 0 ? yes() : no(new Error(`Test process exited with ${code}`)));
  });
}
function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.name.endsWith('.test.js') && readFileSync(path, 'utf8').includes('WTR_ADMIN_TEST_DATABASE_URL') ? [path] : [];
  }).sort();
}
if (!process.argv.includes('--skip-build')) {
  await run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json']);
}
const tests = findTests(join(server, 'dist-test'));
if (!tests.length) throw new Error('No PostgreSQL integration tests found');
const { default: pg } = await import(pathToFileURL(join(server, 'node_modules/pg/lib/index.js')).href);
const admin = new pg.Pool({ connectionString: endpoint.toString(), max: 1 });
try {
  for (const file of tests) {
    const name = `wtr_admin_test_${randomUUID().replaceAll('-', '')}`;
    const isolated = new URL(endpoint);
    isolated.pathname = `/${name}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      await run(['--test', '--test-concurrency=1', file], { ...childEnv, WTR_ADMIN_TEST_DATABASE_URL: isolated.toString() });
    } finally {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  }
  console.log(`PostgreSQL integration passed: ${tests.length} files; one temporary database per file.`);
} finally { await admin.end(); }
