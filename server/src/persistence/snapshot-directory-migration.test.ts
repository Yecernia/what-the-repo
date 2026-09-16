import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresStore } from './postgres-store.js';
import { asEvidenceSnapshot } from '../domain/snapshot.js';
const ownerUrl = process.env.WTR_STORAGE_TEST_DATABASE_URL;
const runtimeUrl = process.env.WTR_STORAGE_RUNTIME_DATABASE_URL;
const readerUrl = process.env.WTR_STORAGE_READER_DATABASE_URL;
const tables = ['nodes','edges','evidence','evidence_links','layers','value_points','overlay_memberships','projection_nodes','projection_edges'];

test('compact directory migration preserves data, constraints and separate runtime/read-only privileges', { skip: !ownerUrl || !runtimeUrl || !readerUrl }, async () => {
  for (const url of [ownerUrl!,runtimeUrl!,readerUrl!]) {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(parsed.pathname, /^\/wtr_storage_test_[a-z0-9_]+$/);
  }
  const root = await mkdtemp(join(tmpdir(), 'wtr-directory-migration-'));
  const config = { root, migrationsRoot: join(process.cwd(),'migrations'), encryptionSecret:'migration-test-only', poolMax:2 };
  const store = new PostgresStore({ ...config, databaseUrl:ownerUrl! });
  const runtime = new PostgresStore({ ...config, databaseUrl:runtimeUrl! });
  const reader = new Pool({ connectionString:readerUrl!, max:1 });
  const up = await readFile(join(config.migrationsRoot,'0023_compact_snapshot_directory.sql'),'utf8');
  const down = await readFile(join(config.migrationsRoot,'0023_compact_snapshot_directory.down.sql'),'utf8');
  const key = createHash('sha256').update(randomUUID()).digest('hex'), snapshotId = 'snap:migration:'+key.slice(0,12);
  const evidence = {stable_id:'proof',label:'proof',path:'src/a.ts',start_line:1,end_line:2,kind:'symbol'};
  const view = asEvidenceSnapshot({snapshot_id:snapshotId,graph:{nodes:[{id:'A',name:'A',responsibility:'test',members:[evidence],evidence:[evidence]}],edges:[],layers:[]},value_points:[],learning_plan:{steps:[]}})!;
  const analysis = {fact_graph:{nodes:[],edges:[]}};
  const signature = async () => {
    const result: Record<string,unknown> = {};
    for (const table of tables) result[table] = (await store.pool.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) AS digest
      FROM snapshot_query_${table} t WHERE public_snapshot_key=$1`,[key])).rows[0];
    return result;
  };
  const migrate = async (sql:string) => {
    const db=await store.pool.connect();
    try { await db.query(sql); } catch(error) { await db.query('ROLLBACK'); throw error; } finally {db.release();}
  };
  try {
    await store.init();
    await mkdir(store.publicSourceSnapshotRoot(key,snapshotId),{recursive:true});
    await store.savePublicSnapshot({publicKey:key,repository:'test/migration',commitSha:'a'.repeat(40),snapshotId,view,analysis});
    const before = await signature();
    await migrate(down);
    assert.deepEqual(await signature(), before);
    // Existing object ACLs, not blanket future defaults, must survive migration.
    const runtimeRole = (await runtime.pool.query('SELECT current_user AS name')).rows[0].name;
    const readerRole = (await reader.query('SELECT current_user AS name')).rows[0].name;
    for(const role of [runtimeRole,readerRole]) assert.match(role,/^wtr_storage_test_[a-z0-9_]+$/);
    await store.pool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${readerRole}"`);
    await store.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${runtimeRole}"`);
    await store.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${readerRole}"`);
    await store.pool.query("UPDATE snapshot_query_nodes SET snapshot_id='wrong' WHERE public_snapshot_key=$1",[key]);
    await assert.rejects(migrate(up), /snapshot directory identity mismatch/);
    assert.equal((await store.pool.query("SELECT relkind FROM pg_class WHERE oid='snapshot_query_nodes'::regclass")).rows[0].relkind,'r');
    assert.equal((await store.pool.query("SELECT 1 FROM schema_migrations WHERE version='0023_compact_snapshot_directory'")).rowCount,0);
    await store.pool.query('UPDATE snapshot_query_nodes SET snapshot_id=$2 WHERE public_snapshot_key=$1',[key,snapshotId]);
    await migrate(up);
    assert.deepEqual(await signature(), before);
    const actual = await runtime.queryPublicSnapshot({publicKey:key,snapshotId,query:{entity_ids:['A'],include_metadata:false}});
    assert.equal(actual.nodes[0]?.node_id,'A');
    // The runtime is not the table owner and has no migration privilege.
    assert.equal((await runtime.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper,false);
    const secondKey=createHash('sha256').update(randomUUID()).digest('hex');
    await runtime.savePublicSnapshot({publicKey:secondKey,repository:'test/runtime-write',commitSha:'b'.repeat(40),snapshotId,view,analysis,sourceRoot:store.publicSourceSnapshotRoot(key,snapshotId)});
    assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_query_nodes WHERE public_snapshot_key=$1',[secondKey])).rows[0].n,1);
    await assert.rejects(reader.query('DELETE FROM snapshot_directory_nodes WHERE false'), {code:'42501'});
    await assert.rejects(store.pool.query("INSERT INTO snapshot_directory_evidence_links(directory_id,evidence_id,owner_kind,owner_key,role) SELECT directory_id,'missing','node','A','evidence' FROM snapshot_query_directories WHERE public_snapshot_key=$1",[key]), {code:'23503'});
    await runtime.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[secondKey]);
    assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_query_nodes WHERE public_snapshot_key=$1',[secondKey])).rows[0].n,0);
    await migrate(down);
    assert.deepEqual(await signature(),before);
    assert.equal((await reader.query('SELECT count(*)::int AS n FROM snapshot_query_nodes WHERE public_snapshot_key=$1',[key])).rows[0].n,1);
    await assert.rejects(reader.query('DELETE FROM snapshot_query_nodes WHERE false'), {code:'42501'});
    await migrate(up);
    assert.deepEqual(await signature(),before);
  } finally {
    await store.pool.query('DELETE FROM canonical_public_repository_snapshots WHERE public_snapshot_key=$1',[key]).catch(()=>undefined);
    await Promise.all([store.close(),runtime.close(),reader.end()]);
    await rm(root,{recursive:true,force:true});
  }
});
