import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import COS from "cos-nodejs-sdk-v5";

export interface StoredObject {
  key: string;
  bytes: number;
  sha256: string;
}

export interface SnapshotObjectStore {
  readonly kind: "local" | "cos";
  put(key: string, body: Uint8Array, contentType?: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Irreversible reclamation of an already-unreferenced object, including retained versions. */
  purge?(key: string): Promise<void>;
  inventory?(): Promise<Array<{ key: string; bytes: number }>>;
}

export function snapshotObjectDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function safeKey(value: string): string {
  const key = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid_object_key");
  }
  return key;
}

export class LocalSnapshotObjectStore implements SnapshotObjectStore {
  readonly kind = "local" as const;

  constructor(private readonly root: string) {}

  async inventory(): Promise<Array<{key:string;bytes:number}>> {
    const result:Array<{key:string;bytes:number}>=[];
    const walk=async(directory:string):Promise<void>=>{
      for(const entry of await readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
        const path=join(directory,entry.name);if(entry.isSymbolicLink())continue;
        if(entry.isDirectory())await walk(path);else if(entry.isFile())result.push({key:relative(this.root,path).replaceAll('\\','/'),bytes:(await stat(path)).size});
      }
    };
    await walk(join(this.root,'public-repository-snapshots'));return result;
  }

  private path(key: string): string {
    const normalizedRoot = resolve(this.root);
    const target = resolve(normalizedRoot, safeKey(key));
    const rel = relative(normalizedRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("invalid_object_key");
    return target;
  }

  async put(key: string, body: Uint8Array): Promise<StoredObject> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key: safeKey(key), bytes: body.byteLength, sha256: snapshotObjectDigest(body) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export interface TencentCosObjectStoreOptions {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  securityToken?: string;
  prefix?: string;
  domain?: string;
}

export function tencentCosClientOptions(options: TencentCosObjectStoreOptions): COS.COSOptions {
  return {
    SecretId: options.secretId,
    SecretKey: options.secretKey,
    SecurityToken: options.securityToken,
    Domain: options.domain,
    Timeout: 30_000,
  };
}

/**
 * Thin COS adapter. The product only depends on SnapshotObjectStore, so local
 * development and tests never need COS credentials or network access.
 */
export class TencentCosObjectStore implements SnapshotObjectStore {
  readonly kind = "cos" as const;
  private readonly client: COS;
  private readonly prefix: string;
  private versioning?:{at:number;enabled:boolean};

  constructor(private readonly options: TencentCosObjectStoreOptions) {
    this.client = new COS(tencentCosClientOptions(options));
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  }

  private key(value: string): string {
    const clean = safeKey(value);
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  async inventory(): Promise<Array<{key:string;bytes:number}>> {
    const rows=new Map<string,number>();let marker='';
    if(await this.hasVersions()){
      for(const object of await this.objectVersions(this.prefix?this.prefix+'/':'')){
        const key=this.prefix?object.key.slice(this.prefix.length+1):object.key;
        rows.set(key,(rows.get(key)??0)+object.bytes);
      }
      return [...rows].map(([key,bytes])=>({key,bytes}));
    }
    for(let page=0;page<10_000;page++) {
      const response=await this.client.getBucket({Bucket:this.options.bucket,Region:this.options.region,Prefix:this.prefix?this.prefix+'/':'',Marker:marker,MaxKeys:1000});
      for(const object of response.Contents??[]){
        const bytes=Number(object.Size);
        if(!Number.isFinite(bytes)||bytes<0||this.prefix&&!object.Key.startsWith(this.prefix+'/'))throw new Error('object_inventory_invalid');
        rows.set(this.prefix?object.Key.slice(this.prefix.length+1):object.Key,bytes);
      }
      if(String(response.IsTruncated)!=='true')return [...rows].map(([key,bytes])=>({key,bytes}));
      const next=response.NextMarker;if(!next||next===marker)throw new Error('object_inventory_incomplete');marker=next;
    }
    throw new Error('object_inventory_too_large');
  }

  private async hasVersions():Promise<boolean>{
    if(this.versioning&&Date.now()-this.versioning.at<60_000)return this.versioning.enabled;
    const result=await this.client.getBucketVersioning({Bucket:this.options.bucket,Region:this.options.region});
    const status=result.VersioningConfiguration?.Status;
    const enabled=status==='Enabled'||status==='Suspended';this.versioning={at:Date.now(),enabled};return enabled;
  }
  private async objectVersions(prefix:string):Promise<Array<{key:string;version:string;bytes:number}>>{
    const rows=new Map<string,{key:string;version:string;bytes:number}>();let marker='',versionMarker='';
    for(let page=0;page<10_000;page++){
      const response=await this.client.listObjectVersions({Bucket:this.options.bucket,Region:this.options.region,Prefix:prefix,Marker:marker,VersionIdMarker:versionMarker,MaxKeys:'1000'});
      for(const item of [...(response.Versions??[]),...(response.DeleteMarkers??[])]){
        if(!item.Key.startsWith(prefix))throw new Error('object_inventory_out_of_scope');
        const version=String(item.VersionId??'null'),bytes='Size' in item?Number(item.Size):0;
        if(!Number.isFinite(bytes)||bytes<0)throw new Error('object_inventory_invalid_size');
        rows.set(item.Key+'\0'+version,{key:item.Key,version,bytes});
      }
      if(String(response.IsTruncated)!=='true')return [...rows.values()];
      const next=response.NextMarker??'',nextVersion=response.NextVersionIdMarker??'';
      if(!next||(next===marker&&nextVersion===versionMarker))throw new Error('object_inventory_incomplete');
      marker=next;versionMarker=nextVersion;
    }
    throw new Error('object_inventory_too_large');
  }
  async purge(key:string):Promise<void>{
    if(!await this.hasVersions())return this.delete(key);
    const target=this.key(key);
    const objects=(await this.objectVersions(target)).filter(object=>object.key===target).map(object=>({Key:target,VersionId:object.version}));
    for(let offset=0;offset<objects.length;offset+=1000){
      const result=await this.client.deleteMultipleObject({Bucket:this.options.bucket,Region:this.options.region,Objects:objects.slice(offset,offset+1000),Quiet:false});
      if(result.Error?.length)throw new Error('storage_delete_incomplete');
    }
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<StoredObject> {
    const data = Buffer.from(body);
    await this.client.putObject({
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: this.key(key),
      Body: data,
      ContentLength: data.byteLength,
      ContentType: contentType,
      ACL: "private",
    });
    return { key: safeKey(key), bytes: data.byteLength, sha256: snapshotObjectDigest(data) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.getObject({
        Bucket: this.options.bucket,
        Region: this.options.region,
        Key: this.key(key),
      });
      return result.Body ?? null;
    } catch (error) {
      const status = Number((error as { statusCode?: unknown }).statusCode ?? 0);
      if (status === 404 || (error as { code?: unknown }).code === "NoSuchKey") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject({
      Bucket: this.options.bucket,
      Region: this.options.region,
      Key: this.key(key),
    });
  }
}

export interface SnapshotManifest {
  schema_version: 1;
  public_snapshot_key: string;
  snapshot_id: string;
  objects: Array<{
    kind: "view" | "analysis";
    key: string;
    bytes: number;
    sha256: string;
  }>;
  query_directory: {
    digest: string;
    nodes: number;
    edges: number;
    evidence: number;
    layers: number;
    value_points: number;
  };
  created_at: string;
}

export interface SourceSnapshotManifestFile {
  path: string;
  key: string;
  bytes: number;
  sha256: string;
}

export interface SourceSnapshotManifest {
  schema_version: 1;
  public_snapshot_key: string;
  snapshot_id: string;
  files: SourceSnapshotManifestFile[];
  total_bytes: number;
  created_at: string;
}

export interface StoredSourceSnapshot {
  manifest: SourceSnapshotManifest;
  manifestObject: StoredObject;
}

const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("snapshot_manifest_invalid");
  }
  return value as Record<string, unknown>;
}

function sourceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source_snapshot_manifest_invalid");
  }
  return value as Record<string, unknown>;
}

export function parseSnapshotManifest(
  body: Uint8Array | null,
  expected: { publicKey: string; snapshotId: string },
): SnapshotManifest {
  if (!body) throw new Error("snapshot_manifest_missing");
  const row = record(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
  if (row.schema_version !== 1
    || row.public_snapshot_key !== expected.publicKey
    || row.snapshot_id !== expected.snapshotId
    || !Array.isArray(row.objects)
    || row.objects.length !== 2) {
    throw new Error("snapshot_manifest_invalid");
  }
  const kinds = new Set<string>();
  const objects = row.objects.map((value) => {
    const item = record(value);
    if ((item.kind !== "view" && item.kind !== "analysis")
      || typeof item.key !== "string"
      || !Number.isSafeInteger(item.bytes)
      || Number(item.bytes) < 0
      || typeof item.sha256 !== "string"
      || !SHA256.test(item.sha256)
      || kinds.has(item.kind)) {
      throw new Error("snapshot_manifest_invalid");
    }
    const kind: "view" | "analysis" = item.kind;
    kinds.add(kind);
    return {
      kind,
      key: safeKey(item.key),
      bytes: Number(item.bytes),
      sha256: item.sha256,
    };
  });
  if (!kinds.has("view") || !kinds.has("analysis")) throw new Error("snapshot_manifest_invalid");
  const query = record(row.query_directory);
  if (typeof query.digest !== "string" || !SHA256.test(query.digest)) {
    throw new Error("snapshot_manifest_invalid");
  }
  for (const name of ["nodes", "edges", "evidence", "layers", "value_points"] as const) {
    if (!Number.isSafeInteger(query[name]) || Number(query[name]) < 0) {
      throw new Error("snapshot_manifest_invalid");
    }
  }
  if (typeof row.created_at !== "string" || Number.isNaN(Date.parse(row.created_at))) {
    throw new Error("snapshot_manifest_invalid");
  }
  return {
    schema_version: 1,
    public_snapshot_key: expected.publicKey,
    snapshot_id: expected.snapshotId,
    objects,
    query_directory: {
      digest: query.digest,
      nodes: Number(query.nodes),
      edges: Number(query.edges),
      evidence: Number(query.evidence),
      layers: Number(query.layers),
      value_points: Number(query.value_points),
    },
    created_at: row.created_at,
  };
}

export function normalizeSourceSnapshotPath(value: string): string {
  const replaced = value.replaceAll("\\", "/");
  const normalized = posix.normalize(replaced);
  const parts = normalized.split("/");
  if (!replaced
    || replaced.includes("\0")
    || replaced.startsWith("/")
    || normalized !== replaced
    || normalized === "."
    || parts.some((part) => !part || part === "." || part === "..")
    || /^[a-z]:$/iu.test(parts[0] ?? "")) {
    throw new Error("invalid_source_path");
  }
  return normalized;
}

export function parseSourceSnapshotManifest(
  body: Uint8Array | null,
  expected: { publicKey: string; snapshotId: string },
): SourceSnapshotManifest {
  if (!body) throw new Error("source_snapshot_manifest_missing");
  let row: Record<string, unknown>;
  try {
    row = sourceRecord(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
  } catch {
    throw new Error("source_snapshot_manifest_invalid");
  }
  if (row.schema_version !== 1
    || row.public_snapshot_key !== expected.publicKey
    || row.snapshot_id !== expected.snapshotId
    || !Array.isArray(row.files)
    || !Number.isSafeInteger(row.total_bytes)
    || Number(row.total_bytes) < 0
    || typeof row.created_at !== "string"
    || Number.isNaN(Date.parse(row.created_at))) {
    throw new Error("source_snapshot_manifest_invalid");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = row.files.map((value) => {
    const item = sourceRecord(value);
    if (typeof item.path !== "string"
      || typeof item.key !== "string"
      || !Number.isSafeInteger(item.bytes)
      || Number(item.bytes) < 0
      || typeof item.sha256 !== "string"
      || !SHA256.test(item.sha256)) {
      throw new Error("source_snapshot_manifest_invalid");
    }
    const path = normalizeSourceSnapshotPath(item.path);
    if (paths.has(path)) throw new Error("source_snapshot_manifest_invalid");
    paths.add(path);
    const bytes = Number(item.bytes);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes)) throw new Error("source_snapshot_manifest_invalid");
    return {
      path,
      key: safeKey(item.key),
      bytes,
      sha256: item.sha256,
    };
  });
  if (totalBytes !== Number(row.total_bytes)) throw new Error("source_snapshot_manifest_invalid");
  return {
    schema_version: 1,
    public_snapshot_key: expected.publicKey,
    snapshot_id: expected.snapshotId,
    files,
    total_bytes: totalBytes,
    created_at: row.created_at,
  };
}

async function sourceFiles(root: string): Promise<Array<{ path: string; absolute: string }>> {
  const result: Array<{ path: string; absolute: string }> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!prefix && entry.name === ".snapshot-meta.json") continue;
      const path = normalizeSourceSnapshotPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) result.push({ path, absolute });
      else throw new Error("source_snapshot_unsupported_entry");
    }
  };
  await visit(root, "");
  return result;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  const run = async (): Promise<void> => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try { result[index] = await operation(values[index] as T); }
      catch (error) { failed = true; throw error; }
    }
  };
  const settled = await Promise.allSettled(Array.from(
    { length: Math.min(Math.max(1, Math.floor(concurrency)), Math.max(1, values.length)) },
    run,
  ));
  const failure = settled.find(row => row.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return result;
}

export async function putSourceSnapshot(input: {
  objectStore: SnapshotObjectStore;
  sourceRoot: string;
  publicKey: string;
  snapshotId: string;
  createdAt?: string;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<StoredSourceSnapshot> {
  input.signal?.throwIfAborted();
  const files = await sourceFiles(input.sourceRoot);
  const descriptors = await mapWithConcurrency(files, input.concurrency ?? 8, async (file) => {
    input.signal?.throwIfAborted();
    const body = await readFile(file.absolute);
    input.signal?.throwIfAborted();
    const sha256 = snapshotObjectDigest(body);
    const key = `public-repository-snapshots/${input.publicKey}/source/${sha256}`;
    const stored = await input.objectStore.put(key, body, "application/octet-stream");
    input.signal?.throwIfAborted();
    if (stored.key !== key || stored.bytes !== body.byteLength || stored.sha256 !== sha256) {
      throw new Error("source_snapshot_object_write_mismatch");
    }
    return { path: file.path, key: stored.key, bytes: stored.bytes, sha256: stored.sha256 };
  });
  const manifest: SourceSnapshotManifest = {
    schema_version: 1,
    public_snapshot_key: input.publicKey,
    snapshot_id: input.snapshotId,
    files: descriptors,
    total_bytes: descriptors.reduce((total, file) => total + file.bytes, 0),
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  const body = jsonBytes(manifest);
  input.signal?.throwIfAborted();
  const key = `public-repository-snapshots/${input.publicKey}/source-manifest-${snapshotObjectDigest(body)}.json`;
  const manifestObject = await input.objectStore.put(key, body, "application/json");
  if (manifestObject.key !== key
    || manifestObject.bytes !== body.byteLength
    || manifestObject.sha256 !== snapshotObjectDigest(body)) {
    throw new Error("source_snapshot_manifest_write_mismatch");
  }
  return { manifest, manifestObject };
}

function verifiedObjectBody(
  body: Uint8Array | null,
  expected: { bytes: number; sha256: string },
  errorPrefix: "snapshot_object" | "source_snapshot_object",
): Uint8Array {
  if (!body) throw new Error(`${errorPrefix}_missing`);
  if (body.byteLength !== expected.bytes || snapshotObjectDigest(body) !== expected.sha256) {
    throw new Error(`${errorPrefix}_integrity_mismatch`);
  }
  return body;
}

export function verifySnapshotObject<T>(
  body: Uint8Array | null,
  expected: { bytes: number; sha256: string },
): T {
  return JSON.parse(Buffer.from(verifiedObjectBody(body, expected, "snapshot_object")).toString("utf8")) as T;
}

export function verifySourceSnapshotObject(
  body: Uint8Array | null,
  expected: { bytes: number; sha256: string },
): Uint8Array {
  return verifiedObjectBody(body, expected, "source_snapshot_object");
}

export function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function parseJsonObject<T>(body: Uint8Array | null): T | null {
  if (!body) return null;
  return JSON.parse(Buffer.from(body).toString("utf8")) as T;
}
