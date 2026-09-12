import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

interface Artifact {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

interface PublishedSkillSource {
  directory: string;
  filePath: string;
  content: string;
  version: string;
  cacheKey: string;
  artifacts: readonly Artifact[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function safeId(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SAFE_ID.test(result)) throw new Error(`invalid ${label}`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SHA256.test(result)) throw new Error(`invalid ${label}`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`invalid ${label}`);
  return Number(value);
}

function portablePath(value: unknown): string {
  const path = text(value, "artifact path").replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid artifact path");
  }
  return path;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function artifacts(value: unknown, label: string): Artifact[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error(`invalid ${label}`);
  }
  const paths = new Set<string>();
  return value.map((raw) => {
    const row = object(raw, label);
    const path = portablePath(row.path);
    if (paths.has(path)) throw new Error(`duplicate ${label} path`);
    paths.add(path);
    const content = typeof row.content === "string" ? row.content : (() => { throw new Error(`invalid ${label} content`); })();
    const artifactDigest = digest(row.sha256, `${label} digest`);
    const bytes = Number(row.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || sha256(content) !== artifactDigest || Buffer.byteLength(content, "utf8") !== bytes) {
      throw new Error(`invalid ${label} integrity`);
    }
    return { path, content, sha256: artifactDigest, bytes };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function materializedCandidateArtifacts(candidate: Record<string, unknown>): Artifact[] {
  const base = artifacts(candidate.baseArtifacts, "candidate base artifacts");
  const changed = artifacts(candidate.artifacts, "candidate artifacts");
  const merged = new Map(base.map((artifact) => [artifact.path, artifact]));
  for (const artifact of changed) {
    if (!merged.has(artifact.path)) throw new Error("candidate artifact is outside the reviewed base");
    merged.set(artifact.path, artifact);
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function ensureInside(root: string, target: string): void {
  const child = relative(root, target);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error("published Skill path escapes its registry");
}

async function parsedJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")) as unknown, path);
}

async function verifiedArtifacts(
  skillRoot: string,
  versionRoot: string,
  skillId: string,
  version: string,
): Promise<Artifact[]> {
  try {
    const candidate = await parsedJson(join(versionRoot, "candidate.json"));
    if (
      candidate.status !== "approved"
      || candidate.skillId !== skillId
      || candidate.candidateVersion !== version
    ) {
      throw new Error("published candidate identity is invalid");
    }
    const review = await parsedJson(join(versionRoot, "review.json"));
    const { status: _status, ...reviewed } = candidate;
    if (
      review.decision !== "approve"
      || review.taskId !== candidate.taskId
      || review.candidateDigest !== sha256(stableJson(reviewed))
    ) {
      throw new Error("published candidate review is invalid");
    }
    return materializedCandidateArtifacts(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const baseline = await parsedJson(join(versionRoot, "baseline.json"));
  if (
    baseline.kind !== "baseline"
    || baseline.skillId !== skillId
    || baseline.version !== version
  ) {
    throw new Error("published baseline identity is invalid");
  }
  const result = artifacts(baseline.artifacts, "baseline artifacts");
  if (baseline.snapshotDigest !== sha256(stableJson(result))) {
    throw new Error("published baseline snapshot digest is invalid");
  }
  ensureInside(skillRoot, versionRoot);
  return result;
}

export async function resolvePublishedSkillSource(
  registryRoot: string | null,
  skillId: string,
): Promise<PublishedSkillSource | null> {
  if (!registryRoot) return null;
  const requestedRoot = resolve(registryRoot);
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifestPath = join(root, safeId(skillId, "Skill id"), "current.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = await parsedJson(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifestSkillId = safeId(manifest.skillId, "manifest Skill id");
  const version = safeId(manifest.currentVersion, "manifest version");
  const revision = positiveInteger(manifest.revision, "manifest revision");
  const snapshotDigest = digest(manifest.currentSnapshotDigest, "manifest snapshot digest");
  if (manifestSkillId !== skillId || !Array.isArray(manifest.history) || manifest.history.length !== revision) {
    throw new Error("published Skill manifest is inconsistent");
  }
  const latest = object(manifest.history.at(-1), "manifest history");
  if (
    latest.revision !== revision
    || latest.version !== version
    || latest.snapshotDigest !== snapshotDigest
  ) {
    throw new Error("published Skill manifest does not match its history");
  }

  const skillRoot = await realpath(join(root, skillId));
  const versionRoot = await realpath(join(skillRoot, version));
  ensureInside(root, skillRoot);
  ensureInside(skillRoot, versionRoot);
  const resolvedArtifacts = await verifiedArtifacts(skillRoot, versionRoot, skillId, version);
  if (sha256(stableJson(resolvedArtifacts)) !== snapshotDigest) {
    throw new Error("published Skill artifact snapshot does not match its manifest");
  }
  const skillArtifact = resolvedArtifacts.find((artifact) => artifact.path === "SKILL.md");
  if (!skillArtifact) throw new Error("published Skill version has no SKILL.md");
  const skillPath = await realpath(join(versionRoot, "SKILL.md"));
  ensureInside(versionRoot, skillPath);
  const content = await readFile(skillPath, "utf8");
  if (content !== skillArtifact.content) {
    throw new Error("published SKILL.md does not match its reviewed artifact");
  }
  return {
    directory: versionRoot,
    filePath: skillPath,
    content,
    version,
    cacheKey: `${revision}:${snapshotDigest}`,
    artifacts: resolvedArtifacts,
  };
}
