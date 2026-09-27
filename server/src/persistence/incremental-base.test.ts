import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from './file-store.js';
import { PostgresStore } from './postgres-store.js';
import { canonicalPublicSnapshotKey } from '../analysis/identity.js';
import { bytesDigest } from '../analysis/source-input.js';
import { analyzeStaticSource } from '../analysis/static-kernel.js';
import { buildSnapshot } from '../analysis/graph.js';
import { createAnalysisCache, readAnalysisCache } from '../analysis/incremental.js';

const databaseUrl = process.env.WTR_ADMIN_TEST_DATABASE_URL;

for (const backend of ['file', 'postgres'] as const) {
  test(`${backend}: incremental bases cross semantic configuration boundaries while complete snapshots stay isolated`,
    { skip: backend === 'postgres' && !databaseUrl, timeout: 30_000 }, async () => {
      if (backend === 'postgres') assert.match(new URL(databaseUrl!).pathname, /^\/wtr_admin_test_[a-z0-9_]+$/);
      const root = await mkdtemp(join(tmpdir(), 'wtr-incremental-base-'));
      const store = backend === 'file' ? new FileStore(root) : new PostgresStore({
        root, databaseUrl: databaseUrl!, migrationsRoot: join(process.cwd(), 'migrations'),
        encryptionSecret: 'incremental-base-test-only', poolMax: 1,
      });
      try {
        await store.init();
        const repository = `example/incremental-base-${randomUUID()}`;
        const commitSha = 'a'.repeat(40);
        const analyzerBundleVersion = 'incremental-base-test';
        const oldDigest = 'old-context-builder';
        const nextIdentity = { repository, analyzerBundleVersion, analysisConfigDigest: 'new-context-builder' };
        const publicKey = canonicalPublicSnapshotKey(repository, commitSha, analyzerBundleVersion, oldDigest);
        const snapshotId = `snap:${randomUUID()}`;
        const sourceRoot = store.publicSourceSnapshotRoot(publicKey, snapshotId);
        await mkdir(sourceRoot, { recursive: true });
        const source = 'export function greet() { return "hello"; }\n';
        await writeFile(join(sourceRoot, 'main.ts'), source);
        const manifest = [{ path: 'main.ts', digest: bytesDigest(source), bytes: Buffer.byteLength(source) }];
        const staticResult = await analyzeStaticSource({ manifest, sourceRoot, previous: null });
        const cache = createAnalysisCache({ manifest, parsedFiles: staticResult.files,
          syntaxFiles: staticResult.syntaxFiles, lspResults: [] });
        const snapshot = buildSnapshot({ snapshotId, repository, commitSha, files: staticResult.files, sourceRoot });
        await store.savePublicSnapshot({ publicKey, repository, commitSha, snapshotId, analyzerBundleVersion,
          analysisConfigDigest: oldDigest, view: snapshot, analysis: { ...snapshot, analysis_cache: cache } });

        // Do not exclude the commit: a new semantic configuration may analyze identical source.
        const base = await store.loadLatestPublicSnapshotIncrementalBase(nextIdentity);
        assert.ok(base);
        assert.equal(base.metadata.commit_sha, commitSha);
        assert.equal(base.metadata.analysis_config_digest, oldDigest);
        assert.equal(base.metadata.public_snapshot_key, publicKey);
        assert.equal(base.factGraphAvailable, true);
        const recoveredCache = readAnalysisCache(base.analysisCache);
        assert.deepEqual(recoveredCache, cache);
        assert.ok(recoveredCache?.parsed_files[0]?.syntaxKey);
        assert.ok(recoveredCache?.parsed_files[0]?.semanticKey);
        const warm = await analyzeStaticSource({ manifest, sourceRoot, previous: recoveredCache });
        assert.equal(warm.metrics.syntax_cache_hits, manifest.length);
        assert.equal(warm.metrics.semantic_cache_hits, manifest.length);
        const incompatible = structuredClone(recoveredCache!);
        for (const file of [...incompatible.syntax_files, ...incompatible.parsed_files]) {
          file.syntaxKey = 'obsolete-parser-fingerprint';
        }
        const rebuilt = await analyzeStaticSource({ manifest, sourceRoot, previous: incompatible });
        assert.equal(rebuilt.metrics.syntax_cache_hits, 0);
        assert.equal(rebuilt.metrics.semantic_cache_hits, 0);
        assert.deepEqual(rebuilt.files, staticResult.files);
        assert.equal(await store.loadLatestPublicSnapshot(nextIdentity), null);
        assert.ok(await store.loadLatestPublicSnapshot({ ...nextIdentity, analysisConfigDigest: oldDigest }));
        assert.equal(await store.loadLatestPublicSnapshotIncrementalBase({ ...nextIdentity,
          analyzerBundleVersion: 'different-analyzer' }), null);
        assert.equal(await store.loadLatestPublicSnapshotIncrementalBase({ ...nextIdentity,
          repository: `${repository}-other` }), null);
        assert.equal(await store.loadLatestPublicSnapshotIncrementalBase({ ...nextIdentity, excludeCommitSha: commitSha }), null);

        // Keep the payload present to prove the query itself excludes purged metadata.
        if (store instanceof PostgresStore) {
          await store.pool.query('UPDATE canonical_public_repository_snapshots SET payload_purged_at = now() WHERE public_snapshot_key = $1', [publicKey]);
        } else {
          const metadataPath = join(root, 'public-repository-snapshots', publicKey, 'metadata.json');
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
          await writeFile(metadataPath, JSON.stringify({ ...metadata, payload_purged_at: new Date().toISOString() }));
        }
        assert.equal(await store.loadLatestPublicSnapshotIncrementalBase(nextIdentity), null);
        assert.equal(await store.loadLatestPublicSnapshot({ ...nextIdentity, analysisConfigDigest: oldDigest }), null);
      } finally {
        await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
}
