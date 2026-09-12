import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { unzipSync } from "fflate";
import type { SourceFileManifest } from "./facts.js";
import { isTextPath } from "./languages.js";
import type { RepositoryResearch, RepositoryResearchPage } from "../domain/snapshot.js";
import {
  safePublicHttpsUrl,
  type PublicFetchOptions,
} from "../security/outbound-url.js";
import { readResearchPage } from "./research-page.js";

const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 30_000;
export const RESEARCH_VERSION = "github-research-v4";
const MAX_RESEARCH_CHARS = 24_000;

export interface GithubSource {
  owner: string;
  repo: string;
  commitSha: string;
  sourceRoot: string;
  files: string[];
  manifest: SourceFileManifest[];
  totalBytes: number;
  research: RepositoryResearch;
}

interface GithubTreeEntry { path?: string; mode?: string; type?: string; size?: number; }

export function parseGithubRepository(value: string): { owner: string; repo: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") throw new Error("only_public_github");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("invalid_github_repository");
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

export interface GithubRepositoryHead {
  owner: string;
  repo: string;
  repository: string;
  commitSha: string;
}

export interface GithubGatewayTransport {
  baseUrl: string;
  sharedSecret: string;
}

type GithubJsonRequest = {
  kind: "metadata" | "commit" | "tree" | "readme";
  owner: string;
  repo: string;
  ref?: string;
};

export async function fetchPublicGithubHead(
  value: string,
  clientId?: string | null,
  clientSecret?: string | null,
  gateway?: GithubGatewayTransport | null,
  signal?: AbortSignal,
): Promise<GithubRepositoryHead> {
  const { owner, repo } = parseGithubRepository(value);
  const metadata = await githubJson({ kind: "metadata", owner, repo }, clientId, clientSecret, gateway, signal);
  const defaultBranch = String(metadata.default_branch ?? "main");
  const commit = await githubJson({ kind: "commit", owner, repo, ref: defaultBranch }, clientId, clientSecret, gateway, signal);
  const commitSha = String((commit as { sha?: unknown }).sha ?? "");
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("github_commit_unavailable");
  return { owner, repo, repository: `${owner}/${repo}`, commitSha };
}

function directGithubUrl(request: GithubJsonRequest): string {
  const root = `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}`;
  if (request.kind === "metadata") return root;
  if (request.kind === "readme") return `${root}/readme${request.ref ? `?ref=${encodeURIComponent(request.ref)}` : ""}`;
  if (request.kind === "commit") return `${root}/commits/${encodeURIComponent(request.ref ?? "")}`;
  return `${root}/git/trees/${encodeURIComponent(request.ref ?? "")}?recursive=1`;
}

async function gatewayFetch(
  gateway: GithubGatewayTransport,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(`${gateway.baseUrl.replace(/\/$/, "")}/v1/github/fetch`, {
      method: "POST",
      headers: {
        accept: body.kind === "archive" ? "application/zip" : "application/json",
        authorization: `Bearer ${gateway.sharedSecret}`,
        "content-type": "application/json",
        "user-agent": "what-the-repo-typescript",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new Error("github_gateway_unavailable");
  }
}

async function githubJson(
  request: GithubJsonRequest,
  clientId?: string | null,
  clientSecret?: string | null,
  gateway?: GithubGatewayTransport | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "what-the-repo-typescript" };
  if (clientId && clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  const response = gateway
    ? await gatewayFetch(gateway, {
      kind: request.kind,
      owner: request.owner,
      repo: request.repo,
      ...(request.ref ? { ref: request.ref } : {}),
    }, signal)
    : await fetch(directGithubUrl(request), {
      headers,
      signal,
    });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`github_api_${response.status}`);
  const value: unknown = await response.json();
  signal?.throwIfAborted();
  if (!value || typeof value !== "object") throw new Error("github_invalid_response");
  return value as Record<string, unknown>;
}

export function safeResearchUrl(value: unknown): string | null {
  return safePublicHttpsUrl(value);
}

export async function fetchResearchPage(
  url: string,
  sourceKind: RepositoryResearchPage["source_kind"],
  signal?: AbortSignal,
  options?: PublicFetchOptions,
): Promise<RepositoryResearchPage | null> {
  try {
    return await readResearchPage(url, sourceKind, signal, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

function collectRepositoryResearch(
  owner: string,
  repo: string,
  commitSha: string,
  metadata: Record<string, unknown>,
  readme: RepositoryResearchPage | null,
): RepositoryResearch {
  const repository = `${owner}/${repo}`;
  const homepage = safeResearchUrl(metadata.homepage);
  const officialPages: RepositoryResearchPage[] = [];
  if (homepage) {
    officialPages.push({ url: homepage, title: "Project homepage", content: "", source_kind: "official" });
  }
  const linkCandidates = [...(readme?.content.match(/https:\/\/[^\s)>'"]+/g) ?? [])]
    .map((value) => value.replace(/[.,;]+$/, ""))
    .map(safeResearchUrl)
    .filter((value): value is string => Boolean(value))
    .filter((value) => {
      if (!homepage) return /^https:\/\/(?:docs\.|www\.)/i.test(value);
      try { return new URL(value).hostname === new URL(homepage).hostname; } catch { return false; }
    })
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 2);
  for (const url of linkCandidates) {
    if (officialPages.some((page) => page.url === url)) continue;
    officialPages.push({ url, title: "Project documentation", content: "", source_kind: "official" });
  }
  const topics = Array.isArray(metadata.topics)
    ? metadata.topics.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
  const communitySignals = [
    typeof metadata.stargazers_count === "number" ? `GitHub stars: ${metadata.stargazers_count}` : "",
    typeof metadata.forks_count === "number" ? `GitHub forks: ${metadata.forks_count}` : "",
    typeof metadata.open_issues_count === "number" ? `GitHub open issues: ${metadata.open_issues_count}` : "",
  ].filter(Boolean);
  const description = typeof metadata.description === "string"
    ? metadata.description.slice(0, 1_000)
    : null;
  // These are allowed reading entry points, not fetched evidence. Initial web
  // research is recorded separately; the value agent requests useful bodies.
  const webSearchResults: RepositoryResearchPage[] = [];
  return {
    research_version: RESEARCH_VERSION,
    repository,
    commit_sha: commitSha,
    description,
    homepage,
    topics,
    stars: typeof metadata.stargazers_count === "number" ? metadata.stargazers_count : null,
    forks: typeof metadata.forks_count === "number" ? metadata.forks_count : null,
    readme,
    official_pages: officialPages.slice(0, 3),
    web_search_results: webSearchResults,
    community_signals: communitySignals,
  };
}

function safePath(path: string): boolean {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return normalized === path && !normalized.startsWith("/") && normalized !== "." && !normalized.split("/").includes("..") && isTextPath(normalized);
}

/** Enforce the archive limit while reading, before an oversized body occupies memory. */
export async function readGithubArchive(response: Response, signal?: AbortSignal, maxBytes = MAX_ARCHIVE_BYTES): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("github_archive_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("github_archive_empty");
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("github_archive_too_large");
      }
      chunks.push(chunk.value);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, bytes);
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function fetchPublicGithubSource(
  value: string,
  destination: string,
  clientId?: string | null,
  clientSecret?: string | null,
  gateway?: GithubGatewayTransport | null,
  signal?: AbortSignal,
  targetCommitSha?: string | null,
  onRepositoryResolved?: (head: { owner: string; repo: string; commitSha: string }) => Promise<void>,
): Promise<GithubSource> {
  signal?.throwIfAborted();
  if (targetCommitSha && !/^[0-9a-f]{40}$/i.test(targetCommitSha)) throw new Error("github_invalid_target_commit");
  const { owner, repo } = parseGithubRepository(value);
  const metadata = await githubJson({ kind: "metadata", owner, repo }, clientId, clientSecret, gateway, signal);
  const defaultBranch = String(metadata.default_branch ?? "main");
  const commit = await githubJson({ kind: "commit", owner, repo, ref: targetCommitSha ?? defaultBranch }, clientId, clientSecret, gateway, signal);
  const commitSha = String((commit as { sha?: unknown }).sha ?? "");
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("github_commit_unavailable");
  if (targetCommitSha && commitSha.toLowerCase() !== targetCommitSha.toLowerCase()) throw new Error("github_target_commit_mismatch");
  await onRepositoryResolved?.({ owner, repo, commitSha });
  signal?.throwIfAborted();
  signal?.throwIfAborted();
  const tree = await githubJson({ kind: "tree", owner, repo, ref: commitSha }, clientId, clientSecret, gateway, signal);
  const rows = Array.isArray(tree.tree) ? tree.tree as GithubTreeEntry[] : [];
  const files = rows
    .filter((row) => row.type === "blob" && row.path && safePath(row.path) && Number(row.size ?? 0) <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES)
    .map((row) => row.path as string);
  if (!files.length) throw new Error("github_no_safe_files");
  signal?.throwIfAborted();
  const response = gateway
    ? await gatewayFetch(gateway, { kind: "archive", owner, repo, ref: commitSha }, signal)
    : await fetch(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${commitSha}`, {
      headers: { accept: "application/zip", "user-agent": "what-the-repo-typescript" },
      signal,
    });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`github_archive_${response.status}`);
  const archive = await readGithubArchive(response, signal);
  signal?.throwIfAborted();
  const allowed = new Set(files);
  let expandedBytes = 0;
  const extracted = unzipSync(archive, {
    filter: (entry) => {
      signal?.throwIfAborted();
      const relative = entry.name.split("/").slice(1).join("/");
      if (relative === "" || !allowed.has(relative)) return false;
      expandedBytes += entry.originalSize;
      if (entry.originalSize > MAX_FILE_BYTES || expandedBytes > MAX_SOURCE_BYTES) throw new Error("github_source_too_large");
      return true;
    },
  });
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true });
  let totalBytes = 0;
  const written: string[] = [];
  const manifest: SourceFileManifest[] = [];
  for (const [archivePath, bytes] of Object.entries(extracted)) {
    signal?.throwIfAborted();
    const relative = archivePath.split("/").slice(1).join("/");
    if (!allowed.has(relative) || !safePath(relative)) continue;
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error("github_source_too_large");
    const target = join(destination, ...relative.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, bytes);
    written.push(relative);
    manifest.push({
      path: relative,
      bytes: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (!written.length) throw new Error("github_archive_empty");
  signal?.throwIfAborted();
  written.sort();
  manifest.sort((left, right) => left.path.localeCompare(right.path));
  // The downloaded commit is authoritative even when an older gateway ignores README ref.
  const readmePath = written.find((path) => /^readme(?:\.(?:md|markdown|rst|txt))?$/i.test(path));
  const readme: RepositoryResearchPage | null = readmePath ? {
    url: `https://github.com/${owner}/${repo}/blob/${commitSha}/${encodeURIComponent(readmePath)}`,
    title: "README", source_kind: "readme",
    content: (await readFile(join(destination, readmePath), "utf8")).slice(0, MAX_RESEARCH_CHARS),
  } : null;
  const research = collectRepositoryResearch(owner, repo, commitSha, metadata, readme);
  signal?.throwIfAborted();
  await writeFile(join(destination, ".snapshot-meta.json"), JSON.stringify({ owner, repo, commitSha, files: written, manifest, totalBytes, research }, null, 2), "utf8");
  return { owner, repo, commitSha, sourceRoot: destination, files: written, manifest, totalBytes, research };
}

export async function readSnapshotMeta(sourceRoot: string): Promise<GithubSource | null> {
  try { return JSON.parse(await readFile(join(sourceRoot, ".snapshot-meta.json"), "utf8")) as GithubSource; } catch { return null; }
}
