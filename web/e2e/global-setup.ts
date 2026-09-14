import type { FullConfig } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { get } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eProviderEnv, isolatedServiceEnv } from './service-env.js';

interface ManagedService {
  name: string;
  process: ChildProcess;
  stdoutPath: string;
  stderrPath: string;
}

async function loadLocalEnvironment(): Promise<NodeJS.ProcessEnv> {
  const text = await readFile(path.join(repositoryRoot, '.secrets', 'local.env'), 'utf8')
    .catch(() => '');
  const values: NodeJS.ProcessEnv = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(webRoot, '..');
const serverRoot = path.join(repositoryRoot, 'server');

function configuredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer TCP port between 1 and 65535`);
  }
  return value;
}

function startService(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logRoot: string,
): ManagedService {
  const stdoutPath = path.join(logRoot, `${name}.stdout.log`);
  const stderrPath = path.join(logRoot, `${name}.stderr.log`);
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', stdout, stderr],
    });
    if (child.pid === undefined) throw new Error(`${name} did not receive a process ID`);
    return { name, process: child, stdoutPath, stderrPath };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function requestStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, timeout: 2_000 }, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once('end', () => resolve(status));
    });
    request.once('timeout', () => request.destroy(new Error('health request timed out')));
    request.once('error', reject);
  });
}

async function waitUntilReady(service: ManagedService, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  while (Date.now() < deadline) {
    if (service.process.exitCode !== null) {
      throw new Error(`${service.name} exited with code ${service.process.exitCode}`);
    }
    try {
      const status = await requestStatus(url);
      if (status >= 200 && status < 500) {
        consecutiveHealthyChecks += 1;
        await new Promise(resolve => setTimeout(resolve, 200));
        if (service.process.exitCode !== null) {
          throw new Error(`${service.name} exited with code ${service.process.exitCode}`);
        }
        if (consecutiveHealthyChecks >= 3) return;
        continue;
      }
    } catch {
      // The service may still be binding its port.
    }
    consecutiveHealthyChecks = 0;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${service.name} did not become ready within ${timeoutMs} ms`);
}

async function waitUntilHttpPortIsUnused(
  name: string,
  url: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    try {
      lastStatus = await requestStatus(url);
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `${name} port remained occupied${lastStatus === null ? '' : ` (HTTP ${lastStatus})`}: ${url}`,
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function terminateService(service: ManagedService): Promise<void> {
  const pid = service.process.pid;
  if (pid === undefined || service.process.exitCode !== null || service.process.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await waitForExit(killer, 10_000);
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  await waitForExit(service.process, 10_000);
  if (service.process.exitCode === null && service.process.signalCode === null && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group already exited.
    }
    await waitForExit(service.process, 2_000);
  }
}

async function failureDetails(service: ManagedService): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    readFile(service.stdoutPath, 'utf8').catch(() => ''),
    readFile(service.stderrPath, 'utf8').catch(() => ''),
  ]);
  return `${service.name} stdout:\n${stdout.slice(-8_000)}\n${service.name} stderr:\n${stderr.slice(-8_000)}`;
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const apiPort = configuredPort('WHAT_THE_REPO_E2E_API_PORT', 8307);
  const webPort = configuredPort('WHAT_THE_REPO_E2E_WEB_PORT', 5307);
  if (apiPort === webPort) throw new Error('E2E API and Web ports must be different');
  const apiHealthUrl = `http://127.0.0.1:${apiPort}/api/health`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const runtimeRoot = path.join(
    repositoryRoot,
    'out',
    'e2e-runtime',
    `run-${process.pid}-${Date.now()}`,
  );
  const keepRuntime = process.env.WHAT_THE_REPO_E2E_KEEP_RUNTIME === '1';
  const dataRoot = path.join(runtimeRoot, 'data');
  const logRoot = path.join(runtimeRoot, 'logs');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  const services: ManagedService[] = [];
  // Real-provider acceptance is opt-in; ordinary CI never loads local secrets.
  const useProvider = process.env.WHAT_THE_REPO_E2E_USE_PROVIDER === '1';
  const configuredEnvironment = {
    ...(useProvider ? await loadLocalEnvironment() : {}),
    ...process.env,
  };
  const providerEnvironment = e2eProviderEnv(configuredEnvironment);
  process.env.WHAT_THE_REPO_E2E_PROVIDER_CONFIGURED = useProvider ? '1' : '0';

  try {
    await waitUntilHttpPortIsUnused('api', apiHealthUrl);
    await waitUntilHttpPortIsUnused('web', webUrl);
    const api = startService(
      'api',
      process.execPath,
      [
        '--import',
        'tsx',
        'src/main.ts',
      ],
      serverRoot,
      isolatedServiceEnv(configuredEnvironment, {
        NODE_ENV: 'test',
        WHAT_THE_REPO_LOAD_LOCAL_ENV: '0',
        WHAT_THE_REPO_ROOT: repositoryRoot,
        WHAT_THE_REPO_SERVER_HOST: '127.0.0.1',
        WHAT_THE_REPO_SERVER_PORT: String(apiPort),
        DATABASE_URL: '',
        GITHUB_OAUTH_CALLBACK_URL: `http://127.0.0.1:${apiPort}/api/auth/github/callback`,
        WHAT_THE_REPO_WEB_URL: `http://127.0.0.1:${webPort}`,
        GITHUB_OAUTH_CLIENT_ID: configuredEnvironment.GITHUB_OAUTH_CLIENT_ID || 'e2e-client-id',
        GITHUB_OAUTH_CLIENT_SECRET: configuredEnvironment.GITHUB_OAUTH_CLIENT_SECRET || 'e2e-client-secret',
        WHAT_THE_REPO_DATA_DIR: dataRoot,
        ...providerEnvironment,
        WHAT_THE_REPO_FREE_PROVIDER_BASE_URL:
          configuredEnvironment.WHAT_THE_REPO_FREE_PROVIDER_BASE_URL || 'https://api.deepseek.com',
        WHAT_THE_REPO_FREE_PROVIDER_MODEL:
          configuredEnvironment.WHAT_THE_REPO_FREE_PROVIDER_MODEL || 'deepseek-v4-flash',
        WHAT_THE_REPO_SESSION_SECRET:
          configuredEnvironment.WHAT_THE_REPO_SESSION_SECRET || 'e2e-session-secret-'.padEnd(48, 'x'),
        WHAT_THE_REPO_KEY_ENCRYPTION_SECRET:
          configuredEnvironment.WHAT_THE_REPO_KEY_ENCRYPTION_SECRET
          || 'e2e-encryption-secret-'.padEnd(48, 'x'),
      }),
      logRoot,
    );
    services.push(api);
    await waitUntilReady(api, apiHealthUrl, 60_000);

    const web = startService(
      'web',
      process.execPath,
      [
        path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      webRoot,
      isolatedServiceEnv(process.env, {
        WHAT_THE_REPO_BACKEND_URL: `http://127.0.0.1:${apiPort}`,
        VITE_API_BASE_URL: '',
      }),
      logRoot,
    );
    services.push(web);
    await waitUntilReady(web, webUrl, 60_000);
  } catch (error) {
    const details = await Promise.all(services.map(failureDetails));
    for (const service of services.reverse()) await terminateService(service);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${details.join('\n')}`);
  }

  return async () => {
    for (const service of services.reverse()) await terminateService(service);
    if (keepRuntime) {
      process.stdout.write(`Preserved E2E runtime: ${runtimeRoot}\n`);
      return;
    }
    // Windows can hold a just-closed redirected log handle briefly. Node's
    // bounded retry keeps an otherwise successful E2E run from failing only
    // while deleting its own temporary files.
    await rm(runtimeRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  };
}
