import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminDocuments } from './documents.js';
import { AdminSecurity, base32, digest, totp } from './security.js';

test('TOTP matches every RFC 6238 SHA1 test vector', () => {
  const seed = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const)
    assert.equal(totp(seed, Math.floor(seconds / 30), 8), expected);
});
test('fixed GitHub ID, confirmed enrollment, replay protection, durable lockout, recovery, session expiration and logout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wtr-admin-auth-'));
  let now = 1800000000000;
  try {
    const docs = new AdminDocuments(root),
      options = {
        githubId: '123',
        encryptionSecret: 'isolated-test-secret-'.repeat(3),
        bootstrapHash: digest('bootstrap-test'),
        production: false,
      };
    let security = new AdminSecurity(docs, options, () => now);
    await assert.rejects(
      () => security.beginGithub('github:124'),
      /admin_forbidden/,
    );
    await assert.rejects(
      () => security.authorize('github:123'),
      /admin_session_required/,
    );
    const challenge = await security.beginGithub('github:123');
    await assert.rejects(
      () => security.enroll(challenge, 'bad'),
      /admin_bootstrap_required/,
    );
    const enrollment = await security.enroll(challenge, 'bootstrap-test');
    assert.equal((await security.status(challenge, '')).authenticated, false);
    const session = await security.confirm(
      challenge,
      totp(enrollment.seed, Math.floor(now / 30000)),
    );
    assert.equal(session.recovery_codes.length, 10);
    assert.equal(
      await security.authorize(session.token, session.csrf),
      'github:123',
    );
    await assert.rejects(
      () => security.authorize(session.token, 'bad'),
      /admin_csrf/,
    );
    const again = await security.beginGithub('github:123');
    await assert.rejects(
      () =>
        security.verify(again, totp(enrollment.seed, Math.floor(now / 30000))),
      /admin_invalid_code/,
    );
    for (let i = 0; i < 4; i++)
      await assert.rejects(
        () => security.verify(again, 'bad'),
        /admin_invalid_code/,
      );
    // Restarting the security service must not reset guessing protection.
    security = new AdminSecurity(docs, options, () => now);
    await assert.rejects(
      () => security.verify(again, 'bad'),
      /admin_rate_limited/,
    );
    now += 16 * 60_000;
    const recoverChallenge = await security.beginGithub('github:123');
    const replacement = await security.replace(
      recoverChallenge,
      session.recovery_codes[0]!,
      true,
    );
    assert.equal(
      (await security.status(recoverChallenge, session.token)).authenticated,
      false,
    );
    await assert.rejects(
      () => security.authorize(session.token),
      /admin_session_required/,
    );
    await assert.rejects(
      () =>
        security.replace(recoverChallenge, session.recovery_codes[0]!, true),
      /admin_invalid_code/,
    );
    const replaced = await security.confirm(
      recoverChallenge,
      totp(replacement.seed, Math.floor(now / 30000)),
    );
    assert.notDeepEqual(replaced.recovery_codes, session.recovery_codes);
    const files = await readdir(join(root, 'admin'));
    const stored = (
      await Promise.all(
        files.map((f) => readFile(join(root, 'admin', f), 'utf8')),
      )
    ).join('');
    for (const value of [
      enrollment.seed,
      replacement.seed,
      ...replaced.recovery_codes,
      replaced.token,
    ])
      assert.equal(stored.includes(value), false);
    now += 31 * 60_000;
    await assert.rejects(
      () => security.authorize(replaced.token),
      /admin_session_required/,
    );
    const login = await security.beginGithub('github:123');
    const signed = await security.verify(
      login,
      totp(replacement.seed, Math.floor(now / 30000)),
    );
    await security.logout(signed.token);
    await assert.rejects(
      () => security.authorize(signed.token),
      /admin_session_required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('no administrator configuration means no enrollment or management', async () => {
  const security = new AdminSecurity(new AdminDocuments('unused'), {
    encryptionSecret: 'x'.repeat(32),
    production: true,
  });
  assert.equal(security.enabled, false);
  await assert.rejects(
    () => security.beginGithub('github:1'),
    /admin_forbidden/,
  );
  assert.deepEqual(await security.status('', ''), {
    enabled: false,
    authenticated: false,
  });
});
