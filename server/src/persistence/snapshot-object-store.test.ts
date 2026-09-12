import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  jsonBytes,
  LocalSnapshotObjectStore,
  normalizeSourceSnapshotPath,
  parseSourceSnapshotManifest,
  parseSnapshotManifest,
  putSourceSnapshot,
  snapshotObjectDigest,
  tencentCosClientOptions,
  verifySourceSnapshotObject,
  verifySnapshotObject,
  type SnapshotManifest,
} from "./snapshot-object-store.js";

test("source preparation stops queued uploads and settles active uploads before returning cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-preparation-cancel-"));
  const controller = new AbortController();
  let puts = 0, active = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFile(join(root, `${i}.ts`), `// ${i}`)));
    const operation = putSourceSnapshot({ sourceRoot: root, publicKey: "a".repeat(64), snapshotId: "cancel", concurrency: 2,
      signal: controller.signal, objectStore: {
        kind: "local", get: async () => null, delete: async () => {},
        put: async (key, body) => {
          puts++; active++;
          if (puts === 2) controller.abort(new Error("analysis_cancelled"));
          await barrier;
          active--;
          return { key, bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
        },
      } });
    let settled = false;
    const checked = assert.rejects(operation, /analysis_cancelled/).then(() => { settled = true; });
    while (!controller.signal.aborted) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(active, 2);
    release();
    await checked;
    assert.equal(active, 0);
    assert.equal(puts, 2, "no queued file or final manifest is uploaded after cancellation");
  } finally {
    release?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("Tencent COS client options carry temporary STS security tokens", () => {
  assert.deepEqual(tencentCosClientOptions({
    bucket: "example-1234567890",
    region: "ap-guangzhou",
    secretId: "temporary-id",
    secretKey: "temporary-key",
    securityToken: "temporary-session-token",
  }), {
    SecretId: "temporary-id",
    SecretKey: "temporary-key",
    SecurityToken: "temporary-session-token",
    Domain: undefined,
    Timeout: 30_000,
  });
});

test("local snapshot object store round-trips bytes and rejects traversal keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-objects-"));
  try {
    const store = new LocalSnapshotObjectStore(root);
    const body = Buffer.from(JSON.stringify({ ok: true }) + String.fromCharCode(10), "utf8");
    const stored = await store.put("snapshots/test.json", body);
    assert.equal(stored.bytes, body.byteLength);
    assert.match(stored.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Buffer.from((await store.get("snapshots/test.json")) ?? []), body);
    await assert.rejects(() => store.get("../outside.json"), /invalid_object_key/);
    await store.delete("snapshots/test.json");
    assert.equal(await store.get("snapshots/test.json"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source snapshot stores immutable files behind a validated manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-source-objects-"));
  try {
    const sourceRoot = join(root, "source");
    const objectRoot = join(root, "objects");
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "line one\nline two\n", "utf8");
    await writeFile(join(sourceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(sourceRoot, ".snapshot-meta.json"), "{}\n", "utf8");
    const store = new LocalSnapshotObjectStore(objectRoot);
    const publicKey = "c".repeat(64);
    const stored = await putSourceSnapshot({
      objectStore: store,
      sourceRoot,
      publicKey,
      snapshotId: "snap:source-integrity",
      createdAt: "2026-08-24T00:00:00.000Z",
      concurrency: 2,
    });
    const parsed = parseSourceSnapshotManifest(
      await store.get(stored.manifestObject.key),
      { publicKey, snapshotId: "snap:source-integrity" },
    );
    assert.deepEqual(parsed.files.map((file) => file.path), ["README.md", "src/index.ts"]);
    assert.equal(parsed.total_bytes, Buffer.byteLength("line one\nline two\nexport const ok = true;\n"));
    const readme = parsed.files[0]!;
    assert.equal(
      Buffer.from(verifySourceSnapshotObject(await store.get(readme.key), readme)).toString("utf8"),
      "line one\nline two\n",
    );
    const changed = Buffer.from(await store.get(readme.key) ?? []);
    changed[0] = changed[0] === 108 ? 76 : 108;
    assert.throws(
      () => verifySourceSnapshotObject(changed, readme),
      /source_snapshot_object_integrity_mismatch/,
    );
    assert.throws(() => normalizeSourceSnapshotPath("../outside.ts"), /invalid_source_path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot manifest binds both payloads and rejects changed object bytes", () => {
  const publicKey = "a".repeat(64);
  const view = jsonBytes({ snapshot_id: "snap:integrity", graph: { nodes: [], edges: [] } });
  const analysis = jsonBytes({ snapshot_id: "snap:integrity", fact_graph: { nodes: [], edges: [] } });
  const manifest: SnapshotManifest = {
    schema_version: 1,
    public_snapshot_key: publicKey,
    snapshot_id: "snap:integrity",
    objects: [
      { kind: "view", key: `snapshots/view-${snapshotObjectDigest(view)}.json`, bytes: view.byteLength, sha256: snapshotObjectDigest(view) },
      { kind: "analysis", key: `snapshots/analysis-${snapshotObjectDigest(analysis)}.json`, bytes: analysis.byteLength, sha256: snapshotObjectDigest(analysis) },
    ],
    query_directory: {
      digest: "b".repeat(64),
      nodes: 0,
      edges: 0,
      evidence: 0,
      layers: 0,
      value_points: 0,
    },
    created_at: "2026-08-24T00:00:00.000Z",
  };
  const parsed = parseSnapshotManifest(jsonBytes(manifest), {
    publicKey,
    snapshotId: "snap:integrity",
  });
  assert.deepEqual(
    verifySnapshotObject<Record<string, unknown>>(view, parsed.objects[0]!),
    { snapshot_id: "snap:integrity", graph: { nodes: [], edges: [] } },
  );
  const changed = Buffer.from(view);
  changed[0] = changed[0] === 123 ? 91 : 123;
  assert.throws(
    () => verifySnapshotObject(changed, parsed.objects[0]!),
    /snapshot_object_integrity_mismatch/,
  );
});
