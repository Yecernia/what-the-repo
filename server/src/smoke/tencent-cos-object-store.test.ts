import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  snapshotObjectDigest,
  type SnapshotObjectStore,
  type StoredObject,
} from "../persistence/snapshot-object-store.js";
import {
  cosSmokeRunPrefix,
  normalizeCosSmokePrefix,
  runTencentCosObjectSmoke,
  TencentCosSmokeAdmin,
  type CosSmokeApi,
} from "./tencent-cos-object-store.js";

interface MemoryVersion {
  id: string;
  body: Uint8Array | null;
}

class MemoryVersionedCos {
  private nextVersion = 0;
  readonly objects = new Map<string, MemoryVersion[]>();
  readonly calls = {
    getBucket: 0,
    listObjectVersions: 0,
  };

  constructor(private readonly versioningStatus: "Enabled" | "Suspended" | "Unconfigured" = "Enabled") {}

  put(key: string, body: Uint8Array): void {
    const versions = this.objects.get(key) ?? [];
    versions.unshift({ id: `version-${++this.nextVersion}`, body: Buffer.from(body) });
    this.objects.set(key, versions);
  }

  get(key: string): Uint8Array | null {
    const latest = this.objects.get(key)?.[0];
    return latest?.body ? Buffer.from(latest.body) : null;
  }

  delete(key: string): void {
    if (this.versioningStatus === "Unconfigured") {
      this.objects.delete(key);
      return;
    }
    const versions = this.objects.get(key) ?? [];
    versions.unshift({ id: `version-${++this.nextVersion}`, body: null });
    this.objects.set(key, versions);
  }

  removeVersion(key: string, versionId: string): void {
    const versions = (this.objects.get(key) ?? []).filter((version) => version.id !== versionId);
    if (versions.length) this.objects.set(key, versions);
    else this.objects.delete(key);
  }

  api(): CosSmokeApi {
    return {
      getBucketVersioning: async () => this.versioningStatus === "Unconfigured"
        ? ({ VersioningConfiguration: {} } as never)
        : ({ VersioningConfiguration: { Status: this.versioningStatus } } as never),
      getBucket: async (params) => {
        this.calls.getBucket += 1;
        const contents: Array<Record<string, unknown>> = [];
        for (const [key, rows] of [...this.objects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
          if (!key.startsWith(params.Prefix ?? "")) continue;
          const latest = rows[0];
          if (!latest?.body) continue;
          contents.push({
            Key: key,
            ETag: `\"${snapshotObjectDigest(latest.body)}\"`,
            Size: String(latest.body.byteLength),
            LastModified: "2026-08-25T00:00:00.000Z",
            Owner: { ID: "test", DisplayName: "test" },
            StorageClass: "STANDARD",
          });
        }
        return {
          Contents: contents,
          CommonPrefixes: [],
          IsTruncated: "false",
          Name: "test-bucket-1234567890",
          Prefix: params.Prefix ?? "",
          Marker: params.Marker ?? "",
          MaxKeys: "1000",
        } as never;
      },
      listObjectVersions: async (params) => {
        this.calls.listObjectVersions += 1;
        const versions: Array<Record<string, unknown>> = [];
        const deleteMarkers: Array<Record<string, unknown>> = [];
        for (const [key, rows] of [...this.objects.entries()].sort(([left], [right]) => left.localeCompare(right))) {
          if (!key.startsWith(params.Prefix ?? "")) continue;
          rows.forEach((row, index) => {
            const entry = {
              Key: key,
              VersionId: row.id,
              IsLatest: index === 0 ? "true" : "false",
              LastModified: "2026-08-25T00:00:00.000Z",
              Owner: { ID: "test", DisplayName: "test" },
            };
            if (row.body) {
              versions.push({
                ...entry,
                ETag: `\"${snapshotObjectDigest(row.body)}\"`,
                Size: String(row.body.byteLength),
                StorageClass: "STANDARD",
              });
            } else {
              deleteMarkers.push(entry);
            }
          });
        }
        return {
          Versions: versions,
          DeleteMarkers: deleteMarkers,
          CommonPrefixes: [],
          IsTruncated: "false",
          Name: "test-bucket-1234567890",
          Prefix: params.Prefix ?? "",
          KeyMarker: "",
          VersionIdMarker: "",
          MaxKeys: "1000",
        } as never;
      },
      headObject: async (params) => {
        const latest = this.objects.get(params.Key)?.[0];
        if (!latest?.body) throw Object.assign(new Error("not found"), { statusCode: 404, code: "NoSuchKey" });
        return {
          ETag: `\"${snapshotObjectDigest(latest.body)}\"`,
          VersionId: latest.id,
        } as never;
      },
      deleteMultipleObject: async (params) => {
        for (const object of params.Objects) {
          if (object.VersionId) this.removeVersion(object.Key, object.VersionId);
          else this.delete(object.Key);
        }
        return {
          Deleted: params.Objects.map((object) => ({ Key: object.Key, VersionId: object.VersionId })),
          Error: [],
        } as never;
      },
    };
  }
}

class MemoryPrefixedStore implements SnapshotObjectStore {
  readonly kind = "cos" as const;

  constructor(
    private readonly backend: MemoryVersionedCos,
    private readonly prefix: string,
  ) {}

  async put(key: string, body: Uint8Array): Promise<StoredObject> {
    this.backend.put(`${this.prefix}/${key}`, body);
    return {
      key,
      bytes: body.byteLength,
      sha256: snapshotObjectDigest(body),
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.backend.get(`${this.prefix}/${key}`);
  }

  async delete(key: string): Promise<void> {
    this.backend.delete(`${this.prefix}/${key}`);
  }
}

test("COS smoke prefixes stay inside a dedicated run directory", () => {
  assert.equal(normalizeCosSmokePrefix("what-the-repo/production"), "what-the-repo/production");
  assert.equal(
    cosSmokeRunPrefix("what-the-repo", "20260825-abcd1234"),
    "what-the-repo/smoke/20260825-abcd1234",
  );
  assert.throws(() => normalizeCosSmokePrefix("../production"), /cos_smoke_invalid_prefix/);
  assert.throws(() => normalizeCosSmokePrefix("what-the-repo//production"), /cos_smoke_invalid_prefix/);
  assert.throws(() => cosSmokeRunPrefix("what-the-repo", "short"), /cos_smoke_invalid_run_id/);
});

test("COS smoke round-trips, restores a delete marker, and removes every test version", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "what-the-repo-cos-smoke-test-"));
  try {
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "smoke readme\n", "utf8");
    await writeFile(join(sourceRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");
    const backend = new MemoryVersionedCos();
    const runId = "20260825-abcd1234";
    const runPrefix = cosSmokeRunPrefix("what-the-repo", runId);
    const report = await runTencentCosObjectSmoke({
      runId,
      bucket: "test-bucket-1234567890",
      region: "ap-guangzhou",
      runPrefix,
      sourceRoot,
      writer: new MemoryPrefixedStore(backend, runPrefix),
      reader: new MemoryPrefixedStore(backend, runPrefix),
      admin: new TencentCosSmokeAdmin(backend.api(), "test-bucket-1234567890", "ap-guangzhou"),
      now: (() => {
        const values = [
          new Date("2026-08-25T00:00:00.000Z"),
          new Date("2026-08-25T00:00:01.250Z"),
        ];
        return () => values.shift() ?? new Date("2026-08-25T00:00:01.250Z");
      })(),
    });

    assert.equal(report.ok, true);
    assert.equal(report.versioning_status, "Enabled");
    assert.equal(report.object_round_trip.independent_client_read, true);
    assert.equal(report.source_snapshot.files, 2);
    assert.equal(report.version_restore.attempted, true);
    assert.equal(report.version_restore.restored, true);
    assert.equal(report.cleanup.strategy, "versions");
    assert.equal(report.cleanup.remaining_entries, 0);
    assert.ok(report.cleanup.entries_removed >= 5);
    assert.equal(backend.objects.size, 0);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("COS smoke skips version restoration when bucket versioning is not enabled", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "what-the-repo-cos-smoke-suspended-test-"));
  try {
    await writeFile(join(sourceRoot, "README.md"), "smoke readme\n", "utf8");
    const backend = new MemoryVersionedCos("Suspended");
    const runId = "20260825-suspended";
    const runPrefix = cosSmokeRunPrefix("what-the-repo", runId);
    const report = await runTencentCosObjectSmoke({
      runId,
      bucket: "test-bucket-1234567890",
      region: "ap-guangzhou",
      runPrefix,
      sourceRoot,
      writer: new MemoryPrefixedStore(backend, runPrefix),
      reader: new MemoryPrefixedStore(backend, runPrefix),
      admin: new TencentCosSmokeAdmin(backend.api(), "test-bucket-1234567890", "ap-guangzhou"),
    });

    assert.equal(report.versioning_status, "Suspended");
    assert.deepEqual(report.version_restore, {
      attempted: false,
      restored: false,
      delete_marker_version_id: null,
      restored_version_id: null,
    });
    assert.equal(report.cleanup.strategy, "versions");
    assert.equal(backend.objects.size, 0);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("COS smoke uses prefix-restricted current object listing when versioning was never enabled", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "what-the-repo-cos-smoke-unconfigured-test-"));
  try {
    await writeFile(join(sourceRoot, "README.md"), "smoke readme\n", "utf8");
    const backend = new MemoryVersionedCos("Unconfigured");
    const runId = "20260825-unconfigured";
    const runPrefix = cosSmokeRunPrefix("what-the-repo", runId);
    const report = await runTencentCosObjectSmoke({
      runId,
      bucket: "test-bucket-1234567890",
      region: "ap-guangzhou",
      runPrefix,
      sourceRoot,
      writer: new MemoryPrefixedStore(backend, runPrefix),
      reader: new MemoryPrefixedStore(backend, runPrefix),
      admin: new TencentCosSmokeAdmin(backend.api(), "test-bucket-1234567890", "ap-guangzhou"),
    });

    assert.equal(report.versioning_status, "Unconfigured");
    assert.equal(report.cleanup.strategy, "objects");
    assert.ok(report.cleanup.entries_removed >= 2);
    assert.ok(backend.calls.getBucket >= 3);
    assert.equal(backend.calls.listObjectVersions, 0);
    assert.equal(backend.objects.size, 0);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("COS smoke refuses a non-empty run prefix without deleting existing objects", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "what-the-repo-cos-smoke-existing-test-"));
  try {
    await writeFile(join(sourceRoot, "README.md"), "smoke readme\n", "utf8");
    const backend = new MemoryVersionedCos();
    const runId = "20260825-existing";
    const runPrefix = cosSmokeRunPrefix("what-the-repo", runId);
    const existingKey = `${runPrefix}/do-not-delete.txt`;
    backend.put(existingKey, Buffer.from("preserve me", "utf8"));

    await assert.rejects(
      runTencentCosObjectSmoke({
        runId,
        bucket: "test-bucket-1234567890",
        region: "ap-guangzhou",
        runPrefix,
        sourceRoot,
        writer: new MemoryPrefixedStore(backend, runPrefix),
        reader: new MemoryPrefixedStore(backend, runPrefix),
        admin: new TencentCosSmokeAdmin(backend.api(), "test-bucket-1234567890", "ap-guangzhou"),
      }),
      /cos_smoke_prefix_not_empty/,
    );
    assert.equal(Buffer.from(backend.get(existingKey) ?? []).toString("utf8"), "preserve me");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
