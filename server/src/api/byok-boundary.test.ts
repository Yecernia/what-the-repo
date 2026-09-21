import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerByokBoundary } from './byok-boundary.js';
import { bindByokOwner, byokDraftKey } from '../security/byok-credentials.js';
import { TransientKeyVault } from '../persistence/encrypted-key-vault.js';
const key = 'unlogged-canary-PRIVATE-789';
test('credential ingress strips draft headers and stored credentials do not return to clients', async () => {
  const app = Fastify({ logger: false }), keys = new TransientKeyVault();
  registerByokBoundary(app);
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ code: 'invalid_request' }));
  app.get('/api/settings', async request => {
    const owner = String(request.headers['test-owner']); bindByokOwner(owner);
    const value = await keys.get(owner, 'one');
    return { has_key: Boolean(value), masked: await keys.masked(owner, 'one'), accidental_echo: value };
  });
  app.post('/api/settings/connections', async request => {
    bindByokOwner('alice');
    assert.equal(request.headers['x-wtr-byok-draft'], undefined);
    assert.equal(request.raw.rawHeaders.some(value => value.includes(key)), false);
    await keys.set('alice', byokDraftKey(), 'one'); return { ok: true };
  });
  try {
    const headers = { 'x-wtr-byok-draft': key };
    const added = await app.inject({ method: 'POST', url: '/api/settings/connections', headers, payload: {} });
    assert.equal(added.statusCode, 200);
    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'test-owner': 'alice' } });
    assert.deepEqual(response.json(), { has_key: true, masked: '********', accidental_echo: '[redacted]' });
    assert.equal(response.headers['cache-control'], 'no-store');
    const other = await app.inject({ method: 'GET', url: '/api/settings', headers: { 'test-owner': 'bob' } });
    assert.equal(other.json().has_key, false);
    for (const payload of [{ label: key }, { api_key: key }]) {
      const rejected = await app.inject({ method: 'POST', url: '/api/settings/connections', headers, payload });
      assert.equal(rejected.statusCode, 400); assert.equal(rejected.body.includes(key), false);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/settings', headers })).statusCode, 400);
    assert.equal(await keys.get('alice', 'one'), key);
  } finally { await app.close(); }
});
