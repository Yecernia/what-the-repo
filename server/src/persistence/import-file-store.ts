import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  JsonlSessionRepo,
  NodeExecutionEnv,
  type JsonlSessionMetadata,
} from "@earendil-works/pi-agent-core/node";
import type { CompactionEntry, Entry, ProvisionedEntry } from "@earendil-works/pi-agent-core";
import { PiMemoryStore } from "../agent/memory-store.js";
import { PiSessionStore, projectSessionId } from "../agent/session-store.js";
import type { PiSessionIdentity } from "../agent/types.js";
import type { AnalysisJob } from "../domain/jobs.js";
import type { Project } from "../domain/conversation.js";
import { FileStore } from "./file-store.js";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import { PostgresPiSessionBackend } from "./postgres-session-backend.js";
import { PostgresStore } from "./postgres-store.js";

async function jsonFiles<T>(directory: string): Promise<Array<{ name: string; value: T }>> {
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  const result: Array<{ name: string; value: T }> = [];
  for (const name of names) {
    const value = JSON.parse(await readFile(join(directory, name), "utf8")) as T;
    result.push({ name, value });
  }
  return result;
}

function identity(metadata: JsonlSessionMetadata): PiSessionIdentity | null {
  const value = metadata.metadata ?? {};
  const ownerId = typeof value.ownerId === "string" ? value.ownerId : null;
  const projectId = typeof value.projectId === "string" ? value.projectId : null;
  const snapshotId = typeof value.snapshotId === "string" ? value.snapshotId : null;
  const skillId = typeof value.skillId === "string" ? value.skillId : "primary-conversational-supervisor";
  const skillVersion = typeof value.skillVersion === "string" ? value.skillVersion : "legacy-import";
  if (!ownerId || !projectId) return null;
  return {
    sessionId: projectSessionId(ownerId, projectId, snapshotId),
    ownerId,
    projectId,
    snapshotId,
    skillId,
    skillVersion,
  };
}

export async function importFileStoreData(input: {
  root: string;
  sessionRoot: string;
  memoryRoot: string;
  target: PostgresStore;
}): Promise<Record<string, number>> {
  const source = new FileStore(input.root);
  await source.init();
  const counts = {
    users: 0,
    publicSnapshots: 0,
    projects: 0,
    jobs: 0,
    profiles: 0,
    settings: 0,
    traces: 0,
    memories: 0,
    sessions: 0,
  };

  const users = await jsonFiles<Record<string, unknown>>(join(input.root, "users"));
  for (const { value } of users) {
    const ownerId = typeof value.owner_id === "string" ? value.owner_id : null;
    if (!ownerId) continue;
    await input.target.saveUser(ownerId, value);
    counts.users += 1;
  }

  for (const publicKey of await readdir(join(input.root, "public-repository-snapshots")).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{64}$/i.test(publicKey)) continue;
    const bundle = await source.loadPublicSnapshot(publicKey);
    if (!bundle) continue;
    const identityValue = bundle.metadata.identity as Record<string, unknown> | undefined;
    await input.target.savePublicSnapshot({
      publicKey,
      repository: String(identityValue?.repository_identity ?? "unknown/unknown"),
      commitSha: String(identityValue?.commit_sha ?? ""),
      snapshotId: String(bundle.metadata.analysis_snapshot_id ?? ""),
      sourceRoot: source.publicSourceSnapshotRoot(
        publicKey,
        String(bundle.metadata.analysis_snapshot_id ?? ""),
      ),
      view: bundle.view,
      analysis: bundle.analysis,
      analyzerBundleVersion: String(identityValue?.analyzer_bundle_version ?? "legacy-import"),
      analysisConfigDigest: String(identityValue?.analysis_config_digest ?? "legacy-import"),
    });
    counts.publicSnapshots += 1;
  }

  const projects = await jsonFiles<Project>(join(input.root, "projects"));
  for (const { value: project } of projects) {
    if (!(await input.target.loadUser(project.owner_id))) {
      await input.target.saveUser(project.owner_id, {
        owner_id: project.owner_id,
        login: project.owner_id,
        display_name: project.owner_id,
        avatar_url: null,
        kind: project.owner_id.startsWith("guest:") ? "guest" : "github",
      });
    }
    await input.target.saveProject(project);
    counts.projects += 1;
  }

  for (const { value: job } of await jsonFiles<AnalysisJob>(join(input.root, "jobs"))) {
    if (!(await input.target.loadProject(job.project_id))) continue;
    await input.target.saveJob(job);
    counts.jobs += 1;
  }

  const sourceMemories = new PiMemoryStore(input.memoryRoot);
  const targetMemories = new PostgresMemoryStore(input.target.pool);
  for (const { value } of users) {
    const ownerId = typeof value.owner_id === "string" ? value.owner_id : null;
    if (!ownerId) continue;
    await input.target.saveProfile(ownerId, await source.loadProfile(ownerId));
    await input.target.saveSettings(ownerId, await source.loadSettings(ownerId));
    counts.profiles += 1;
    counts.settings += 1;
    for (const memory of await sourceMemories.list(ownerId)) {
      await targetMemories.upsert(memory);
      counts.memories += 1;
    }
  }

  for (const { value: project } of projects) {
    for (const trace of await source.listTraces(project.project_id)) {
      await input.target.saveTrace(String(trace.event_id ?? trace.trace_id ?? `import-${crypto.randomUUID()}`), trace);
      counts.traces += 1;
    }
  }

  const fs = new NodeExecutionEnv({ cwd: input.sessionRoot });
  const repo = new JsonlSessionRepo({ fs, sessionsRoot: input.sessionRoot });
  const targetSessions = new PiSessionStore(new PostgresPiSessionBackend(input.target.pool));
  for (const metadata of await repo.list()) {
    const sessionIdentity = identity(metadata);
    if (!sessionIdentity || !(await input.target.loadProject(sessionIdentity.projectId, sessionIdentity.ownerId))) continue;
    const existing = await targetSessions.snapshot(sessionIdentity);
    if (existing.entries.length) continue;
    const sourceSession = await repo.open(metadata);
    const entries = await sourceSession.findEntries({ order: "oldestFirst" });
    await targetSessions.withSession(sessionIdentity, async ({ session }) => {
      for (const entry of entries) {
        if (entry.type === "message") {
          await targetSessions.appendMessages(session, [entry.message]);
        } else if (entry.type === "compaction") {
          const value = entry as CompactionEntry;
          await targetSessions.appendCompaction(session, {
            summary: value.summary,
            tokensBefore: value.tokensBefore,
            retainedTail: value.retainedTail,
            details: value.details,
            usage: value.usage,
          });
        } else {
          const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
          await session.appendEntry(provisioned as unknown as ProvisionedEntry<Entry>, "main");
        }
      }
    });
    counts.sessions += 1;
  }
  return counts;
}
