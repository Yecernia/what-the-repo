import assert from 'node:assert/strict';
import test from 'node:test';
import { bindByokOwner, withCredentialScope, currentCredentialRedactor, rememberByokSecret } from './byok-credentials.js';
import { TransientKeyVault } from '../persistence/encrypted-key-vault.js';
import { credentialRedactor } from './secret-redaction.js';
const key = 'sentinel-BYOK_7qq-!x.39';
test('credential redaction covers exact values, encodings, object keys and every stream split', () => {
  const redactor = credentialRedactor([key]);
  for (const value of [key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) {
    assert.equal(redactor.text('before ' + value + ' after'), 'before [redacted] after');
    for (let split = 0; split <= value.length; split++) {
      const stream = redactor.stream();
      const output = stream.push('before ' + value.slice(0, split)) + stream.push(value.slice(split) + ' after') + stream.finish();
      assert.equal(output, 'before [redacted] after');
    }
  }
  const original = { [key]: { text: key }, list: [key] };
  assert.deepEqual(redactor.data(original), { '[redacted]': { text: '[redacted]' }, list: ['[redacted]'] });
  assert.equal(original[key]?.text, key);
  const stream = redactor.stream();
  assert.equal(stream.push('ordinary text') + stream.finish(), 'ordinary text');
});

test('redaction scopes isolate owners and discard request references on failure', async () => {
  const outputs = await Promise.all(['alice', 'bob'].map(owner => withCredentialScope('', async () => {
    bindByokOwner(owner); rememberByokSecret(owner, key + owner);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.throws(() => rememberByokSecret('other', key));
    assert.equal(currentCredentialRedactor().text(key + owner), '[redacted]');
    return currentCredentialRedactor().contains(key + (owner === 'alice' ? 'bob' : 'alice'));
  })));
  assert.deepEqual(outputs, [false, false]);
  await assert.rejects(withCredentialScope(key, async () => { throw new Error('test-failure'); }), /test-failure/);
  assert.equal(currentCredentialRedactor().contains(key), false);
  const vault = new TransientKeyVault(); await vault.set('alice', key, 'one');
  assert.equal(await vault.get('alice', 'one'), key);
  assert.equal(await vault.get('bob', 'one'), null);
  assert.equal(await vault.masked('alice', 'one'), '********');
  assert.equal(JSON.stringify(vault).includes(key), false);
  await vault.clear('alice', 'one'); assert.equal(await vault.has('alice', 'one'), false);
});
test('credential input rejects injection and excessive length', async () => {
  for (const key of ['x\r\nInjected:yes', 'x'.repeat(501), ' ']) {
    await assert.rejects(withCredentialScope(key, async () => assert.fail('must not run')));
  }
});
