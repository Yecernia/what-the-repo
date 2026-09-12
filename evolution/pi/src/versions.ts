import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CandidateArtifact,
  CheckResult,
  EvolutionTask,
  OperationLedger,
  ReviewDecision,
  SkillCandidate,
  SkillVersionBinding,
} from "./contracts.js";
import { assertTrustedPublicationResult, CheckRegistry } from "./checks.js";
import { reviewedCandidateDigest, sha256, stableJson } from "./integrity.js";
import { isPortableIdentifier, portableRelativePath } from "./path-safety.js";
import { validateCandidate, validateDecision, validateLedger, validateTask } from "./state-store.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface VersionManifest {
  skillId: string;
  currentVersion: string;
  revision: number;
  currentSnapshotDigest: string;
  history: Array<{
    revision: number;
    version: string;
    snapshotDigest: string;
    taskId: string;
    action: "bootstrap" | "publish" | "rollback";
    at: string;
  }>;
}

interface VersionSnapshot {
  skillId: string;
  version: string;
  taskId: string;
  kind: "baseline";
  createdAt: string;
  snapshotDigest: string;
  artifacts: CandidateArtifact[];
}

interface VersionExpectation {
  version: string;
  revision: number;
  snapshotDigest: string;
}

export interface InterruptedRegistryOperation {
  taskId: string;
  action: "publish" | "rollback";
  before: VersionExpectation;
  after: VersionExpectation;
}

export interface RegistryRecoveryResult {
  outcome: "committed" | "not_committed";
  binding: SkillVersionBinding;
  quarantinedEntries: number;
}

export class VersionConflictError extends Error {
  override readonly name = "VersionConflictError";
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}: expected string`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`invalid ${label}: expected SHA-256 digest`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`invalid ${label}: expected positive integer`);
  }
  return value as number;
}

function validateManifest(value: unknown, expectedSkillId?: string): VersionManifest {
  const row = object(value, "version manifest");
  const skillId = safeId(text(row.skillId, "version manifest.skillId"));
  const currentVersion = safeId(text(row.currentVersion, "version manifest.currentVersion"));
  const revision = positiveInteger(row.revision, "version manifest.revision");
  const currentSnapshotDigest = digest(
    row.currentSnapshotDigest,
    "version manifest.currentSnapshotDigest",
  );
  if (expectedSkillId !== undefined && skillId !== expectedSkillId) {
    throw new Error("version manifest skill does not match the requested registry");
  }
  if (!Array.isArray(row.history) || row.history.length !== revision) {
    throw new Error("invalid version manifest.history");
  }
  const history: VersionManifest["history"] = row.history.map((raw, index) => {
    const item = object(raw, `version manifest.history[${index}]`);
    const itemRevision = positiveInteger(
      item.revision,
      `version manifest.history[${index}].revision`,
    );
    if (itemRevision !== index + 1) {
      throw new Error(`invalid version manifest.history[${index}].revision`);
    }
    const version = safeId(text(item.version, `version manifest.history[${index}].version`));
    const snapshotDigest = digest(
      item.snapshotDigest,
      `version manifest.history[${index}].snapshotDigest`,
    );
    const taskId = safeId(text(item.taskId, `version manifest.history[${index}].taskId`));
    const action = item.action;
    if (action !== "bootstrap" && action !== "publish" && action !== "rollback") {
      throw new Error(`invalid version manifest.history[${index}].action`);
    }
    if (index === 0 && action !== "bootstrap") {
      throw new Error("version manifest history must begin with bootstrap");
    }
    const at = text(item.at, `version manifest.history[${index}].at`);
    if (Number.isNaN(Date.parse(at))) {
      throw new Error(`invalid version manifest.history[${index}].at`);
    }
    return { revision: itemRevision, version, snapshotDigest, taskId, action, at };
  });
  const latest = history.at(-1);
  if (latest?.revision !== revision || latest.version !== currentVersion ||
    latest.snapshotDigest !== currentSnapshotDigest) {
    throw new Error("version manifest current binding does not match its history");
  }
  return { skillId, currentVersion, revision, currentSnapshotDigest, history };
}

function validateArtifacts(value: unknown, label: string): CandidateArtifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`invalid ${label}`);
  }
  const paths = new Set<string>();
  return value.map((raw, index) => {
    const row = object(raw, `${label}[${index}]`);
    const path = safeRelativePath(text(row.path, `${label}[${index}].path`));
    if (paths.has(path)) throw new Error(`invalid ${label}: duplicate path`);
    paths.add(path);
    const content = typeof row.content === "string" ? row.content : (() => {
      throw new Error(`invalid ${label}[${index}].content`);
    })();
    const artifactDigest = digest(row.sha256, `${label}[${index}].sha256`);
    const bytes = row.bytes;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 ||
      artifactDigest !== sha256(content) || bytes !== Buffer.byteLength(content, "utf8")) {
      throw new Error(`invalid ${label}[${index}] digest or size`);
    }
    return { path, content, sha256: artifactDigest, bytes: bytes as number };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function artifactSnapshotDigest(artifacts: CandidateArtifact[]): string {
  return sha256(stableJson(validateArtifacts(artifacts, "version artifacts")));
}

function validateSnapshot(value: unknown, expectedSkillId: string, expectedVersion: string): VersionSnapshot {
  const row = object(value, "version snapshot");
  const skillId = safeId(text(row.skillId, "version snapshot.skillId"));
  const version = safeId(text(row.version, "version snapshot.version"));
  const taskId = safeId(text(row.taskId, "version snapshot.taskId"));
  if (skillId !== expectedSkillId || version !== expectedVersion || row.kind !== "baseline") {
    throw new Error("stored baseline snapshot does not match the requested version");
  }
  const createdAt = text(row.createdAt, "version snapshot.createdAt");
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("invalid version snapshot.createdAt");
  const artifacts = validateArtifacts(row.artifacts, "version snapshot.artifacts");
  const snapshotDigest = digest(row.snapshotDigest, "version snapshot.snapshotDigest");
  if (snapshotDigest !== artifactSnapshotDigest(artifacts)) {
    throw new Error("stored baseline snapshot digest does not match its artifacts");
  }
  return { skillId, version, taskId, kind: "baseline", createdAt, snapshotDigest, artifacts };
}

export function materializedCandidateArtifacts(candidate: SkillCandidate): CandidateArtifact[] {
  const artifacts = new Map(candidate.baseArtifacts.map((artifact) => [artifact.path, structuredClone(artifact)]));
  for (const artifact of candidate.artifacts) {
    if (!artifacts.has(artifact.path)) throw new Error("candidate changes a file outside its base snapshot");
    artifacts.set(artifact.path, structuredClone(artifact));
  }
  return validateArtifacts([...artifacts.values()], "materialized candidate artifacts");
}

function parsePersistedJson(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid persisted JSON: ${label}`);
    throw error;
  }
}

function safeId(value: string): string {
  if (!isPortableIdentifier(value, SAFE_ID)) throw new Error("invalid version identifier");
  return value;
}

function safeRelativePath(raw: string): string {
  try {
    return portableRelativePath(raw);
  } catch {
    throw new Error("invalid candidate artifact path");
  }
}

function ensureInside(root: string, candidate: string): string {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("version path escapes registry root");
  return candidateResolved;
}

function sameVersionRoot(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function manifestMatches(manifest: VersionManifest, expected: VersionExpectation): boolean {
  return manifest.currentVersion === expected.version &&
    manifest.revision === expected.revision &&
    manifest.currentSnapshotDigest === expected.snapshotDigest;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class SkillVersionRegistry {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private skillRoot(registryRootReal: string, skillId: string): string {
    return ensureInside(registryRootReal, join(registryRootReal, safeId(skillId)));
  }

  private async preparedRegistryRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(this.root);
  }

  private async checkedSkillRoot(registryRootReal: string, skillId: string): Promise<string> {
    const skillRoot = this.skillRoot(registryRootReal, skillId);
    const skillRootReal = await realpath(skillRoot);
    ensureInside(registryRootReal, skillRootReal);
    if (!sameVersionRoot(skillRoot, skillRootReal)) throw new Error("skill directory redirected through a link");
    return skillRootReal;
  }

  private async regularFileInside(root: string, path: string): Promise<string> {
    const actualRoot = await realpath(root);
    const actualPath = await realpath(ensureInside(actualRoot, path));
    ensureInside(actualRoot, actualPath);
    const handle = await open(actualPath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("version path is not a regular file");
    } finally {
      await handle.close();
    }
    return actualPath;
  }

  private async claimRecoveryLock(
    registryRootReal: string,
    skillId: string,
  ): Promise<{ lockPath: string; staleLockPath?: string }> {
    const lockPath = ensureInside(registryRootReal, join(registryRootReal, `.${skillId}.registry.lock`));
    const writeOwnedLock = async (): Promise<void> => {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          purpose: "explicit_recovery",
        })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    try {
      await writeOwnedLock();
      return { lockPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const lockStat = await lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 4 * 1024) {
      throw new Error("registry lock is not a bounded regular file");
    }
    const metadata = object(parsePersistedJson(await readFile(lockPath, "utf8"), lockPath), "registry lock");
    const pid = positiveInteger(metadata.pid, "registry lock.pid");
    const createdAt = text(metadata.createdAt, "registry lock.createdAt");
    if (Number.isNaN(Date.parse(createdAt))) throw new Error("invalid registry lock.createdAt");
    if (processIsAlive(pid)) throw new Error("skill registry operation is still active");

    const staleLockPath = ensureInside(
      registryRootReal,
      join(registryRootReal, `.${skillId}.${randomUUID()}.stale-lock`),
    );
    await rename(lockPath, staleLockPath);
    try {
      await writeOwnedLock();
    } catch (error) {
      await rename(staleLockPath, lockPath).catch(() => undefined);
      throw error;
    }
    return { lockPath, staleLockPath };
  }

  private async quarantineInterruptedEntries(
    skillRootReal: string,
    operation: InterruptedRegistryOperation,
    manifest: VersionManifest,
  ): Promise<number> {
    if (operation.action !== "publish") return 0;
    const quarantineRoot = ensureInside(skillRootReal, join(skillRootReal, ".recovery-quarantine"));
    await mkdir(quarantineRoot, { recursive: true });
    const quarantineRootReal = await realpath(quarantineRoot);
    ensureInside(skillRootReal, quarantineRootReal);
    if (!sameVersionRoot(quarantineRoot, quarantineRootReal)) {
      throw new Error("registry recovery quarantine was redirected through a link");
    }

    let quarantined = 0;
    for (const entry of await readdir(skillRootReal, { withFileTypes: true })) {
      const isFinalVersion = entry.name === operation.after.version;
      const isStaging = /^\.candidate\.[0-9a-f-]{36}\.staging$/i.test(entry.name);
      if (!isFinalVersion && !isStaging) continue;
      if (isFinalVersion && manifest.history.some((item) => item.version === entry.name)) {
        throw new Error("interrupted version already belongs to registry history and requires manual audit");
      }
      const source = ensureInside(skillRootReal, join(skillRootReal, entry.name));
      const metadata = await lstat(source);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("interrupted registry entry is not a regular directory");
      }
      if (isStaging) {
        let candidate: SkillCandidate;
        try {
          candidate = await this.verifyCandidateRoot(
            skillRootReal,
            await realpath(source),
            operation.after.version === operation.before.version ? "" : manifest.skillId,
            operation.after.version,
          );
        } catch {
          continue;
        }
        if (candidate.taskId !== operation.taskId ||
          artifactSnapshotDigest(materializedCandidateArtifacts(candidate)) !== operation.after.snapshotDigest) {
          continue;
        }
      }
      const destination = ensureInside(
        quarantineRootReal,
        join(quarantineRootReal, `${operation.taskId}.${entry.name}.${randomUUID()}`),
      );
      await rename(source, destination);
      quarantined += 1;
    }
    return quarantined;
  }

  private async withSkillLock<T>(
    skillId: string,
    action: (registryRootReal: string, skillRoot: string) => Promise<T>,
  ): Promise<T> {
    const registryRootReal = await this.preparedRegistryRoot();
    const normalizedSkillId = safeId(skillId);
    const lockPath = ensureInside(registryRootReal, join(registryRootReal, `.${normalizedSkillId}.registry.lock`));
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("skill registry is busy or requires manual recovery");
      }
      throw error;
    }
    try {
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await lock.sync();
      return await action(registryRootReal, this.skillRoot(registryRootReal, normalizedSkillId));
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async readManifest(skillRootReal: string, skillId: string): Promise<VersionManifest> {
    const path = await this.regularFileInside(skillRootReal, join(skillRootReal, "current.json"));
    return validateManifest(parsePersistedJson(await readFile(path, "utf8"), path), skillId);
  }

  private async checkedVersionRoot(skillRootReal: string, version: string): Promise<string> {
    const versionRoot = ensureInside(skillRootReal, join(skillRootReal, safeId(version)));
    const versionRootReal = await realpath(versionRoot);
    ensureInside(skillRootReal, versionRootReal);
    if (!sameVersionRoot(versionRoot, versionRootReal)) throw new Error("version directory redirected through a link");
    return versionRootReal;
  }

  private async verifyCandidateRoot(
    skillRootReal: string,
    versionRootReal: string,
    skillId: string,
    version: string,
  ): Promise<SkillCandidate> {
    ensureInside(skillRootReal, versionRootReal);
    const candidatePath = await this.regularFileInside(versionRootReal, join(versionRootReal, "candidate.json"));
    const candidate = validateCandidate(parsePersistedJson(await readFile(candidatePath, "utf8"), candidatePath));
    if (candidate.status !== "approved" || candidate.skillId !== skillId ||
      candidate.candidateVersion !== version || candidate.artifacts.length === 0) {
      throw new Error("stored candidate manifest does not match the requested version");
    }
    const reviewPath = await this.regularFileInside(versionRootReal, join(versionRootReal, "review.json"));
    const review = validateDecision(parsePersistedJson(await readFile(reviewPath, "utf8"), reviewPath));
    if (review.decision !== "approve" || review.taskId !== candidate.taskId ||
      review.baseRevision !== candidate.baseRevision ||
      review.baseSnapshotDigest !== candidate.baseSnapshotDigest ||
      review.candidateDigest !== reviewedCandidateDigest(candidate)) {
      throw new Error("stored review decision does not match the published candidate");
    }
    for (const artifact of materializedCandidateArtifacts(candidate)) {
      const path = await this.regularFileInside(
        versionRootReal,
        join(versionRootReal, safeRelativePath(artifact.path)),
      );
      const content = await readFile(path, "utf8");
      if (content !== artifact.content || sha256(content) !== artifact.sha256 ||
        Buffer.byteLength(content, "utf8") !== artifact.bytes) {
        throw new Error("stored version artifact does not match its manifest");
      }
    }
    return candidate;
  }

  private async verifyStoredVersion(skillRootReal: string, skillId: string, version: string): Promise<SkillCandidate> {
    return this.verifyCandidateRoot(
      skillRootReal,
      await this.checkedVersionRoot(skillRootReal, version),
      skillId,
      version,
    );
  }

  private async verifyBaselineRoot(
    skillRootReal: string,
    versionRootReal: string,
    skillId: string,
    version: string,
  ): Promise<VersionSnapshot> {
    ensureInside(skillRootReal, versionRootReal);
    const snapshotPath = await this.regularFileInside(versionRootReal, join(versionRootReal, "baseline.json"));
    const snapshot = validateSnapshot(
      parsePersistedJson(await readFile(snapshotPath, "utf8"), snapshotPath),
      skillId,
      version,
    );
    for (const artifact of snapshot.artifacts) {
      const path = await this.regularFileInside(
        versionRootReal,
        join(versionRootReal, safeRelativePath(artifact.path)),
      );
      const content = await readFile(path, "utf8");
      if (content !== artifact.content || sha256(content) !== artifact.sha256 ||
        Buffer.byteLength(content, "utf8") !== artifact.bytes) {
        throw new Error("stored baseline artifact does not match its manifest");
      }
    }
    return snapshot;
  }

  private async verifyStoredArtifacts(
    skillRootReal: string,
    skillId: string,
    version: string,
  ): Promise<CandidateArtifact[]> {
    try {
      const candidate = await this.verifyStoredVersion(skillRootReal, skillId, version);
      return materializedCandidateArtifacts(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const versionRootReal = await this.checkedVersionRoot(skillRootReal, version);
    return (await this.verifyBaselineRoot(skillRootReal, versionRootReal, skillId, version)).artifacts;
  }

  private async writeVersionArtifacts(
    skillRootReal: string,
    versionRoot: string,
    artifacts: CandidateArtifact[],
  ): Promise<void> {
    const versionRootReal = await realpath(versionRoot);
    ensureInside(skillRootReal, versionRootReal);
    if (!sameVersionRoot(versionRoot, versionRootReal)) throw new Error("version directory redirected through a link");
    for (const artifact of artifacts) {
      const path = ensureInside(versionRootReal, join(versionRootReal, safeRelativePath(artifact.path)));
      await mkdir(dirname(path), { recursive: true });
      const parentReal = await realpath(dirname(path));
      ensureInside(versionRootReal, parentReal);
      await writeFile(path, artifact.content, { encoding: "utf8", flag: "wx" });
      await this.regularFileInside(versionRootReal, path);
    }
  }

  async bootstrap(
    skillId: string,
    version: string,
    bootstrapId: string,
    artifacts: CandidateArtifact[],
  ): Promise<SkillVersionBinding> {
    const normalizedSkillId = safeId(skillId);
    const normalizedVersion = safeId(version);
    const normalizedBootstrapId = safeId(bootstrapId);
    const baselineArtifacts = validateArtifacts(artifacts, "bootstrap artifacts");
    const snapshotDigest = artifactSnapshotDigest(baselineArtifacts);
    return this.withSkillLock(normalizedSkillId, async (registryRootReal, skillRoot) => {
      if (await pathExists(skillRoot)) {
        await this.checkedSkillRoot(registryRootReal, normalizedSkillId);
        throw new VersionConflictError("Skill registry has already been bootstrapped");
      }
      const stagingRoot = ensureInside(
        registryRootReal,
        join(registryRootReal, `.${normalizedSkillId}.${randomUUID()}.staging`),
      );
      await mkdir(stagingRoot, { recursive: false });
      try {
        const stagingRootReal = await realpath(stagingRoot);
        const versionRoot = join(stagingRootReal, normalizedVersion);
        await mkdir(versionRoot, { recursive: false });
        await this.writeVersionArtifacts(stagingRootReal, versionRoot, baselineArtifacts);
        const createdAt = new Date().toISOString();
        const snapshot: VersionSnapshot = {
          skillId: normalizedSkillId,
          version: normalizedVersion,
          taskId: normalizedBootstrapId,
          kind: "baseline",
          createdAt,
          snapshotDigest,
          artifacts: baselineArtifacts,
        };
        await writeAtomic(join(versionRoot, "baseline.json"), snapshot);
        await this.verifyBaselineRoot(
          stagingRootReal,
          await realpath(versionRoot),
          normalizedSkillId,
          normalizedVersion,
        );
        const manifest: VersionManifest = {
          skillId: normalizedSkillId,
          currentVersion: normalizedVersion,
          revision: 1,
          currentSnapshotDigest: snapshotDigest,
          history: [{
            revision: 1,
            version: normalizedVersion,
            snapshotDigest,
            taskId: normalizedBootstrapId,
            action: "bootstrap",
            at: createdAt,
          }],
        };
        validateManifest(manifest, normalizedSkillId);
        await writeAtomic(join(stagingRootReal, "current.json"), manifest);
        await this.readManifest(stagingRootReal, normalizedSkillId);
        await rename(stagingRootReal, skillRoot);
        return {
          skillId: normalizedSkillId,
          version: normalizedVersion,
          revision: 1,
          snapshotDigest,
          artifacts: structuredClone(baselineArtifacts),
        };
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async current(skillId: string): Promise<VersionManifest | undefined> {
    let registryRootReal: string;
    try {
      registryRootReal = await realpath(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const skillRoot = this.skillRoot(registryRootReal, skillId);
    if (!await pathExists(skillRoot)) return undefined;
    const skillRootReal = await this.checkedSkillRoot(registryRootReal, skillId);
    return this.readManifest(skillRootReal, skillId);
  }

  async exportCurrent(skillId: string, expected?: VersionExpectation): Promise<SkillVersionBinding> {
    const registryRootReal = await realpath(this.root);
    const skillRootReal = await this.checkedSkillRoot(registryRootReal, skillId);
    const manifest = await this.readManifest(skillRootReal, skillId);
    if (expected && (manifest.currentVersion !== expected.version ||
      manifest.revision !== expected.revision ||
      manifest.currentSnapshotDigest !== expected.snapshotDigest)) {
      throw new VersionConflictError("requested Skill base binding is no longer current");
    }
    const artifacts = await this.verifyStoredArtifacts(
      skillRootReal,
      skillId,
      manifest.currentVersion,
    );
    if (artifactSnapshotDigest(artifacts) !== manifest.currentSnapshotDigest) {
      throw new Error("current Skill snapshot digest does not match its stored artifacts");
    }
    return {
      skillId,
      version: manifest.currentVersion,
      revision: manifest.revision,
      snapshotDigest: manifest.currentSnapshotDigest,
      artifacts: structuredClone(artifacts),
    };
  }

  async exportVersion(skillId: string, expected: VersionExpectation): Promise<SkillVersionBinding> {
    const normalizedSkillId = safeId(skillId);
    const normalizedVersion = safeId(expected.version);
    const registryRootReal = await realpath(this.root);
    const skillRootReal = await this.checkedSkillRoot(registryRootReal, normalizedSkillId);
    const manifest = await this.readManifest(skillRootReal, normalizedSkillId);
    const history = manifest.history[expected.revision - 1];
    if (history?.revision !== expected.revision || history.version !== normalizedVersion ||
      history.snapshotDigest !== expected.snapshotDigest) {
      throw new VersionConflictError("requested historical Skill binding is not present in the registry");
    }
    const artifacts = await this.verifyStoredArtifacts(
      skillRootReal,
      normalizedSkillId,
      normalizedVersion,
    );
    if (artifactSnapshotDigest(artifacts) !== expected.snapshotDigest) {
      throw new VersionConflictError("requested historical Skill snapshot failed integrity verification");
    }
    return {
      skillId: normalizedSkillId,
      version: normalizedVersion,
      revision: expected.revision,
      snapshotDigest: expected.snapshotDigest,
      artifacts: structuredClone(artifacts),
    };
  }

  async recoverInterrupted(
    skillId: string,
    operation: InterruptedRegistryOperation,
  ): Promise<RegistryRecoveryResult> {
    const normalizedSkillId = safeId(skillId);
    const taskId = safeId(operation.taskId);
    const before = {
      version: safeId(operation.before.version),
      revision: positiveInteger(operation.before.revision, "registry recovery before revision"),
      snapshotDigest: digest(operation.before.snapshotDigest, "registry recovery before digest"),
    };
    const after = {
      version: safeId(operation.after.version),
      revision: positiveInteger(operation.after.revision, "registry recovery after revision"),
      snapshotDigest: digest(operation.after.snapshotDigest, "registry recovery after digest"),
    };
    if (after.revision !== before.revision + 1 ||
      (operation.action !== "publish" && operation.action !== "rollback")) {
      throw new Error("invalid interrupted registry operation");
    }

    const registryRootReal = await this.preparedRegistryRoot();
    const claimed = await this.claimRecoveryLock(registryRootReal, normalizedSkillId);
    let settled = false;
    try {
      const skillRootReal = await this.checkedSkillRoot(registryRootReal, normalizedSkillId);
      const manifest = await this.readManifest(skillRootReal, normalizedSkillId);
      const latest = manifest.history.at(-1);
      if (manifestMatches(manifest, after)) {
        if (latest?.taskId !== taskId || latest.action !== operation.action) {
          throw new Error("committed registry binding does not match the interrupted task");
        }
        const artifacts = await this.verifyStoredArtifacts(skillRootReal, normalizedSkillId, after.version);
        const result: RegistryRecoveryResult = {
          outcome: "committed",
          binding: {
            skillId: normalizedSkillId,
            version: after.version,
            revision: after.revision,
            snapshotDigest: after.snapshotDigest,
            artifacts: structuredClone(artifacts),
          },
          quarantinedEntries: 0,
        };
        settled = true;
        return result;
      }
      if (!manifestMatches(manifest, before)) {
        throw new Error("registry manifest matches neither side of the interrupted operation");
      }
      const quarantinedEntries = await this.quarantineInterruptedEntries(skillRootReal, {
        taskId,
        action: operation.action,
        before,
        after,
      }, manifest);
      const artifacts = await this.verifyStoredArtifacts(skillRootReal, normalizedSkillId, before.version);
      const result: RegistryRecoveryResult = {
        outcome: "not_committed",
        binding: {
          skillId: normalizedSkillId,
          version: before.version,
          revision: before.revision,
          snapshotDigest: before.snapshotDigest,
          artifacts: structuredClone(artifacts),
        },
        quarantinedEntries,
      };
      settled = true;
      return result;
    } finally {
      await unlink(claimed.lockPath).catch(() => undefined);
      if (settled && claimed.staleLockPath) {
        await unlink(claimed.staleLockPath).catch(() => undefined);
      }
    }
  }

  async publish(
    candidate: SkillCandidate,
    ledger: OperationLedger,
    review: ReviewDecision,
    task: EvolutionTask,
    checkRegistry: CheckRegistry,
  ): Promise<SkillVersionBinding> {
    validateCandidate(candidate);
    validateLedger(ledger);
    validateDecision(review);
    validateTask(task);
    if (candidate.status !== "candidate" || ledger.status !== "awaiting_review") {
      throw new Error("candidate is not awaiting review");
    }
    if (candidate.checks.some((check) => !check.passed)) throw new Error("failed candidate cannot publish");
    if (!candidate.evaluation.passed) throw new Error("candidate with a failed fixed evaluation cannot publish");
    if (!(checkRegistry instanceof CheckRegistry)) {
      throw new Error("publication requires the built-in trusted check registry");
    }
    if (ledger.taskDigest !== sha256(stableJson(task)) || task.taskId !== candidate.taskId ||
      ledger.taskId !== task.taskId || task.skillId !== candidate.skillId ||
      task.baseSkillVersion !== candidate.baseVersion || task.baseRevision !== candidate.baseRevision ||
      task.baseSnapshotDigest !== candidate.baseSnapshotDigest) {
      throw new Error("publication task does not match the reviewed candidate and ledger");
    }
    const scope = {
      allowedFiles: [...task.whitelist],
      maxWorkspaceBytes: task.maxCandidateBytes ?? 512 * 1024,
    };
    const baseArtifacts = validateArtifacts(candidate.baseArtifacts, "candidate.baseArtifacts");
    const candidateArtifacts = materializedCandidateArtifacts(candidate);
    if (candidate.checks.length !== task.checkIds.length) {
      throw new Error("publication candidate is missing required gate checks");
    }
    for (let index = 0; index < task.checkIds.length; index += 1) {
      const checkId = task.checkIds[index];
      const candidateCheck = candidate.checks[index];
      const ledgerCheck = [...ledger.checkResults].reverse().find((item) => item.checkId === checkId);
      if (!candidateCheck || !ledgerCheck || candidateCheck.checkId !== checkId ||
        candidateCheck.definitionDigest !== task.checkDefinitionDigests[checkId] ||
        stableJson(candidateCheck) !== stableJson(ledgerCheck)) {
        throw new Error(`publication gate check does not match the reviewed result: ${checkId}`);
      }
      assertTrustedPublicationResult(checkRegistry, candidateCheck, candidateArtifacts, scope);
      assertTrustedPublicationResult(checkRegistry, ledgerCheck, candidateArtifacts, scope);
    }
    const evaluationChecks = ledger.checkResults.filter(
      (check) => check.checkId === task.evaluation.checkId,
    );
    const baselineCheck = evaluationChecks[0];
    const candidateEvaluationCheck = evaluationChecks[1];
    if (evaluationChecks.length !== 2 || !baselineCheck || !candidateEvaluationCheck ||
      candidate.evaluation.checkId !== task.evaluation.checkId ||
      candidate.evaluation.definitionDigest !== task.evaluation.definitionDigest ||
      baselineCheck.definitionDigest !== task.evaluation.definitionDigest ||
      candidateEvaluationCheck.definitionDigest !== task.evaluation.definitionDigest ||
      baselineCheck.outputDigest !== candidate.evaluation.baselineOutputDigest ||
      candidateEvaluationCheck.outputDigest !== candidate.evaluation.outputDigest ||
      stableJson(candidateEvaluationCheck.isolation) !== stableJson(candidate.evaluation.isolation)) {
      throw new Error("publication evaluation does not match the reviewed baseline and candidate runs");
    }
    assertTrustedPublicationResult(checkRegistry, baselineCheck, baseArtifacts, scope);
    assertTrustedPublicationResult(checkRegistry, candidateEvaluationCheck, candidateArtifacts, scope);
    assertTrustedPublicationResult(checkRegistry, candidate.evaluation, candidateArtifacts, scope);
    if (candidate.artifacts.length === 0) throw new Error("empty candidate cannot publish");
    if (candidate.baseArtifacts.length === 0) throw new Error("candidate is missing its base version snapshot");
    if (review.decision !== "approve" || !review.reviewerId || review.reason !== undefined ||
      review.taskId !== candidate.taskId || review.taskDigest !== ledger.taskDigest ||
      review.baseRevision !== candidate.baseRevision ||
      review.baseSnapshotDigest !== candidate.baseSnapshotDigest ||
      review.candidateDigest !== ledger.candidateDigest ||
      review.candidateDigest !== reviewedCandidateDigest(candidate)) {
      throw new Error("publication requires a matching explicit approval decision");
    }

    return this.withSkillLock(candidate.skillId, async (registryRootReal) => {
      const skillRootReal = await this.checkedSkillRoot(registryRootReal, candidate.skillId);
      const previous = await this.readManifest(skillRootReal, candidate.skillId);
      if (previous.currentVersion !== candidate.baseVersion ||
        previous.revision !== candidate.baseRevision ||
        previous.currentSnapshotDigest !== candidate.baseSnapshotDigest) {
        throw new VersionConflictError("candidate base revision is no longer current");
      }
      const storedBase = await this.verifyStoredArtifacts(skillRootReal, candidate.skillId, candidate.baseVersion);
      const candidateBase = validateArtifacts(candidate.baseArtifacts, "candidate.baseArtifacts");
      if (artifactSnapshotDigest(storedBase) !== candidate.baseSnapshotDigest ||
        stableJson(storedBase) !== stableJson(candidateBase)) {
        throw new VersionConflictError("candidate base snapshot does not match the current published version");
      }

      const approvedCandidate = { ...candidate, status: "approved" as const };
      const publishedArtifacts = materializedCandidateArtifacts(approvedCandidate);
      const publishedSnapshotDigest = artifactSnapshotDigest(publishedArtifacts);
      const finalVersionRoot = ensureInside(
        skillRootReal,
        join(skillRootReal, safeId(candidate.candidateVersion)),
      );
      if (await pathExists(finalVersionRoot)) {
        throw new Error("candidate version already exists and requires manual audit");
      }
      const stagingRoot = ensureInside(
        skillRootReal,
        join(skillRootReal, `.candidate.${randomUUID()}.staging`),
      );
      await mkdir(stagingRoot, { recursive: false });
      let installed = false;
      try {
        const stagingRootReal = await realpath(stagingRoot);
        await this.writeVersionArtifacts(skillRootReal, stagingRootReal, publishedArtifacts);
        await writeAtomic(join(stagingRootReal, "candidate.json"), approvedCandidate);
        await writeAtomic(join(stagingRootReal, "review.json"), review);
        const verified = await this.verifyCandidateRoot(
          skillRootReal,
          stagingRootReal,
          candidate.skillId,
          candidate.candidateVersion,
        );
        if (artifactSnapshotDigest(materializedCandidateArtifacts(verified)) !== publishedSnapshotDigest) {
          throw new Error("staged candidate snapshot failed integrity verification");
        }

        const revision = previous.revision + 1;
        const manifest: VersionManifest = {
          skillId: candidate.skillId,
          currentVersion: candidate.candidateVersion,
          revision,
          currentSnapshotDigest: publishedSnapshotDigest,
          history: [
            ...previous.history,
            {
              revision,
              version: candidate.candidateVersion,
              snapshotDigest: publishedSnapshotDigest,
              taskId: candidate.taskId,
              action: "publish",
              at: new Date().toISOString(),
            },
          ],
        };
        validateManifest(manifest, candidate.skillId);
        await rename(stagingRootReal, finalVersionRoot);
        installed = true;
        await writeAtomic(join(skillRootReal, "current.json"), manifest);
        return {
          skillId: candidate.skillId,
          version: candidate.candidateVersion,
          revision,
          snapshotDigest: publishedSnapshotDigest,
          artifacts: structuredClone(publishedArtifacts),
        };
      } catch (error) {
        await rm(installed ? finalVersionRoot : stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async rollback(
    skillId: string,
    taskId: string,
    expectedCurrentVersion: string,
    expectedCurrentRevision: number,
    expectedCurrentSnapshotDigest: string,
    targetVersion: string,
  ): Promise<SkillVersionBinding> {
    return this.withSkillLock(skillId, async (registryRootReal) => {
      const skillRootReal = await this.checkedSkillRoot(registryRootReal, skillId);
      const current = await this.readManifest(skillRootReal, skillId);
      if (current.currentVersion !== expectedCurrentVersion ||
        current.revision !== expectedCurrentRevision ||
        current.currentSnapshotDigest !== expectedCurrentSnapshotDigest) {
        throw new VersionConflictError("published revision changed after this task completed");
      }
      const latest = current.history.at(-1);
      if (latest?.taskId !== taskId || latest.action !== "publish") {
        throw new VersionConflictError("this task is no longer the latest publication for the Skill");
      }
      const artifacts = await this.verifyStoredArtifacts(skillRootReal, skillId, targetVersion);
      const snapshotDigest = artifactSnapshotDigest(artifacts);
      const revision = current.revision + 1;
      const manifest: VersionManifest = {
        ...current,
        currentVersion: targetVersion,
        revision,
        currentSnapshotDigest: snapshotDigest,
        history: [
          ...current.history,
          {
            revision,
            version: targetVersion,
            snapshotDigest,
            taskId,
            action: "rollback",
            at: new Date().toISOString(),
          },
        ],
      };
      validateManifest(manifest, skillId);
      await writeAtomic(join(skillRootReal, "current.json"), manifest);
      return {
        skillId,
        version: targetVersion,
        revision,
        snapshotDigest,
        artifacts: structuredClone(artifacts),
      };
    });
  }
}
