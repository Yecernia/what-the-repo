import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerConfig } from '../config.js';
import type { BackgroundRepositoryCandidate } from '../persistence/store.js';
import { createRepositoryBackgroundRefreshTask } from './repository-background-scheduler.js';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const sha = (char: string) => char.repeat(40);
const candidate = (overrides: Partial<BackgroundRepositoryCandidate> = {}): BackgroundRepositoryCandidate => ({
  repository: 'owner/repo', projectId: 'project-1',
  currentPublicSnapshotKey: 'snapshot-key', currentSnapshotId: 'snapshot-id',
  currentCommitSha: sha('a'), analyzerBundleVersion: 'v1', analysisConfigDigest: 'digest',
  publishedAt: new Date(now - 8 * 86400_000).toISOString(),
  lastRealUseAt: new Date(now - 6 * 86400_000).toISOString(),
  lastCheckedAt: null, nextCheckAt: null, upstreamCommitSha: null,
  behindCommits: null, relation: 'unknown', lastBackgroundStartedAt: null,
  ...overrides,
});
const config = (overrides: Partial<ServerConfig> = {}) => ({
  repositoryBackgroundRefreshEnabled: true,
  repositoryActiveWindowDays: 7,
  repositoryHeadCheckTtlMinutes: 60,
  repositoryBackgroundCommitThreshold: 20,
  repositoryBackgroundMaxSnapshotAgeDays: 7,
  repositoryBackgroundMinUpdateIntervalHours: 24,
  ...overrides,
} as ServerConfig);

test('background refresh requires real recent use and a fresh confirmed change', async () => {
  const requested: string[] = [];
  const list = [candidate(), candidate({
    repository: 'old/repo', lastRealUseAt: new Date(now - 8 * 86400_000).toISOString(),
  })];
  const task = createRepositoryBackgroundRefreshTask(config(), {
    now: () => now, listCandidates: async () => list,
    checkFreshness: async identity => ({
      baseSnapshotId: 'snapshot-id', upstreamCommitSha: sha('b'),
      behindCommits: identity.repository === 'old/repo' ? 100 : 1,
      relation: 'ahead', checkedAt: new Date(now).toISOString(),
    }),
    requestUpdate: async input => { requested.push(input.identity.repository); return 'queued'; },
  });
  const outcome = await task();
  assert.deepEqual({ ...outcome, decisions: undefined }, {
    examined: 2, checked: 1, queued: 1, deferred: 0, failedChecks: 0, decisions: undefined,
  });
  assert.deepEqual(outcome.decisions.map(row => [row.repository, row.decision]).sort(),
    [['old/repo', 'inactive'], ['owner/repo', 'queued']]);
  assert.deepEqual(requested, ['owner/repo']);
});

test('every examined repository records why it did or did not start', async () => {
  const freshSnapshot = new Date(now - 86400_000).toISOString();
  const task = createRepositoryBackgroundRefreshTask(config(), {
    now: () => now,
    listCandidates: async () => [
      candidate({ repository: 'few/commits', publishedAt: freshSnapshot }),
      candidate({ repository: 'recent/start', lastBackgroundStartedAt: new Date(now - 3600_000).toISOString() }),
      candidate({ repository: 'no/budget' }),
      candidate({ repository: 'broken/check' }),
      candidate({ repository: 'same/head' }),
    ],
    checkFreshness: async identity => {
      if (identity.repository === 'broken/check') throw new Error('gateway down');
      return { baseSnapshotId: 'snapshot-id',
        upstreamCommitSha: identity.repository === 'same/head' ? sha('a') : sha('b'),
        behindCommits: 3, relation: identity.repository === 'same/head' ? 'same' : 'ahead',
        checkedAt: new Date(now).toISOString() };
    },
    requestUpdate: async () => 'deferred:daily_budget',
  });
  const outcome = await task();
  assert.deepEqual(outcome.decisions.map(row => [row.repository, row.decision]).sort(), [
    ['broken/check', 'check_failed'], ['few/commits', 'below_threshold'],
    ['no/budget', 'deferred:daily_budget'], ['recent/start', 'interval'], ['same/head', 'same'],
  ]);
  assert.equal(outcome.deferred, 1);
  assert.equal(outcome.failedChecks, 1);
  assert.equal(outcome.decisions.find(row => row.repository === 'few/commits')?.behindCommits, 3);
});

test('background refresh does not pay for same, unknown or stale comparisons', async () => {
  let calls = 0;
  const task = createRepositoryBackgroundRefreshTask(config(), {
    now: () => now, listCandidates: async () => [candidate()],
    checkFreshness: async () => ({
      baseSnapshotId: 'snapshot-id', upstreamCommitSha: sha('b'),
      behindCommits: null, relation: 'unknown', checkedAt: new Date(now).toISOString(),
    }),
    requestUpdate: async () => { calls++; return 'queued'; },
  });
  const outcome = await task();
  assert.equal(outcome.queued, 0);
  assert.deepEqual(outcome.decisions.map(row => row.decision), ['unknown_relation']);
  assert.equal(calls, 0);
  const disabled = createRepositoryBackgroundRefreshTask(config({ repositoryBackgroundRefreshEnabled: false }), {
    now: () => now, listCandidates: async () => { throw new Error('must stay idle'); },
    checkFreshness: async () => { throw new Error('must stay idle'); },
    requestUpdate: async () => { throw new Error('must stay idle'); },
  });
  assert.equal((await disabled()).examined, 0);
});
