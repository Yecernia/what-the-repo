import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { LocalPermitStore, PostgresPermitStore, type PermitRow, type PermitStore } from '../scheduling/permits.js';
import { ResourceScheduler } from '../scheduling/resources.js';
import { serviceError } from '../services/errors.js';

const databaseUrl = process.env.WTR_ADMIN_TEST_DATABASE_URL;

function isolatedDatabaseUrl(): string {
  assert.ok(databaseUrl, 'an isolated PostgreSQL URL is required');
  const parsed = new URL(databaseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'tests may only use local PostgreSQL');
  assert.match(parsed.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/, 'tests may only use an isolated test database');
  return databaseUrl;
}

async function fixture(): Promise<{ store: PostgresStore; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'wtr-control-batching-'));
  const store = new PostgresStore({ root, databaseUrl: isolatedDatabaseUrl(),
    migrationsRoot: join(process.cwd(), 'migrations'), encryptionSecret: 'isolated-control-batching-test-only',
    poolMax: 2, objectAdmissionStore: new LocalPermitStore() });
  try { await store.init(); }
  catch (error) { await store.close(); await rm(root, { recursive: true, force: true }); throw error; }
  return { store, async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

function permit(id: string, now: number, order: number): PermitRow {
  return { id, owner: 'batch-test', resource: 'batch-test', state: 'waiting',
    order, expires: now + 60_000, deadline: now + 60_000 };
}

function queryText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'text' in first) return String(first.text);
  return '';
}

/** Observe or pause the one physical control connection without patching PermitStore internals. */
async function hookControlQueries(store: PostgresStore,
  hook: (sql: string, args: unknown[], next: () => Promise<unknown>) => Promise<unknown>): Promise<void> {
  const client = await store.controlPool.connect();
  const original = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>;
  (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args) =>
    hook(queryText(args[0]), args, () => original(...args));
  client.release();
}

function namespaceQuery(args: unknown[], namespace: string): boolean {
  return Array.isArray(args[1]) && args[1].includes(namespace);
}

async function rowsFor(store: PostgresStore, namespace: string): Promise<PermitRow[]> {
  const result = await store.pool.query<{ payload: PermitRow }>(
    'SELECT payload FROM runtime_permits WHERE namespace=$1 ORDER BY permit_id', [namespace]);
  return result.rows.map(row => row.payload);
}

test('96 callers through distinct PermitStore instances sharing one Pool use substantially fewer transactions without lost writes',
  { skip: !databaseUrl, timeout: 30_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-count-${randomUUID()}`;
    let begins = 0, namespaceReads = 0, capturing = true;
    try {
      await hookControlQueries(store, async (sql, args, next) => {
        if (capturing && /^\s*BEGIN\b/i.test(sql)) begins++;
        if (capturing && /\b(?:FROM|JOIN)\s+runtime_permits\b/i.test(sql) && namespaceQuery(args, namespace)) namespaceReads++;
        return next();
      });
      const callers = Array.from({ length: 96 }, (_, index) => {
        const id = `caller-${index}`;
        const permits = new PostgresPermitStore(store.pool);
        assert.equal(permits.pool, store.controlPool);
        return permits.change(namespace, (rows, now) => {
          rows.push(permit(id, now, rows.length + 1));
          return id;
        });
      });
      const results = await within(Promise.all(callers), '96 batched changes', 20_000);
      capturing = false;
      assert.equal(new Set(results).size, 96);
      const rows = await rowsFor(store, namespace);
      assert.equal(rows.length, 96);
      assert.equal(new Set(rows.map(row => row.id)).size, 96);
      assert.deepEqual(rows.map(row => row.order).sort((a, b) => a - b),
        Array.from({ length: 96 }, (_, index) => index + 1), 'callbacks see earlier mutations in queue order');
      assert.ok(begins > 0 && begins < 48, `expected clear transaction coalescing: ${begins} BEGIN for 96 callers`);
      assert.ok(namespaceReads > 0 && namespaceReads < 48,
        `expected fewer whole-namespace reads: ${namespaceReads} for 96 callers`);
    } finally { await store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]); await close(); }
  });

test('owner waiting limit and FIFO grant survive batching, while a callback that mutates then throws cannot taint the next caller',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-fairness-${randomUUID()}`;
    const failedNamespace = `batch-callback-${randomUUID()}`;
    const callbackFailures: string[] = [];
    const underlying = new PostgresPermitStore(store.pool);
    const observingStore: PermitStore = {
      change<T>(name: string, fn: (rows: PermitRow[], now: number) => T, signal?: AbortSignal): Promise<T> {
        return underlying.change(name, (rows, now) => {
          try { return fn(rows, now); }
          catch (error) { callbackFailures.push(String(error)); throw error; }
        }, signal);
      },
    };
    const scheduler = new ResourceScheduler(observingStore, namespace);
    const firstAbort = new AbortController(), secondAbort = new AbortController();
    let holder: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
    let first: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
    let second: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
    let firstCall: ReturnType<ResourceScheduler['acquire']> | undefined;
    let secondCall: ReturnType<ResourceScheduler['acquire']> | undefined;
    try {
      const firstWaiting = deferred(), secondWaiting = deferred();
      const demand = { slot: { units: 1, limit: 1 } };
      holder = await scheduler.acquire({ owner: 'holder', task: 'holder', demands: demand, waitMs: 5000 });
      firstCall = scheduler.acquire({ owner: 'first', task: 'first', demands: demand, waitMs: 5000,
        signal: firstAbort.signal,
        maxOwnerWaiting: 1, onWaiting: () => firstWaiting.resolve() });
      await within(firstWaiting.promise, 'first waiter');
      secondCall = scheduler.acquire({ owner: 'second', task: 'second', demands: demand, waitMs: 5000,
        signal: secondAbort.signal,
        onWaiting: () => secondWaiting.resolve() });
      await within(secondWaiting.promise, 'second waiter');
      await assert.rejects(scheduler.acquire({ owner: 'first', task: 'extra', demands: demand,
        waitMs: 1000, maxOwnerWaiting: 1 }), { code: 'database_control_unavailable' });
      assert.equal(callbackFailures.at(-1), 'Error: owner_resource_queue_full');
      assert.equal((await rowsFor(store, namespace)).filter(row => row.owner === 'first').length, 1,
        'rejected extra waiter must not appear in the database');
      await holder.release(); holder = undefined;
      first = await within(firstCall, 'first FIFO grant');
      const middle = await rowsFor(store, namespace);
      assert.equal(middle.find(row => row.owner === 'first')?.state, 'running');
      assert.equal(middle.find(row => row.owner === 'second')?.state, 'waiting');
      await first.release(); first = undefined;
      second = await within(secondCall, 'second FIFO grant');
      assert.equal((await rowsFor(store, namespace)).find(row => row.owner === 'second')?.state, 'running');

      const permits = new PostgresPermitStore(store.pool);
      const bad = permits.change(failedNamespace, (rows, now) => {
        rows.push(permit('must-rollback', now, 1));
        throw serviceError('injected_callback_failure', 'injected_callback_failure', 503);
      });
      const good = new PostgresPermitStore(store.pool).change(failedNamespace, (rows, now) => {
        assert.equal(rows.some(row => row.id === 'must-rollback'), false);
        rows.push(permit('survivor', now, 1));
        return 'survivor';
      });
      const outcomes = await within(Promise.allSettled([bad, good]), 'isolated callbacks');
      assert.equal(outcomes[0]?.status, 'rejected');
      assert.equal((outcomes[0] as PromiseRejectedResult).reason.code, 'injected_callback_failure');
      assert.deepEqual(outcomes[1], { status: 'fulfilled', value: 'survivor' });
      assert.deepEqual((await rowsFor(store, failedNamespace)).map(row => row.id), ['survivor']);
    } finally {
      firstAbort.abort(new Error('test_cleanup'));
      secondAbort.abort(new Error('test_cleanup'));
      await Promise.all([holder?.release(), first?.release(), second?.release()]);
      const completed = await Promise.allSettled([firstCall, secondCall].filter(
        (call): call is ReturnType<ResourceScheduler['acquire']> => Boolean(call)));
      for (const result of completed) if (result.status === 'fulfilled') await result.value.release();
      await store.pool.query('DELETE FROM runtime_permits WHERE namespace=ANY($1::text[])', [[namespace, failedNamespace]]);
      await close();
    }
  });

test('cancelling a queued caller leaves no row and does not delay later callers',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-queued-abort-${randomUUID()}`;
    const entered = deferred(), resume = deferred();
    let held = false;
    try {
      await hookControlQueries(store, async (sql, args, next) => {
        if (!held && /\b(?:FROM|JOIN)\s+runtime_permits\b/i.test(sql) && namespaceQuery(args, namespace)) {
          held = true; entered.resolve(); await resume.promise;
        }
        return next();
      });
      const permits = new PostgresPermitStore(store.pool);
      const first = permits.change(namespace, (rows, now) => { rows.push(permit('first', now, 1)); return 'first'; });
      await within(entered.promise, 'first SQL read');
      const cancelled = new AbortController();
      const queued = new PostgresPermitStore(store.pool).change(namespace,
        (rows, now) => { rows.push(permit('cancelled', now, rows.length + 1)); return 'cancelled'; }, cancelled.signal);
      const survivor = new PostgresPermitStore(store.pool).change(namespace,
        (rows, now) => { rows.push(permit('survivor', now, rows.length + 1)); return 'survivor'; });
      cancelled.abort(new Error('cancel_while_queued'));
      resume.resolve();
      const outcomes = await within(Promise.allSettled([first, queued, survivor]), 'queued abort and recovery');
      assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected', 'fulfilled']);
      assert.deepEqual((await rowsFor(store, namespace)).map(row => row.id).sort(), ['first', 'survivor']);
      assert.equal(store.controlPool.waitingCount, 0);
    } finally { resume.resolve(); await store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]); await close(); }
  });

test('cancelling after callbacks during SQL persistence rolls back that item and retries surviving callers',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-write-abort-${randomUUID()}`;
    const cancelledId = `cancel-${randomUUID()}`;
    const entered = deferred(), resume = deferred();
    let held = false;
    try {
      await hookControlQueries(store, async (sql, args, next) => {
        if (!held && /\bINSERT\s+INTO\s+runtime_permits\b/i.test(sql)
          && JSON.stringify(args.slice(1)).includes(cancelledId)) {
          held = true; entered.resolve(); await resume.promise;
        }
        return next();
      });
      const cancelled = new AbortController();
      const aborted = new PostgresPermitStore(store.pool).change(namespace,
        (rows, now) => { rows.push(permit(cancelledId, now, rows.length + 1)); return cancelledId; }, cancelled.signal);
      const survivor = new PostgresPermitStore(store.pool).change(namespace,
        (rows, now) => { rows.push(permit('survivor', now, rows.length + 1)); return 'survivor'; });
      await within(entered.promise, 'SQL persistence latch');
      cancelled.abort(new Error('cancel_during_write'));
      resume.resolve();
      const outcomes = await within(Promise.allSettled([aborted, survivor]), 'write abort recovery');
      assert.deepEqual(outcomes.map(outcome => outcome.status), ['rejected', 'fulfilled']);
      assert.deepEqual((await rowsFor(store, namespace)).map(row => row.id), ['survivor']);
      assert.equal(await new PostgresPermitStore(store.pool).change(namespace, rows => rows.length), 1,
        'the control connection remains usable after rollback');
    } finally { resume.resolve(); await store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]); await close(); }
  });

test('one caller cancelling in the COMMIT window does not destroy a shared transaction needed by its survivor',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-partial-commit-abort-${randomUUID()}`;
    const entered = deferred(), resume = deferred();
    const executed = new Set<string>();
    let includedAtCommit: string[] = [], held = false;
    try {
      await hookControlQueries(store, async (sql, _args, next) => {
        if (!held && /^\s*COMMIT\b/i.test(sql)) {
          held = true;
          includedAtCommit = [...executed];
          entered.resolve();
          await resume.promise;
        }
        return next();
      });
      const cancelled = new AbortController();
      const cancelledCall = new PostgresPermitStore(store.pool).change(namespace, (rows, now) => {
        executed.add('cancelled');
        rows.push(permit('cancelled', now, rows.length + 1));
        return 'cancelled';
      }, cancelled.signal);
      const survivorCall = new PostgresPermitStore(store.pool).change(namespace, (rows, now) => {
        executed.add('survivor');
        rows.push(permit('survivor', now, rows.length + 1));
        return 'survivor';
      });
      await within(entered.promise, 'shared COMMIT window');
      assert.deepEqual(includedAtCommit, ['cancelled', 'survivor'], 'both callers must share the paused transaction');
      cancelled.abort(new Error('cancel_in_commit_window'));
      resume.resolve();
      const outcomes = await within(Promise.allSettled([cancelledCall, survivorCall]), 'partial COMMIT cancellation');
      assert.deepEqual(outcomes.map(outcome => outcome.status), ['rejected', 'fulfilled']);
      assert.deepEqual(outcomes[1], { status: 'fulfilled', value: 'survivor' });
      assert.equal((await rowsFor(store, namespace)).some(row => row.id === 'survivor'), true,
        'the surviving caller must observe a committed row');
    } finally { resume.resolve(); await store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]); await close(); }
  });

test('a failed COMMIT rejects every caller in that transaction and the shared Pool recovers',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const { store, close } = await fixture();
    const namespace = `batch-commit-fail-${randomUUID()}`;
    const included = new Set<string>();
    let firstCommit = true;
    let failedBatch: string[] = [];
    try {
      await hookControlQueries(store, async (sql, _args, next) => {
        if (firstCommit && /^\s*COMMIT\b/i.test(sql)) {
          firstCommit = false;
          failedBatch = [...included];
          throw new Error('injected_commit_failure');
        }
        return next();
      });
      const ids = Array.from({ length: 40 }, (_, index) => `commit-${index}`);
      const outcomes = await within(Promise.allSettled(ids.map(id =>
        new PostgresPermitStore(store.pool).change(namespace, (rows, now) => {
          included.add(id);
          rows.push(permit(id, now, rows.length + 1));
          return id;
        }))), 'commit failure batch');
      assert.ok(failedBatch.length >= 2, `expected a multi-caller first batch, got ${failedBatch.length}`);
      for (const id of failedBatch) assert.equal(outcomes[ids.indexOf(id)]?.status, 'rejected', `${id} falsely succeeded`);
      const persisted = new Set((await rowsFor(store, namespace)).map(row => row.id));
      for (const id of failedBatch) assert.equal(persisted.has(id), false, `${id} escaped failed COMMIT`);
      assert.equal(await new PostgresPermitStore(store.pool).change(namespace, (rows, now) => {
        rows.push(permit('after-failure', now, rows.length + 1)); return 'recovered';
      }), 'recovered');
      assert.equal((await rowsFor(store, namespace)).some(row => row.id === 'after-failure'), true);
    } finally { await store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]); await close(); }
  });

test('two independent control Pools contend on the same database namespace without over-admitting',
  { skip: !databaseUrl, timeout: 20_000 }, async () => {
    const left = await fixture();
    const right = await fixture();
    const namespace = `batch-cross-pool-${randomUUID()}`;
    const demand = { shared: { units: 1, limit: 1 } };
    const waiting = deferred();
    const leftAbort = new AbortController(), rightAbort = new AbortController();
    let a: ReturnType<ResourceScheduler['acquire']> | undefined;
    let b: ReturnType<ResourceScheduler['acquire']> | undefined;
    let winner: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
    let loser: Awaited<ReturnType<ResourceScheduler['acquire']>> | undefined;
    try {
      assert.notEqual(left.store.controlPool, right.store.controlPool);
      a = new ResourceScheduler(new PostgresPermitStore(left.store.pool), namespace)
        .acquire({ owner: 'left', task: 'left', demands: demand, waitMs: 5000, signal: leftAbort.signal,
          onWaiting: () => waiting.resolve() });
      b = new ResourceScheduler(new PostgresPermitStore(right.store.pool), namespace)
        .acquire({ owner: 'right', task: 'right', demands: demand, waitMs: 5000, signal: rightAbort.signal,
          onWaiting: () => waiting.resolve() });
      const first = await within(Promise.race([a.then(permit => ({ permit, side: 'left' as const })),
        b.then(permit => ({ permit, side: 'right' as const }))]), 'first cross-Pool grant');
      winner = first.permit;
      await within(waiting.promise, 'cross-Pool waiter');
      const rows = await rowsFor(left.store, namespace);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => row.state).sort(), ['running', 'waiting']);
      await winner.release(); winner = undefined;
      loser = await within(first.side === 'left' ? b : a, 'second cross-Pool grant');
      assert.equal((await rowsFor(left.store, namespace)).filter(row => row.state === 'running').length, 1);
    } finally {
      leftAbort.abort(new Error('test_cleanup'));
      rightAbort.abort(new Error('test_cleanup'));
      await winner?.release(); await loser?.release();
      const completed = await Promise.allSettled([a, b].filter(
        (call): call is ReturnType<ResourceScheduler['acquire']> => Boolean(call)));
      for (const result of completed) if (result.status === 'fulfilled') await result.value.release();
      await left.store.pool.query('DELETE FROM runtime_permits WHERE namespace=$1', [namespace]);
      await right.close(); await left.close();
    }
  });
