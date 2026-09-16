import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|DOCKER_CONFIG|DOCKER_CONTEXT|DOCKER_HOST)$/i.test(key)));
Object.assign(env, {
  POSTGRES_PASSWORD: 'runtime-check-only-password',
  WHAT_THE_REPO_SESSION_SECRET: 'runtime-check-only-session-secret-0123456789',
  WHAT_THE_REPO_KEY_ENCRYPTION_SECRET: 'runtime-check-only-encryption-secret-012345',
  WHAT_THE_REPO_CHAT_CONCURRENCY: '3',
  WHAT_THE_REPO_ANALYSIS_CONCURRENCY: '2',
  WTR_SECRET_ROOT: join(root, '.tmp', 'runtime-config-test-secrets'),
});
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
function model(files) {
  const args = ['compose', '--project-directory', root, '--env-file', join(root, '.env.example'), '--profile', '*'];
  for (const file of files) args.push('-f', join(root, file));
  return JSON.parse(execFileSync(docker, [...args, 'config', '--format', 'json'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
const base = model(['compose.runtime.yaml']);
const hardened = model(['compose.runtime.yaml', 'compose.runtime-secrets.yaml']);
for (const name of ['postgres', 'redis', 'migration', 'api', 'analysis-worker', 'scheduler', 'web', 'evolution-worker', 'prometheus']) {
  assert(base.services[name], `Missing runtime service: ${name}`);
}
for (const composition of [base, hardened]) {
  for (const [name, service] of Object.entries(composition.services)) {
    for (const dependency of Object.keys(service.depends_on ?? {})) {
      assert(composition.services[dependency], `${name}: missing dependency ${dependency}`);
    }
    if (service.build) assert(existsSync(resolve(service.build.context, service.build.dockerfile)), `${name}: missing Dockerfile`);
    for (const volume of service.volumes ?? []) {
      if (volume.type === 'bind' && volume.target !== '/var/run/docker.sock') {
        assert(existsSync(volume.source), `${name}: missing public bind source ${volume.source}`);
      }
    }
    for (const secret of service.secrets ?? []) assert(composition.secrets[secret.source], `${name}: undeclared secret`);
  }
}
assert.equal(hardened.services.api.ports?.length ?? 0, 0, 'API replicas must not compete for a host port');
assert.equal(hardened.services.api.read_only, true);
assert.equal(hardened.services.api.environment.DATABASE_URL, '');
assert.equal(hardened.services.api.environment.DATABASE_URL_FILE, '/run/secrets/postgres_runtime_database_url');
assert.equal(base.services.api.environment.WHAT_THE_REPO_CHAT_CONCURRENCY, '3');
assert.equal(base.services['analysis-worker'].environment.WHAT_THE_REPO_ANALYSIS_CONCURRENCY, '2');
assert.equal(hardened.services['evolution-worker'].environment.WHAT_THE_REPO_KEY_ENCRYPTION_SECRET_FILE, '/run/secrets/key_encryption_secret');
for (const file of ['compose.runtime.yaml', 'compose.runtime-secrets.yaml']) {
  const text = readFileSync(join(root, file), 'utf8');
  assert(!/ap-guangzhou|ap-shanghai|cross-region|Guangzhou|Singapore/.test(text), `${file}: instance-specific location`);
  assert(!/_USD[^\n]*:-\d/.test(text), `${file}: copied monetary policy`);
}
console.log(`Portable runtime configuration passed: ${Object.keys(base.services).length} services, optional profiles, replica ports and secret boundaries. No services were started.`);
