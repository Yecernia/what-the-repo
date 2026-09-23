import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.WTR_STORAGE_TEST_DATABASE_URL;

test('directory text indexes migrate up, down, and up without changing scoped matches',
  { skip: !databaseUrl, timeout: 60_000 }, async () => {
    const url = new URL(databaseUrl!);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/wtr_storage_test_[a-z0-9_]+$/);
    const schema = `wtr_text_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    const db = await pool.connect();
    const up = await readFile(join(process.cwd(), 'migrations/0030_directory_text_search.sql'), 'utf8');
    const down = await readFile(join(process.cwd(), 'migrations/0030_directory_text_search.down.sql'), 'utf8');
    const matches = async (table: 'nodes' | 'edges') => {
      const key = table === 'nodes' ? 'node_key' : 'edge_key';
      return (await db.query<{ key: string }>(
        `SELECT ${key} AS key FROM snapshot_directory_${table}
         WHERE directory_id=$1 AND search_text LIKE $2 ORDER BY ${key}`, [7, '%hook%'],
      )).rows.map(row => row.key);
    };
    const indexDefinition = async (table: 'nodes' | 'edges') => {
      const result = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2`,
        [schema, `snapshot_directory_${table}_text_idx`],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0]!.indexdef;
    };
    const versionExists = async () => (await db.query(
      "SELECT 1 FROM schema_migrations WHERE version='0030_directory_text_search'",
    )).rowCount === 1;
    try {
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET search_path TO "${schema}", public`);
      await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY)');
      for (const table of ['nodes', 'edges'] as const) {
        const key = table === 'nodes' ? 'node_key' : 'edge_key';
        await db.query(`CREATE TABLE snapshot_directory_${table}
          (directory_id bigint NOT NULL, ${key} text NOT NULL, search_text text NOT NULL)`);
        await db.query(`CREATE INDEX snapshot_directory_${table}_text_idx
          ON snapshot_directory_${table} USING gin (search_text gin_trgm_ops)`);
        await db.query(`INSERT INTO snapshot_directory_${table}(directory_id,${key},search_text)
          VALUES (7,'wanted','a hook point'),(7,'other','entry'),(8,'foreign','a hook point')`);
      }
      const before = await Promise.all([matches('nodes'), matches('edges')]);
      assert.deepEqual(before, [['wanted'], ['wanted']]);

      for (const direction of ['up', 'down', 'up'] as const) {
        await db.query(direction === 'up' ? up : down);
        assert.equal(await versionExists(), direction === 'up');
        for (const table of ['nodes', 'edges'] as const) {
          const definition = await indexDefinition(table);
          assert.match(definition, /search_text gin_trgm_ops/);
          assert.equal(/\bdirectory_id\b/.test(definition), direction === 'up');
        }
        assert.deepEqual(await Promise.all([matches('nodes'), matches('edges')]), before);
        const temporary = await db.query(
          'SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexname IN ($2,$3,$4,$5)',
          [schema, 'snapshot_directory_nodes_text_next_idx', 'snapshot_directory_edges_text_next_idx',
            'snapshot_directory_nodes_text_single_idx', 'snapshot_directory_edges_text_single_idx'],
        );
        assert.equal(temporary.rowCount, 0);
      }
    } finally {
      await db.query('SET search_path TO public').catch(() => undefined);
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      db.release();
      await pool.end();
    }
  });
