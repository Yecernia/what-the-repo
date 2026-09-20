import assert from 'node:assert/strict';
import test from 'node:test';
import { githubReadWithRetry, GithubRateLimitError } from './github-transport.js';

function timer() {
  let now = Date.parse('2026-09-19T00:00:00Z');
  const waits: number[] = [];
  return { waits, now: () => now, random: () => 0, async sleep(ms: number) { waits.push(ms); now += ms; } };
}
const edge = () => new Response('limited', { status: 429, headers: { 'retry-after': '1', 'x-wtr-rate-limit-source': 'gateway' } });

test('gateway bursts retry the failed read and cancel rejected bodies', async () => {
  const timing = timer(); let calls = 0;
  const first = edge();
  const result = await githubReadWithRetry(async () => ++calls === 1 ? first : new Response('ok'), undefined, timing);
  assert.equal(await result.text(), 'ok');
  assert.equal(first.bodyUsed, true);
  assert.deepEqual(timing.waits, [1000]);
  assert.equal(calls, 2);
});

test('GitHub secondary limit without hints waits a minute and stops before an early outer retry', async () => {
  const timing = timer(); let calls = 0;
  await assert.rejects(githubReadWithRetry(async () => { calls++; return new Response('', { status: 429 }); }, undefined, timing), GithubRateLimitError);
  assert.deepEqual(timing.waits, [60_000]);
  assert.equal(calls, 2);
});

test('honors Retry-After dates and primary reset; never retries before a long reset', async () => {
  for (const headers of [
    { 'retry-after': new Date(Date.parse('2026-09-19T00:00:00Z') + 5000).toUTCString() },
    { 'retry-after': '2', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-09-19T00:00:05Z') / 1000) },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse('2026-09-19T00:00:05Z') / 1000) },
  ] as Record<string, string>[]) {
    const timing = timer(); let calls = 0;
    await githubReadWithRetry(async () => ++calls === 1 ? new Response('', { status: 403, headers }) : new Response('ok'), undefined, timing);
    assert.deepEqual(timing.waits, [5000]);
  }
  const timing = timer(); let calls = 0;
  await assert.rejects(githubReadWithRetry(async () => { calls++; return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((timing.now() + 3600_000) / 1000) } }); }, undefined, timing), { code: 'github_rate_limited', retryAfterMs: 3600_000 });
  assert.equal(calls, 1);
  assert.deepEqual(timing.waits, []);
});

test('ordinary forbidden/not-found are not retried; gateway storms have five attempts at most', async () => {
  for (const status of [401, 403, 404]) {
    const timing = timer();
    assert.equal((await githubReadWithRetry(async () => new Response('', { status }), undefined, timing)).status, status);
    assert.deepEqual(timing.waits, []);
  }
  const timing = timer(); let calls = 0;
  await assert.rejects(githubReadWithRetry(async () => { calls++; return edge(); }, undefined, timing), { code: 'github_rate_limited' });
  assert.equal(calls, 5);
  assert.deepEqual(timing.waits, [1000, 2000, 4000, 8000]);
});

test('cancellation during backoff prevents any additional request', async () => {
  const cancel = new AbortController(); let calls = 0;
  const timing = { ...timer(), async sleep() { cancel.abort(new Error('cancel-fetch')); } };
  await assert.rejects(githubReadWithRetry(async () => { calls++; return edge(); }, cancel.signal, timing), /cancel-fetch/);
  assert.equal(calls, 1);
});

test('interactive head lookup does not wait a minute before admitting an analysis job', async () => {
  const timing = timer(); let calls = 0;
  await assert.rejects(githubReadWithRetry(async () => { calls++; return new Response('', { status: 429 }); }, undefined, timing, 5000), GithubRateLimitError);
  assert.equal(calls, 1);
  assert.deepEqual(timing.waits, []);
});
