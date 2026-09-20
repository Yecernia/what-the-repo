/** Local, disposable Linux toolchain validation. Does not enable production LSP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const docker = process.env.WTR_TEST_DOCKER_BINARY || 'docker';
const image = process.env.WTR_LSP_TEST_IMAGE || '';
const output = process.argv[2];
if (!/^sha256:[0-9a-f]{64}$/.test(image) || !output)
  throw new Error('Set WTR_LSP_TEST_IMAGE to a built image ID and supply an output JSON path.');

async function run(args, timeout = 180000) {
  return new Promise((done, reject) => {
    const process = spawn(docker, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { process.kill(); reject(new Error('Docker validation timeout')); }, timeout);
    process.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) process.kill(); });
    process.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2 * 1024 * 1024) process.kill(); });
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
async function checked(args, timeout) {
  const result = await run(args, timeout);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
const endpoint = process.env.DOCKER_HOST || await checked(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.match(endpoint, /^(npipe|unix):\/\//, 'Only local Docker contexts are accepted');
assert.equal(await checked(['image', 'inspect', '--format', '{{.Id}}', image]), image);
const report = { schema_version: 'lsp-container-validation-v1', image, host_platform: process.platform,
  container_platform: 'linux', docker_version: await checked(['version', '--format', '{{.Server.Version}}']),
  started_at: new Date().toISOString(), passed: false, cases: [] };
try {
  for (const mode of ['bounds', 'memory', 'cleanup', 'languages']) {
    const name = 'wtr-lsp-probe-' + randomUUID();
    const memory = mode === 'memory' ? '128m' : '1g';
    const args = ['create', '--name', name, '--label', 'wtr.validation=lsp', '--pull=never',
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=1000:1000', '--pids-limit=128', '--memory=' + memory, '--memory-swap=' + memory, '--cpus=2',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
      '--env', 'HOME=/tmp/home', '--env', 'TMPDIR=/tmp', '--env', 'GOPROXY=off', '--env', 'GOSUMDB=off',
      '--env', 'GOENV=off', '--env', 'GOTOOLCHAIN=local', '--env', 'CGO_ENABLED=0',
      '--env', 'GOFLAGS=-mod=readonly -buildvcs=false', '--env', 'GOCACHE=/tmp/go-cache', '--env', 'GOMODCACHE=/tmp/go-mod',
      '--env', 'CARGO_NET_OFFLINE=true', '--env', 'CARGO_HOME=/tmp/cargo',
      '--env', 'PYTHONNOUSERSITE=1', '--env', 'PYTHONSAFEPATH=1', image, mode];
    let id;
    try {
      id = await checked(args);
      const result = await run(['start', '--attach', id]);
      const state = JSON.parse(await checked(['inspect', '--format', '{{json .State}}', id]));
      const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      report.cases.push({ mode, ...result, rows, state });
      if (mode === 'memory') { assert.equal(state.OOMKilled, true); assert.equal(state.ExitCode, 137); }
      else { assert.equal(result.code, 0, result.stderr); assert.equal(state.ExitCode, 0); }
      assert.equal(state.Running, false, 'container descendants must terminate with PID 1');
      console.log(`${mode}: passed`);
    } finally {
      if (id) {
        await checked(['rm', '--force', id]);
        assert.notEqual((await run(['inspect', id], 10000)).code, 0);
      }
    }
  }
  report.passed = true;
} finally {
  report.finished_at = new Date().toISOString();
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
}
