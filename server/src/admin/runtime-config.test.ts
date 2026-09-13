import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../persistence/file-store.js';
import { loadConfig } from '../config.js';
import {
  adminDocuments,
  savePlatformVersion,
  runtimeConfig,
  verifyPlatformConnection,
} from './runtime-config.js';

test('encrypted shared connections, immutable job versions, config conflicts and safe catalogue verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-admin-config-'));
  const store = new FileStore(root);
  await store.init();
  const docs = adminDocuments(store),
    secret = 'isolated-config-secret-'.repeat(3);
  const input = {
    baseVersion: 0,
    connections: [
      {
        id: 'shared',
        label: 'Test',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'isolated-key-one',
        models: ['deepseek-v4-flash'],
      },
    ],
    agents: {
      'primary-chat': { connectionId: 'shared', model: 'deepseek-v4-flash' },
      'repository-analysis': {
        connectionId: 'shared',
        model: 'deepseek-v4-flash',
      },
    },
  };
  const config = { ...loadConfig({}), keyEncryptionSecret: secret };
  try {
    for (const role of ['learning-route', 'understanding-assessment', 'citation-review', 'memory-maintenance']) {
      await assert.rejects(() => savePlatformVersion(docs, secret, 'test', {
        ...input, agents: { [role]: input.agents['primary-chat'] },
      }), { code: 'admin_invalid_config' });
    }
    const v1 = await savePlatformVersion(docs, secret, 'test', input);
    assert.equal(v1.version, 1);
    assert.equal(JSON.stringify(v1).includes('isolated-key-one'), false);
    await assert.rejects(
      () => savePlatformVersion(docs, secret, 'test', input),
      { code: 'admin_config_conflict' },
    );
    await savePlatformVersion(docs, secret, 'test', {
      ...input,
      baseVersion: 1,
      connections: [{ ...input.connections[0], apiKey: 'isolated-key-two' }],
    });
    const old = await runtimeConfig(config, store, undefined, 1),
      current = await runtimeConfig(config, store);
    assert.equal(old.analysisProviderApiKey, 'isolated-key-one');
    assert.equal(current.freeProviderApiKey, 'isolated-key-two');
    assert.equal(old.freeProviderApiKey, old.analysisProviderApiKey);
    await assert.rejects(
      () =>
        savePlatformVersion(docs, secret, 'test', {
          ...input,
          baseVersion: 2,
          connections: [
            {
              ...input.connections[0],
              baseUrl: 'https://127.0.0.1',
              apiKey: 'x',
            },
          ],
        }),
      { code: 'admin_invalid_config' },
    );
    await assert.rejects(
      () =>
        savePlatformVersion(docs, secret, 'test', {
          ...input,
          baseVersion: 2,
          connections: [
            {
              ...input.connections[0],
              baseUrl: 'https://other.example/v1',
              apiKey: undefined,
            },
          ],
        }),
      { code: 'admin_key_required' },
    );
    let calls = 0;
    const verification = await verifyPlatformConnection(
      docs,
      secret,
      'shared',
      async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.deepseek.com/models');
        assert.equal(options?.method, undefined);
        return new Response('{}');
      },
    );
    assert.equal(verification.ok, true);
    assert.equal(calls, 1);
    const files = await readdir(join(root, 'admin'));
    for (const file of files) {
      const value = await readFile(join(root, 'admin', file), 'utf8');
      assert.equal(value.includes('isolated-key-'), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
