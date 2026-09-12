import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CandidateArtifact, EvolutionTask } from "./contracts.js";
import { isPortableIdentifier, portableRelativePath } from "./path-safety.js";
import { resolvedPathIdentity } from "./path-safety.js";

export class WorkspaceSecurityError extends Error {}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function ensureInside(root: string, candidate: string): string {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  const rel = relative(rootResolved, candidateResolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspaceSecurityError("path escapes the evolution workspace");
  }
  return candidateResolved;
}

function normalRelativePath(raw: string): string {
  try {
    return portableRelativePath(raw);
  } catch {
    throw new WorkspaceSecurityError("candidate path is not a safe portable relative path");
  }
}

async function assertRegularInside(root: string, candidate: string): Promise<string> {
  const lexical = ensureInside(root, candidate);
  const stat = await lstat(lexical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceSecurityError("candidate path is not a regular file");
  }
  const actual = await realpath(lexical);
  ensureInside(await realpath(root), actual);
  return actual;
}

async function assertExactWorkspaceTree(root: string, allowedFiles: ReadonlySet<string>): Promise<void> {
  const allowedDirectories = new Set<string>();
  for (const file of allowedFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      allowedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const normalized = normalRelativePath(relativePath);
      const lexical = ensureInside(root, join(root, normalized));
      const metadata = await lstat(lexical);
      if (metadata.isSymbolicLink()) {
        throw new WorkspaceSecurityError("evolution workspace contains a symbolic link");
      }
      if (metadata.isDirectory()) {
        if (!allowedDirectories.has(normalized)) {
          throw new WorkspaceSecurityError("evolution workspace contains an unexpected directory");
        }
        const actual = await realpath(lexical);
        ensureInside(root, actual);
        await visit(actual, normalized);
        continue;
      }
      if (!metadata.isFile() || !allowedFiles.has(normalized)) {
        throw new WorkspaceSecurityError("evolution workspace contains an unexpected entry");
      }
    }
  };
  await visit(root, "");
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class EvolutionWorkspace {
  readonly root: string;
  readonly whitelist: ReadonlySet<string>;
  private readonly baseline = new Map<string, string>();

  private constructor(root: string, whitelist: string[]) {
    this.root = resolve(root);
    this.whitelist = new Set(whitelist.map(normalRelativePath));
  }

  private static validatedProjection(
    task: EvolutionTask,
    baseArtifacts: CandidateArtifact[],
  ): { normalized: string[]; artifactMap: Map<string, CandidateArtifact> } {
    if (!isPortableIdentifier(task.taskId, TASK_ID)) throw new WorkspaceSecurityError("invalid task id");
    if (task.whitelist.length === 0 || task.whitelist.length > 64) {
      throw new WorkspaceSecurityError("whitelist must contain 1 to 64 files");
    }
    const normalized = task.whitelist.map(normalRelativePath);
    if (new Set(normalized).size !== normalized.length) {
      throw new WorkspaceSecurityError("duplicate whitelist entry");
    }
    if (!Array.isArray(baseArtifacts) || baseArtifacts.length === 0 || baseArtifacts.length > 64) {
      throw new WorkspaceSecurityError("registry snapshot is missing or exceeds the file budget");
    }
    const artifactMap = new Map<string, CandidateArtifact>();
    for (const artifact of baseArtifacts) {
      const path = normalRelativePath(artifact.path);
      if (artifactMap.has(path)) {
        throw new WorkspaceSecurityError("registry snapshot contains duplicate paths");
      }
      const bytes = Buffer.byteLength(artifact.content, "utf8");
      if (artifact.bytes !== bytes || artifact.sha256 !== digest(artifact.content)) {
        throw new WorkspaceSecurityError("registry snapshot artifact failed integrity validation");
      }
      artifactMap.set(path, artifact);
    }
    let projectedBytes = 0;
    for (const path of normalized) {
      const artifact = artifactMap.get(path);
      if (!artifact) {
        throw new WorkspaceSecurityError("task whitelist is not present in the trusted registry snapshot");
      }
      projectedBytes += artifact.bytes;
    }
    if (projectedBytes > (task.maxCandidateBytes ?? 512 * 1024)) {
      throw new WorkspaceSecurityError("whitelisted base files exceed the candidate byte budget");
    }
    return { normalized, artifactMap };
  }

  static async create(
    task: EvolutionTask,
    baseArtifacts: CandidateArtifact[],
    trustedWorkspaceRoot: string,
  ): Promise<EvolutionWorkspace> {
    const { normalized, artifactMap } = this.validatedProjection(task, baseArtifacts);

    const workspaceRoot = resolve(trustedWorkspaceRoot);
    const expectedWorkspaceRoot = await resolvedPathIdentity(workspaceRoot);
    if (resolve(expectedWorkspaceRoot) !== workspaceRoot) {
      throw new WorkspaceSecurityError("evolution workspace root was redirected through a link");
    }
    await mkdir(workspaceRoot, { recursive: true });
    const workspaceRootReal = await realpath(workspaceRoot);
    if (resolve(workspaceRootReal) !== workspaceRoot) {
      throw new WorkspaceSecurityError("evolution workspace root was redirected through a link");
    }
    const root = ensureInside(workspaceRootReal, join(workspaceRootReal, task.taskId));
    await mkdir(root, { recursive: false });
    const rootReal = await realpath(root);
    if (resolve(rootReal) !== resolve(root)) {
      await rm(root, { recursive: true, force: true });
      throw new WorkspaceSecurityError("evolution workspace was redirected through a link");
    }
    const workspace = new EvolutionWorkspace(rootReal, normalized);

    try {
      for (const path of workspace.whitelist) {
        const artifact = artifactMap.get(path);
        if (!artifact) throw new WorkspaceSecurityError("registry snapshot is incomplete");
        const target = ensureInside(root, join(root, path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, artifact.content, { encoding: "utf8", flag: "wx" });
        await assertRegularInside(rootReal, target);
        workspace.baseline.set(path, artifact.content);
      }
      return workspace;
    } catch (error) {
      await workspace.cleanup();
      throw error;
    }
  }

  static async reopen(
    task: EvolutionTask,
    baseArtifacts: CandidateArtifact[],
    trustedWorkspaceRoot: string,
  ): Promise<EvolutionWorkspace> {
    const { normalized, artifactMap } = this.validatedProjection(task, baseArtifacts);
    const workspaceRoot = resolve(trustedWorkspaceRoot);
    const workspaceRootReal = await realpath(workspaceRoot);
    if (resolve(workspaceRootReal) !== workspaceRoot) {
      throw new WorkspaceSecurityError("evolution workspace root was redirected through a link");
    }
    const root = ensureInside(workspaceRootReal, join(workspaceRootReal, task.taskId));
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WorkspaceSecurityError("evolution workspace is not a regular directory");
    }
    const rootReal = await realpath(root);
    if (resolve(rootReal) !== resolve(root)) {
      throw new WorkspaceSecurityError("evolution workspace was redirected through a link");
    }

    const workspace = new EvolutionWorkspace(rootReal, normalized);
    await assertExactWorkspaceTree(rootReal, workspace.whitelist);
    const actualPaths = new Set<string>();
    for (const path of workspace.whitelist) {
      const artifact = artifactMap.get(path);
      if (!artifact) throw new WorkspaceSecurityError("registry snapshot is incomplete");
      const actual = await assertRegularInside(rootReal, workspace.path(path));
      if (actualPaths.has(actual)) {
        throw new WorkspaceSecurityError("multiple whitelist paths resolve to the same file");
      }
      actualPaths.add(actual);
      workspace.baseline.set(path, artifact.content);
    }
    return workspace;
  }

  path(raw: string): string {
    const path = normalRelativePath(raw);
    if (!this.whitelist.has(path)) throw new WorkspaceSecurityError("file is not on the whitelist");
    return ensureInside(this.root, join(this.root, path));
  }

  private async checkedPath(raw: string): Promise<string> {
    return assertRegularInside(this.root, this.path(raw));
  }

  async readFile(raw: string): Promise<string> {
    return readFile(await this.checkedPath(raw), "utf8");
  }

  private async readFileBounded(raw: string, maxBytes: number): Promise<string> {
    const target = await this.checkedPath(raw);
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new WorkspaceSecurityError("candidate exceeds byte budget before reading");
    }
    const handle = await open(target, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.size > maxBytes) {
        throw new WorkspaceSecurityError("candidate file changed during bounded inspection");
      }
      const data = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) throw new WorkspaceSecurityError("candidate exceeds byte budget");
      const after = await handle.stat();
      if (after.size !== opened.size || offset !== opened.size) {
        throw new WorkspaceSecurityError("candidate file changed during bounded inspection");
      }
      const bytes = data.subarray(0, offset);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new WorkspaceSecurityError("candidate file is not valid UTF-8 text");
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  async writeFile(raw: string, content: string): Promise<void> {
    const target = await this.checkedPath(raw);
    const handle = await open(target, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.checkedPath(raw);
  }

  async editFile(raw: string, expected: string, replacement: string): Promise<void> {
    if (!expected) throw new WorkspaceSecurityError("edit anchor must not be empty");
    const current = await this.readFile(raw);
    const first = current.indexOf(expected);
    if (first < 0) throw new WorkspaceSecurityError("edit anchor was not found");
    if (current.indexOf(expected, first + expected.length) >= 0) {
      throw new WorkspaceSecurityError("edit anchor is ambiguous");
    }
    await this.writeFile(raw, current.slice(0, first) + replacement + current.slice(first + expected.length));
  }

  async changedArtifacts(maxBytes: number): Promise<CandidateArtifact[]> {
    const result: CandidateArtifact[] = [];
    let workspaceBytes = 0;
    const sizes = new Map<string, number>();
    for (const path of [...this.whitelist].sort()) {
      const metadata = await lstat(await this.checkedPath(path));
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new WorkspaceSecurityError("candidate path is not a regular file");
      }
      workspaceBytes += metadata.size;
      if (workspaceBytes > maxBytes) {
        throw new WorkspaceSecurityError("candidate workspace exceeds byte budget before reading");
      }
      sizes.set(path, metadata.size);
    }
    for (const path of [...this.whitelist].sort()) {
      const content = await this.readFileBounded(path, sizes.get(path) ?? 0);
      if (content === this.baseline.get(path)) continue;
      const bytes = Buffer.byteLength(content, "utf8");
      result.push({ path, content, sha256: digest(content), bytes });
    }
    return result;
  }

  original(path: string): string {
    const normalized = normalRelativePath(path);
    const content = this.baseline.get(normalized);
    if (content === undefined) throw new WorkspaceSecurityError("file is not on the whitelist");
    return content;
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
