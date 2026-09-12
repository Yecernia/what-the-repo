import COS from "cos-nodejs-sdk-v5";
import {
  parseSourceSnapshotManifest,
  putSourceSnapshot,
  snapshotObjectDigest,
  verifySourceSnapshotObject,
  type SnapshotObjectStore,
} from "../persistence/snapshot-object-store.js";

export type CosVersioningStatus = "Enabled" | "Suspended" | "Unconfigured";

export interface CosObjectVersionEntry {
  kind: "version" | "delete_marker";
  key: string;
  versionId: string;
  isLatest: boolean;
}

export interface CosSmokeAdmin {
  getVersioningStatus(): Promise<CosVersioningStatus>;
  head(key: string): Promise<{ etag: string | null; versionId: string | null }>;
  listCurrentPrefix(prefix: string): Promise<string[]>;
  listVersionPrefix(prefix: string): Promise<CosObjectVersionEntry[]>;
  restoreDeletedObject(key: string): Promise<{
    deleteMarkerVersionId: string;
    restoredVersionId: string | null;
  }>;
  purgeCurrentPrefix(prefix: string): Promise<number>;
  purgeVersionPrefix(prefix: string): Promise<number>;
}

export interface CosSmokeApi {
  getBucketVersioning(params: COS.GetBucketVersioningParams): Promise<COS.GetBucketVersioningResult>;
  getBucket(params: COS.GetBucketParams): Promise<COS.GetBucketResult>;
  listObjectVersions(params: COS.ListObjectVersionsParams): Promise<COS.ListObjectVersionsResult>;
  headObject(params: COS.HeadObjectParams): Promise<COS.HeadObjectResult>;
  deleteMultipleObject(params: COS.DeleteMultipleObjectParams): Promise<COS.DeleteMultipleObjectResult>;
}

export interface TencentCosSmokeReport {
  ok: true;
  run_id: string;
  bucket: string;
  region: string;
  object_prefix: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  versioning_status: CosVersioningStatus;
  object_round_trip: {
    key: string;
    bytes: number;
    sha256: string;
    etag: string | null;
    version_id: string | null;
    independent_client_read: true;
  };
  source_snapshot: {
    manifest_key: string;
    files: number;
    total_bytes: number;
    independent_client_read: true;
  };
  delete_visibility: {
    missing_after_delete: true;
  };
  version_restore: {
    attempted: boolean;
    restored: boolean;
    delete_marker_version_id: string | null;
    restored_version_id: string | null;
  };
  cleanup: {
    strategy: "objects" | "versions";
    entries_removed: number;
    remaining_entries: 0;
  };
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{7,95}$/;

export function normalizeCosSmokePrefix(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !SAFE_SEGMENT.test(part) || part === "." || part === "..")) {
    throw new Error("cos_smoke_invalid_prefix");
  }
  return parts.join("/");
}

export function cosSmokeRunPrefix(basePrefix: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("cos_smoke_invalid_run_id");
  return `${normalizeCosSmokePrefix(basePrefix)}/smoke/${runId}`;
}

function fullKey(prefix: string, key: string): string {
  return `${normalizeCosSmokePrefix(prefix)}/${normalizeCosSmokePrefix(key)}`;
}

function booleanString(value: unknown): boolean {
  return value === true || value === "true";
}

function deleteFailure(result: COS.DeleteMultipleObjectResult): string | null {
  const failure = result.Error?.[0];
  if (!failure) return null;
  return `${failure.Code ?? "unknown"}:${failure.Key}`;
}

export class TencentCosSmokeAdmin implements CosSmokeAdmin {
  constructor(
    private readonly client: CosSmokeApi,
    private readonly bucket: string,
    private readonly region: string,
  ) {}

  async getVersioningStatus(): Promise<CosVersioningStatus> {
    const result = await this.client.getBucketVersioning({
      Bucket: this.bucket,
      Region: this.region,
    });
    const status = (result.VersioningConfiguration as COS.VersioningConfiguration | undefined)?.Status;
    return status === "Enabled" || status === "Suspended" ? status : "Unconfigured";
  }

  async head(key: string): Promise<{ etag: string | null; versionId: string | null }> {
    const result = await this.client.headObject({
      Bucket: this.bucket,
      Region: this.region,
      Key: key,
    });
    return {
      etag: typeof result.ETag === "string" ? result.ETag : null,
      versionId: typeof result.VersionId === "string" && result.VersionId ? result.VersionId : null,
    };
  }

  async listCurrentPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.getBucket({
        Bucket: this.bucket,
        Region: this.region,
        Prefix: prefix,
        MaxKeys: 1000,
        ...(marker === undefined ? {} : { Marker: marker }),
      });
      for (const object of result.Contents ?? []) {
        if (!object.Key.startsWith(prefix)) throw new Error("cos_smoke_prefix_escape");
        keys.push(object.Key);
      }
      if (!booleanString(result.IsTruncated)) return keys;
      if (!result.NextMarker) throw new Error("cos_smoke_object_listing_stalled");
      marker = result.NextMarker;
    }
    throw new Error("cos_smoke_object_listing_page_limit");
  }

  async listVersionPrefix(prefix: string): Promise<CosObjectVersionEntry[]> {
    const entries: CosObjectVersionEntry[] = [];
    let marker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.listObjectVersions({
        Bucket: this.bucket,
        Region: this.region,
        Prefix: prefix,
        MaxKeys: "1000",
        ...(marker === undefined ? {} : { Marker: marker }),
        ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
      });
      for (const version of result.Versions ?? []) {
        if (!version.Key.startsWith(prefix)) throw new Error("cos_smoke_prefix_escape");
        entries.push({
          kind: "version",
          key: version.Key,
          versionId: version.VersionId,
          isLatest: booleanString(version.IsLatest),
        });
      }
      for (const deleteMarker of result.DeleteMarkers ?? []) {
        if (!deleteMarker.Key.startsWith(prefix)) throw new Error("cos_smoke_prefix_escape");
        entries.push({
          kind: "delete_marker",
          key: deleteMarker.Key,
          versionId: deleteMarker.VersionId,
          isLatest: booleanString(deleteMarker.IsLatest),
        });
      }
      if (!booleanString(result.IsTruncated)) return entries;
      if (!result.NextMarker) throw new Error("cos_smoke_version_listing_stalled");
      marker = result.NextMarker;
      versionIdMarker = result.NextVersionIdMarker;
    }
    throw new Error("cos_smoke_version_listing_page_limit");
  }

  async restoreDeletedObject(key: string): Promise<{
    deleteMarkerVersionId: string;
    restoredVersionId: string | null;
  }> {
    const entries = (await this.listVersionPrefix(key)).filter((entry) => entry.key === key);
    const marker = entries.find((entry) => entry.kind === "delete_marker" && entry.isLatest);
    if (!marker?.versionId) throw new Error("cos_smoke_latest_delete_marker_missing");
    const previous = entries.find((entry) => entry.kind === "version");
    const result = await this.client.deleteMultipleObject({
      Bucket: this.bucket,
      Region: this.region,
      Objects: [{ Key: key, VersionId: marker.versionId }],
      Quiet: false,
    });
    const failure = deleteFailure(result);
    if (failure) throw new Error(`cos_smoke_restore_failed:${failure}`);
    return {
      deleteMarkerVersionId: marker.versionId,
      restoredVersionId: previous?.versionId || null,
    };
  }

  async purgeCurrentPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const keys = await this.listCurrentPrefix(prefix);
      if (!keys.length) return removed;
      for (let offset = 0; offset < keys.length; offset += 1000) {
        const batch = keys.slice(offset, offset + 1000);
        const result = await this.client.deleteMultipleObject({
          Bucket: this.bucket,
          Region: this.region,
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: false,
        });
        const failure = deleteFailure(result);
        if (failure) throw new Error(`cos_smoke_cleanup_failed:${failure}`);
        removed += batch.length;
      }
    }
    throw new Error("cos_smoke_cleanup_pass_limit");
  }

  async purgeVersionPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const entries = await this.listVersionPrefix(prefix);
      if (!entries.length) return removed;
      for (let offset = 0; offset < entries.length; offset += 1000) {
        const batch = entries.slice(offset, offset + 1000);
        const result = await this.client.deleteMultipleObject({
          Bucket: this.bucket,
          Region: this.region,
          Objects: batch.map((entry) => ({
            Key: entry.key,
            ...(entry.versionId ? { VersionId: entry.versionId } : {}),
          })),
          Quiet: false,
        });
        const failure = deleteFailure(result);
        if (failure) throw new Error(`cos_smoke_cleanup_failed:${failure}`);
        removed += batch.length;
      }
    }
    throw new Error("cos_smoke_cleanup_pass_limit");
  }
}

export async function runTencentCosObjectSmoke(input: {
  runId: string;
  bucket: string;
  region: string;
  runPrefix: string;
  sourceRoot: string;
  writer: SnapshotObjectStore;
  reader: SnapshotObjectStore;
  admin: CosSmokeAdmin;
  now?: () => Date;
}): Promise<TencentCosSmokeReport> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const runPrefix = normalizeCosSmokePrefix(input.runPrefix);
  const versioningStatus = await input.admin.getVersioningStatus();
  const cleanupStrategy = versioningStatus === "Unconfigured" ? "objects" : "versions";
  const existing = cleanupStrategy === "objects"
    ? await input.admin.listCurrentPrefix(`${runPrefix}/`)
    : await input.admin.listVersionPrefix(`${runPrefix}/`);
  if (existing.length) throw new Error("cos_smoke_prefix_not_empty");

  let primaryError: unknown;
  let objectResult: TencentCosSmokeReport["object_round_trip"] | undefined;
  let sourceResult: TencentCosSmokeReport["source_snapshot"] | undefined;
  let deleteVisibility: TencentCosSmokeReport["delete_visibility"] | undefined;
  let versionRestore: TencentCosSmokeReport["version_restore"] = {
    attempted: false,
    restored: false,
    delete_marker_version_id: null,
    restored_version_id: null,
  };
  try {
    const body = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      run_id: input.runId,
      marker: "what-the-repo Tencent COS smoke",
    })}\n`, "utf8");
    const sha256 = snapshotObjectDigest(body);
    const key = `objects/round-trip-${sha256}.json`;
    const stored = await input.writer.put(key, body, "application/json");
    if (stored.key !== key || stored.bytes !== body.byteLength || stored.sha256 !== sha256) {
      throw new Error("cos_smoke_write_metadata_mismatch");
    }
    const readBack = await input.reader.get(key);
    if (!readBack || readBack.byteLength !== body.byteLength || snapshotObjectDigest(readBack) !== sha256) {
      throw new Error("cos_smoke_round_trip_mismatch");
    }
    const head = await input.admin.head(fullKey(runPrefix, key));
    objectResult = {
      key,
      bytes: body.byteLength,
      sha256,
      etag: head.etag,
      version_id: head.versionId,
      independent_client_read: true,
    };

    const publicKey = snapshotObjectDigest(Buffer.from(`${runPrefix}:${input.runId}`, "utf8"));
    const snapshotId = `cos-smoke:${input.runId}`;
    const source = await putSourceSnapshot({
      objectStore: input.writer,
      sourceRoot: input.sourceRoot,
      publicKey,
      snapshotId,
      createdAt: startedAt.toISOString(),
      concurrency: 2,
    });
    const manifestBody = await input.reader.get(source.manifestObject.key);
    if (!manifestBody
      || manifestBody.byteLength !== source.manifestObject.bytes
      || snapshotObjectDigest(manifestBody) !== source.manifestObject.sha256) {
      throw new Error("cos_smoke_source_manifest_integrity_mismatch");
    }
    const manifestHead = await input.admin.head(fullKey(runPrefix, source.manifestObject.key));
    if (!manifestHead.etag) throw new Error("cos_smoke_source_manifest_head_missing");
    const parsed = parseSourceSnapshotManifest(
      manifestBody,
      { publicKey, snapshotId },
    );
    for (const file of parsed.files) {
      verifySourceSnapshotObject(await input.reader.get(file.key), file);
    }
    sourceResult = {
      manifest_key: source.manifestObject.key,
      files: parsed.files.length,
      total_bytes: parsed.total_bytes,
      independent_client_read: true,
    };

    await input.writer.delete(key);
    if (await input.reader.get(key)) throw new Error("cos_smoke_delete_not_visible");
    deleteVisibility = { missing_after_delete: true };

    if (versioningStatus === "Enabled") {
      const restored = await input.admin.restoreDeletedObject(fullKey(runPrefix, key));
      const restoredBody = await input.reader.get(key);
      if (!restoredBody
        || restoredBody.byteLength !== body.byteLength
        || snapshotObjectDigest(restoredBody) !== sha256) {
        throw new Error("cos_smoke_version_restore_mismatch");
      }
      versionRestore = {
        attempted: true,
        restored: true,
        delete_marker_version_id: restored.deleteMarkerVersionId,
        restored_version_id: restored.restoredVersionId,
      };
      await input.writer.delete(key);
    }
  } catch (error) {
    primaryError = error;
  }

  let removed = 0;
  let cleanupError: unknown;
  try {
    removed = cleanupStrategy === "objects"
      ? await input.admin.purgeCurrentPrefix(`${runPrefix}/`)
      : await input.admin.purgeVersionPrefix(`${runPrefix}/`);
    const remaining = cleanupStrategy === "objects"
      ? await input.admin.listCurrentPrefix(`${runPrefix}/`)
      : await input.admin.listVersionPrefix(`${runPrefix}/`);
    if (remaining.length) throw new Error("cos_smoke_cleanup_incomplete");
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "cos_smoke_failed_and_cleanup_failed");
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!objectResult || !sourceResult || !deleteVisibility) throw new Error("cos_smoke_result_incomplete");

  const finishedAt = now();
  return {
    ok: true,
    run_id: input.runId,
    bucket: input.bucket,
    region: input.region,
    object_prefix: runPrefix,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_seconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000 * 1000) / 1000,
    versioning_status: versioningStatus,
    object_round_trip: objectResult,
    source_snapshot: sourceResult,
    delete_visibility: deleteVisibility,
    version_restore: versionRestore,
    cleanup: {
      strategy: cleanupStrategy,
      entries_removed: removed,
      remaining_entries: 0,
    },
  };
}
