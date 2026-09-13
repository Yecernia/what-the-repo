import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStore } from '../persistence/file-store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { PiSessionStore } from '../agent/session-store.js';
import { PiMemoryStore } from '../agent/memory-store.js';
import {
  signGithubGatewayPayload,
  parseGithubGatewayStartGrant,
} from '../github-gateway/protocol.js';
import { digest, totp } from './security.js';

for (const backend of ['file', 'postgres'])
  test(
    `${backend}: every admin page requires both factors; ordinary operations use the session`,
    {
      skip: backend === 'postgres' && !process.env.WTR_ADMIN_TEST_DATABASE_URL,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'wtr-admin-api-'));
      const secret = 'isolated-test-secret-'.repeat(3);
      const config = {
        ...loadConfig({}),
        root: process.cwd(),
        dataDir: root,
        sessionDir: join(root, 'sessions'),
        memoryDir: join(root, 'memory'),
        skillVersionsRoot: join(root, 'skills'),
        nodeEnv: 'test',
        adminGithubId: '123',
        adminBootstrapHash: digest('test-bootstrap'),
        keyEncryptionSecret: secret,
        sessionSecret: secret,
        githubGatewayUrl: 'https://gateway.example.com',
        githubGatewaySharedSecret: secret,
      };
      config.adminGithubId = '456';
      const store =
        backend === 'postgres'
          ? new PostgresStore({
              root,
              databaseUrl: process.env.WTR_ADMIN_TEST_DATABASE_URL!,
              migrationsRoot: join(process.cwd(), 'migrations'),
              encryptionSecret: secret,
            })
          : new FileStore(root);
      await store.init();
      const app = buildApp({
        config,
        store,
        sessions: new PiSessionStore(config.sessionDir),
        memories: new PiMemoryStore(config.memoryDir),
      });
      try {
        const paths = [
          'overview',
          'activity',
          'config',
          'budgets',
          'feedback',
          'storage',
          'audit',
        ];
        for (const path of paths)
          assert.equal(
            (await app.inject('/api/admin/' + path)).statusCode,
            403,
          );
        const start = await app.inject(
          '/api/auth/github/start?return_to=/admin',
        );
        const state = start.cookies.find(
          (c) => c.name === 'what_the_repo_oauth_state',
        )!;
        const grant = parseGithubGatewayStartGrant(
          new URL(start.headers.location!).searchParams.get('request')!,
          secret,
        )!;
        const ticket = signGithubGatewayPayload(
          {
            version: 1,
            kind: 'github_oauth_result',
            outcome: 'success',
            nonce: grant.nonce,
            ticket_id: randomUUID(),
            issued_at: Date.now(),
            expires_at: Date.now() + 60000,
            github: {
              id: 456,
              login: 'test',
              name: 'Test Admin',
              avatar_url: null,
            },
          },
          secret,
        );
        const callback = await app.inject({
          url: '/api/auth/github/callback?ticket=' + ticket,
          cookies: { [state.name]: state.value },
        });
        assert.equal(callback.statusCode, 302);
        const challenge = callback.cookies.find(
          (c) => c.name === 'what_the_repo_admin_challenge',
        )!;
        assert.ok(challenge);
        const cookies = { [challenge.name]: challenge.value };
        for (const path of paths)
          assert.equal(
            (await app.inject({ url: '/api/admin/' + path, cookies }))
              .statusCode,
            403,
          );
        const headers = { 'x-admin-request': '1' };
        for (const partialCookies of [{}, cookies]) {
          for (const path of ['repositories/users?repository=org/repo&kind=storage', 'repositories/delete-plan?repository=org/repo'])
            assert.equal((await app.inject({url:'/api/admin/'+path,cookies:partialCookies})).statusCode,403);
          assert.equal((await app.inject({method:'POST',url:'/api/admin/repositories/delete',cookies:partialCookies,headers,payload:{repository:'org/repo',confirm:'org/repo'}})).statusCode,403);
        }
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/api/admin/auth/enroll',
              cookies,
              payload: { bootstrap: 'test-bootstrap' },
            })
          ).statusCode,
          403,
        );
        const enroll = await app.inject({
          method: 'POST',
          url: '/api/admin/auth/enroll',
          cookies,
          headers,
          payload: { bootstrap: 'test-bootstrap' },
        });
        assert.equal(enroll.statusCode, 200);
        const confirmed = await app.inject({
          method: 'POST',
          url: '/api/admin/auth/confirm',
          cookies,
          headers,
          payload: {
            code: totp(enroll.json().seed, Math.floor(Date.now() / 30000)),
          },
        });
        assert.equal(confirmed.statusCode, 200);
        const session = confirmed.cookies.find(
          (c) => c.name === 'what_the_repo_admin',
        )!;
        const signedCookies = { [session.name]: session.value };
        const csrf = confirmed.json().csrf;
        assert.equal((await app.inject({method:'POST',url:'/api/admin/repositories/delete',cookies:signedCookies,headers,payload:{repository:'org/repo',confirm:'org/repo'}})).statusCode,403);
        for (const path of paths)
          assert.equal(
            (
              await app.inject({
                url: '/api/admin/' + path,
                cookies: signedCookies,
              })
            ).statusCode,
            200,
            path,
          );
        const policy = {
          analysis_daily: 0,
          chat_daily: null,
          evolution_task: null,
          evolution_daily: 1,
        };
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/admin/budgets',
              cookies: signedCookies,
              headers,
              payload: policy,
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/admin/budgets',
              cookies: signedCookies,
              headers: {
                ...headers,
                'x-admin-csrf': csrf,
                origin: 'https://evil.example.com',
              },
              payload: policy,
            })
          ).statusCode,
          403,
        );
        for (let i = 0; i < 2; i++)
          assert.equal(
            (
              await app.inject({
                method: 'PUT',
                url: '/api/admin/budgets',
                cookies: signedCookies,
                headers: { ...headers, 'x-admin-csrf': csrf },
                payload: policy,
              })
            ).statusCode,
            200,
          );
        const logout = await app.inject({
          method: 'POST',
          url: '/api/admin/auth/logout',
          cookies: signedCookies,
          headers: { ...headers, 'x-admin-csrf': csrf },
          payload: {},
        });
        assert.equal(logout.statusCode, 200);
        assert.equal(
          (
            await app.inject({
              url: '/api/admin/overview',
              cookies: signedCookies,
            })
          ).statusCode,
          403,
        );
      } finally {
        await app.close();
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
