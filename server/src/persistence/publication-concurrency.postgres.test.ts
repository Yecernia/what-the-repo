import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { LocalSnapshotObjectStore } from './snapshot-object-store.js';
import { LocalPermitStore } from '../scheduling/permits.js';
import { createProject } from '../domain/conversation.js';
import { newAnalysisJob } from '../domain/jobs.js';
import { AnalysisLeaseLostError } from './store.js';
import { reclaimSnapshotDirectoryBatch } from './directory-reclamation.js';

const databaseUrl = process.env.WTR_PUBLICATION_TEST_DATABASE_URL;
const modes = ['success', 'cancel', 'transfer', 'expire', 'write-failure', 'finalize-expire'] as const;
for (const mode of modes) test(`isolated PostgreSQL: publication ${mode} leaves heartbeats live and data atomic`,
  { skip: !databaseUrl, timeout: 60_000 }, async () => {
  const url = new URL(databaseUrl!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
  const id = randomUUID().replaceAll('-', '');
  const root = await mkdtemp(join(tmpdir(), 'wtr-publication-lock-'));
  const publicKey = createHash('sha256').update(id).digest('hex');
  const gate = String(BigInt('0x' + id.slice(0, 12)));
  const trigger = 'wtr_publication_gate_' + id;
  const admin = new Pool({ connectionString: url.toString(), max: 2 });
  const options = { root, databaseUrl: url.toString(), migrationsRoot: join(process.cwd(), 'migrations'),
    encryptionSecret: 'publication-lock-test-only', objectAdmissionStore: new LocalPermitStore(),
    objectStore: new LocalSnapshotObjectStore(join(root, 'objects')), poolMax: 4 };
  const store = new PostgresStore(options);
  const controlUrl = new URL(url); controlUrl.searchParams.set('options', '-c lock_timeout=250ms -c statement_timeout=3000ms');
  const control = new PostgresStore({ ...options, databaseUrl: controlUrl.toString() });
  const blocker = await admin.connect();
  let publication: Promise<unknown> | undefined, outcome: Promise<unknown> | undefined;
  let projectId: string | undefined;
  const patched = new Map<PoolClient, PoolClient['query']>();
  const inject = (client: PoolClient) => {
    if (patched.has(client)) return;
    const query = client.query;
    patched.set(client, query);
    client.query = ((...args: unknown[]) => {
      const result = (query as (...params: unknown[]) => unknown).apply(client, args);
      if (typeof args[0] !== 'string' || !args[0].includes('stage_snapshot_directory_child')
        || (args[1] as unknown[] | undefined)?.[1] !== 'edges') return result;
      return Promise.resolve(result).then(async value => {
        const child = (value as {rows: Array<{child_name: string}>}).rows[0]!.child_name;
        assert.match(child, /^snapshot_directory_edges_g[1-9][0-9]*$/);
        await Reflect.apply(query, client, [`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${child}
          FOR EACH ROW WHEN (NEW.edge_key='fact:gate-${id}') EXECUTE FUNCTION ${trigger}()`]);
        return value;
      });
    }) as PoolClient['query'];
  };
  try {
    await store.init();
    const sourceRoot = join(root, 'source'); await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'one.ts'), 'export const value = 1;\n');
    const snapshotId = 'snap:lock:' + id;
    const view = { snapshot_id: snapshotId, summary: { file_count: 1, symbol_count: 1, call_count: 1 },
      graph: { semantic_mode: 'static', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
      value_points: [], languages: [], learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] } };
    const node = { id: 'old', label: 'old', name: 'old', responsibility: '', members: [], evidence: [],
      certainty: 'verified', review_status: 'unreviewed', fan_in: 0, fan_out: 0 };
    const base = { publicKey, repository: 'test/lock-' + id, commitSha: 'a'.repeat(40), snapshotId, sourceRoot, view };
    await store.savePublicSnapshot({ ...base, analysis: { fact_graph: { nodes: [node], edges: [] } } });
    const previous = await store.loadPublicSnapshot(publicKey);
    const oldDirectory = (await admin.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].directory_id;
    const ownerId = 'guest:lock-' + id; await store.saveUser(ownerId, { kind: 'guest' });
    const project = createProject(ownerId, 'https://github.com/test/lock-' + id, 'Lock test', null);
    projectId = project.project_id; project.analysis.canonical_snapshot_key = publicKey;
    await store.createProjectWithJob(project, newAnalysisJob(projectId, 'lock:' + id));
    const claimed = await store.claimAnalysisJob('publisher-' + id, 60); assert.ok(claimed);
    assert.equal(claimed.project_id, projectId);
    const fence = { jobId: claimed.job_id, workerId: claimed.lease_owner!, attempt: claimed.attempt, projectId };
    await store.saveAnalysisCheckpoint(projectId, { stage: 'assembly', marker: id }, { snapshot_id: snapshotId });
    const pointer = await readFile(join(root, 'analysis-checkpoints', projectId + '.json'));
    await blocker.query('SELECT pg_advisory_lock($1::bigint)', [gate]);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME='canonical_public_repository_snapshots' THEN
          UPDATE analysis_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id='${fence.jobId}';
          RETURN NEW;
        END IF;
        PERFORM pg_advisory_xact_lock(${gate}::bigint);
        ${mode === 'write-failure' ? "RAISE EXCEPTION 'publication_injected_failure';" : ''}
        RETURN NEW; END $$;`);
    if (mode === 'finalize-expire') await admin.query(`CREATE TRIGGER ${trigger}_finalize BEFORE UPDATE ON canonical_public_repository_snapshots
      FOR EACH ROW WHEN (NEW.public_snapshot_key='${publicKey}' AND NEW.analysis_sha256 IS DISTINCT FROM OLD.analysis_sha256)
      EXECUTE FUNCTION ${trigger}();`);
    // Parent row triggers are not inherited by the staging children.
    store.pool.on('acquire', inject);
    const nodes = Array.from({ length: 3_001 }, (_, i) => ({ ...node, id: 'new-' + i, name: 'new-' + i }));
    const edges = Array.from({ length: 4_001 }, (_, i) => ({ id: i ? `edge-${id}-${i}` : 'gate-' + id,
      source: 'new-0', target: 'new-1', relation_kind: 'calls', label: 'calls', description: '',
      certainty: 'verified', weight: 1, evidence: [] }));
    publication = store.savePublicSnapshot({ ...base, analysis: { fact_graph: { nodes, edges } }, fence });
    outcome = publication.then(value => ({ value }), error => ({ error }));
    const deadline = performance.now() + 15_000;
    let writerPid: number | undefined;
    while (!writerPid && performance.now() < deadline) {
      const waiting = await admin.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [blockerPid]);
      writerPid = waiting.rows[0]?.pid;
      if (!writerPid) await delay(20);
    }
    assert.ok(writerPid, 'must observe the actual INSERT blocked inside PostgreSQL');
    assert.equal((await admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='analysis_jobs'::regclass AND mode IN ('RowShareLock','RowExclusiveLock')", [writerPid])).rowCount, 0); 
    const latency: number[] = [];
    for (let pulse = 0; pulse < 8; pulse++) {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const beat = (pulse % 2 ? control : store).heartbeatAnalysisJob(fence.jobId, fence.workerId, fence.attempt, 60);
      const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('heartbeat blocked')), 1_500); });
      assert.equal(await Promise.race([beat, limit]).finally(() => clearTimeout(timer)), true);
      latency.push(performance.now() - start); await delay(40);
    }
    assert.ok(Math.max(...latency) < 1_000, 'heartbeat cannot wait for the publication INSERT');
    assert.deepEqual((await store.loadPublicSnapshot(publicKey))?.analysis, previous!.analysis);
    assert.equal(await control.purgePublicSnapshotPayload(publicKey, new Date().toISOString()), false);
    let replacement: Awaited<ReturnType<PostgresStore['claimAnalysisJob']>> = null;
    if (mode === 'cancel') {
      assert.equal((await control.cancelAnalysisJob(projectId, ownerId, fence.jobId))?.status, 'cancelled');
      await admin.query('DELETE FROM project_public_snapshot_bindings WHERE project_id=$1', [projectId]);
      await admin.query('UPDATE canonical_public_repository_snapshots SET purge_after=clock_timestamp() WHERE public_snapshot_key=$1', [publicKey]);
      assert.equal(await control.purgePublicSnapshotPayload(publicKey, new Date(Date.now() + 1000).toISOString()), false,
        'cancelled in-flight writes still exclude reclamation, even without bindings');
    } else if (mode === 'transfer' || mode === 'expire') {
      await admin.query("UPDATE analysis_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=$1", [fence.jobId]);
      if (mode === 'transfer') {
        replacement = await control.claimAnalysisJob('replacement-' + id, 60);
        assert.equal(replacement?.job_id, fence.jobId); assert.equal(replacement?.attempt, fence.attempt + 1);
      }
    }
    await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [gate]);
    if (mode === 'success') {
      const timings = await publication as Record<string, number>;
      assert.ok(timings.publication_fence_ms! < 1_000);
      assert.equal(Number((await admin.query('SELECT edge_count FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].edge_count), edges.length);
      assert.notEqual((await admin.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].directory_id, oldDirectory);
      console.log(JSON.stringify({ mode, heartbeatCount: latency.length, heartbeatMaxMs: Math.max(...latency), fenceMs: timings.publication_fence_ms, directoryMs: timings.directory_write_ms }));
    } else {
      await assert.rejects(publication, mode === 'write-failure' ? /publication_injected_failure/ : (error: unknown) => error instanceof AnalysisLeaseLostError);
      assert.deepEqual((await store.loadPublicSnapshot(publicKey))?.analysis, previous!.analysis);
      assert.equal((await admin.query('SELECT directory_id FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].directory_id, oldDirectory);
      assert.equal((await admin.query(`SELECT 1 FROM snapshot_directory_reclamation q
        JOIN snapshot_query_directories d USING(directory_id) WHERE d.public_snapshot_key=$1`,[publicKey])).rowCount,0,
        'failed finalization cannot enqueue a still-visible generation');
      assert.equal((await admin.query(`SELECT 1 FROM snapshot_directory_generations g
        WHERE g.public_snapshot_key=$1 AND g.directory_id<>$2
          AND NOT EXISTS(SELECT 1 FROM snapshot_directory_reclamation q WHERE q.directory_id=g.directory_id)`,
      [publicKey,oldDirectory])).rowCount,0,'failed candidates are durably queued for reclamation');
      for (let pass = 0; pass < 40; pass++) {
        await reclaimSnapshotDirectoryBatch(admin);
        if (Number((await admin.query('SELECT count(*) AS n FROM snapshot_directory_generations WHERE public_snapshot_key=$1',
          [publicKey])).rows[0].n) === 1) break;
      }
      assert.equal(Number((await admin.query('SELECT count(*) AS n FROM snapshot_directory_generations WHERE public_snapshot_key=$1', [publicKey])).rows[0].n), 1,
        'reclamation removes the failed committed generation');
      if (mode === 'transfer') {
        await store.savePublicSnapshot({ ...base, analysis: { fact_graph: { nodes, edges } }, fence: {
          ...fence, workerId: replacement!.lease_owner!, attempt: replacement!.attempt } });
        assert.equal(Number((await admin.query('SELECT edge_count FROM snapshot_query_directories WHERE public_snapshot_key=$1', [publicKey])).rows[0].edge_count), edges.length);
      }
    }
    assert.deepEqual(await readFile(join(root, 'analysis-checkpoints', projectId + '.json')), pointer);
  } finally {
    await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [gate]).catch(() => undefined);
    await outcome;
    store.pool.off('acquire', inject);
    for (const [client, query] of patched) client.query = query;
    await admin.query(`DROP TRIGGER IF EXISTS ${trigger}_finalize ON canonical_public_repository_snapshots;
      DROP FUNCTION IF EXISTS ${trigger}() CASCADE;`).catch(() => undefined);
    if (projectId) await admin.query('DELETE FROM projects WHERE project_id=$1', [projectId]);
    await admin.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1', [publicKey]);
    blocker.release();
    await Promise.all([store.close(), control.close(), admin.end()]);
    await rm(root, { recursive: true, force: true });
  }
});
