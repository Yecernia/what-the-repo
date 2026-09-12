import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createMessage, createProject, nowIso } from "../domain/conversation.js";
import { newAnalysisJob } from "../domain/jobs.js";
import { decryptProviderKey, encryptProviderKey } from "./encrypted-key-vault.js";
import { FileStore } from "./file-store.js";
import { QuotaExceededError } from "./store.js";

test("file store persists assistant thinking summaries with the chat message", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-message-summary-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const project = createProject(
      "guest:summary",
      "https://github.com/example/summary",
      "摘要持久化",
      "free:test",
    );
    const summary = [{
      sequence: 1,
      timestamp: "2026-09-01T00:00:00.000Z",
      kind: "summary" as const,
      stage: "understanding",
      label: "正在理解问题",
      status: "completed" as const,
      elapsed_ms: 42,
    }];
    project.messages.push(createMessage("assistant", "最终回答", {
      thinking_summary: summary,
    }));
    await store.saveProject(project);

    const loaded = await store.loadProject(project.project_id, project.owner_id);
    assert.deepEqual(loaded?.messages[0]?.thinking_summary, summary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store resumes an analysis from a durable stage checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-checkpoint-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const projectId = "project:checkpoint";
    const checkpoint = {
      schema_version: 1,
      stage: "assembly",
      source_root: join(root, "source-snapshots", projectId, ".tmp-source"),
      snapshot_id: "snap:checkpoint",
    };
    const snapshot = {
      snapshot_id: "snap:checkpoint",
      graph: { nodes: [], edges: [] },
    };
    await store.saveAnalysisCheckpoint(projectId, checkpoint, snapshot);

    assert.deepEqual(await store.loadAnalysisCheckpoint(projectId), { checkpoint, snapshot });
    const checkpointDir = join(root, "analysis-checkpoints");
    const files = await readdir(checkpointDir);
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(files.filter((name) => name.endsWith(".bin")).length, 1);
    const pointer = JSON.parse(await readFile(join(checkpointDir, "project_checkpoint.json"), "utf8")) as Record<string, unknown>;
    assert.equal(pointer.encoding, "v8");
    assert.equal(typeof pointer.payload_file, "string");
    assert.equal(typeof pointer.sha256, "string");
    await store.clearAnalysisCheckpoint(projectId);
    assert.equal(await store.loadAnalysisCheckpoint(projectId), null);
    assert.deepEqual(await readdir(checkpointDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider keys are owner-bound authenticated ciphertext", () => {
  const secret = "test-encryption-secret-at-least-16";
  const plaintext = "sk-test-secret-value";
  const encrypted = encryptProviderKey(secret, "github:1", plaintext);
  assert.equal(decryptProviderKey(secret, "github:1", encrypted), plaintext);
  assert.ok(!encrypted.ciphertext.toString("utf8").includes(plaintext));
  assert.throws(() => decryptProviderKey(secret, "github:2", encrypted));
});

test("file development store enforces creation quotas and lease ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-store-contract-"));
  try {
    const store = new FileStore(root, {
      maxProjects: 1,
      maxCreationsPerHour: 5,
      maxActiveAnalysisJobs: 2,
      maxStorageBytes: 1024 * 1024,
    });
    await store.init();
    await store.saveUser("guest:test", {
      owner_id: "guest:test",
      login: "guest",
      display_name: "访客",
      avatar_url: null,
      kind: "guest",
    });
    const first = createProject("guest:test", "https://github.com/example/one", "one", "free:test");
    const firstJob = newAnalysisJob(first.project_id, "analysis:first");
    await store.createProjectWithJob(first, firstJob);
    const second = createProject("guest:test", "https://github.com/example/two", "two", "free:test");
    await assert.rejects(
      store.createProjectWithJob(second, newAnalysisJob(second.project_id, "analysis:second")),
      (error: unknown) => error instanceof QuotaExceededError && error.kind === "projects",
    );

    const claimed = await store.claimAnalysisJob("worker:test", 60);
    assert.equal(claimed?.attempt, 1);
    assert.equal(claimed?.lease_owner, "worker:test");
    assert.equal(await store.heartbeatAnalysisJob(claimed!.job_id, "other-worker", 1, 60), false);
    assert.equal(await store.heartbeatAnalysisJob(claimed!.job_id, "worker:test", 1, 60), true);
    assert.equal(await store.releaseAnalysisJobForResume(claimed!.job_id, "other-worker", 1), false);
    assert.equal(await store.releaseAnalysisJobForResume(claimed!.job_id, "worker:test", 1), true);
    const resumed = await store.claimAnalysisJob("worker:resumed", 60);
    assert.equal(resumed?.job_id, claimed?.job_id);
    assert.equal(resumed?.attempt, 1);
    assert.equal(resumed?.lease_owner, "worker:resumed");
    assert.equal(await store.finishAnalysisJob({
      ...resumed!,
      status: "succeeded",
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date().toISOString(),
    }, "worker:resumed", 1), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store shares one repository update and completes waiter projects on publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-shared-update-"));
  try {
    const store = new FileStore(root);
    await store.init();
    for (const ownerId of ["guest:leader", "guest:waiter", "guest:legacy"]) {
      await store.saveUser(ownerId, {
        owner_id: ownerId,
        login: "guest",
        display_name: "访客",
        avatar_url: null,
        kind: "guest",
      });
    }
    const identity = {
      repository: "example/shared",
      analyzerBundleVersion: "test-analyzer",
      analysisConfigDigest: "test-config",
    };
    const previousPublicKey = "a".repeat(64);
    await store.savePublicSnapshot({
      publicKey: previousPublicKey,
      repository: identity.repository,
      commitSha: "0".repeat(40),
      snapshotId: "snap:test:previous",
      analyzerBundleVersion: identity.analyzerBundleVersion,
      analysisConfigDigest: identity.analysisConfigDigest,
      view: { snapshot_id: "snap:test:previous" },
      analysis: { snapshot_id: "snap:test:previous" },
    });
    const legacyProject = createProject("guest:legacy", "https://github.com/example/shared", "legacy", "free:test");
    legacyProject.analysis.canonical_snapshot_key = previousPublicKey;
    legacyProject.analysis.snapshot_id = "snap:test:previous";
    legacyProject.source.commit_sha = "0".repeat(40);
    await store.saveProject(legacyProject);
    const leaderProject = createProject("guest:leader", "https://github.com/example/shared", "leader", "free:test");
    const waiterProject = createProject("guest:waiter", "https://github.com/example/shared", "waiter", "free:test");
    const leader = await store.createOrJoinRepositoryUpdate({
      project: leaderProject,
      job: newAnalysisJob(leaderProject.project_id, "analysis:shared:leader"),
      identity,
      targetCommitSha: "a".repeat(40),
      newProject: true,
    });
    const waiter = await store.createOrJoinRepositoryUpdate({
      project: waiterProject,
      job: newAnalysisJob(waiterProject.project_id, "analysis:shared:waiter"),
      identity,
      targetCommitSha: "a".repeat(40),
      newProject: true,
    });
    assert.equal(leader.leader, true);
    assert.equal(waiter.leader, false);
    assert.equal(waiter.update.update_id, leader.update.update_id);
    const claimed = await store.claimAnalysisJob("worker:shared", 60);
    assert.equal(claimed?.job_id, leader.job.job_id);
    assert.equal(claimed?.execution_role, "leader");
    assert.equal(await store.claimAnalysisJob("worker:other", 60), null);

    await store.publishRepositoryUpdate({
      updateId: leader.update.update_id,
      publicKey: "b".repeat(64),
      commitSha: "a".repeat(40),
      snapshotId: "snap:test:shared",
      fileCount: 10,
      symbolCount: 20,
      callCount: 30,
      languages: ["typescript"],
      completedAt: new Date().toISOString(),
      readyLanguage: "zh-CN",
      redirects: [],
    });
    assert.equal((await store.loadProject(leaderProject.project_id))?.analysis.snapshot_id, "snap:test:shared");
    assert.equal((await store.loadProject(waiterProject.project_id))?.analysis.snapshot_id, "snap:test:shared");
    const migratedLegacy = await store.loadProject(legacyProject.project_id);
    assert.equal(migratedLegacy?.analysis.snapshot_id, "snap:test:shared");
    assert.equal(migratedLegacy?.repository_migration?.status, "executed");
    assert.equal((await store.loadPublicSnapshotMetadata(previousPublicKey))?.purge_after, (await store.loadPublicSnapshotMetadata(previousPublicKey))?.retired_at);
    assert.equal((await store.loadJob(waiter.job.job_id))?.status, "succeeded");
    assert.equal((await store.loadRepositoryHead(identity))?.current_commit_sha, "a".repeat(40));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store promotes a waiting repository update when its leader project is deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-update-leader-delete-"));
  try {
    const store = new FileStore(root);
    await store.init();
    for (const ownerId of ["guest:leader-delete", "guest:waiter-delete"]) {
      await store.saveUser(ownerId, {
        owner_id: ownerId,
        login: "guest",
        display_name: "访客",
        avatar_url: null,
        kind: "guest",
      });
    }
    const identity = {
      repository: "example/leader-delete",
      analyzerBundleVersion: "test-analyzer",
      analysisConfigDigest: "test-config",
    };
    const leaderProject = createProject("guest:leader-delete", "https://github.com/example/leader-delete", "leader", "free:test");
    const waiterProject = createProject("guest:waiter-delete", "https://github.com/example/leader-delete", "waiter", "free:test");
    const leader = await store.createOrJoinRepositoryUpdate({
      project: leaderProject,
      job: newAnalysisJob(leaderProject.project_id, "analysis:leader-delete"),
      identity,
      targetCommitSha: "c".repeat(40),
      newProject: true,
    });
    const waiter = await store.createOrJoinRepositoryUpdate({
      project: waiterProject,
      job: newAnalysisJob(waiterProject.project_id, "analysis:waiter-delete"),
      identity,
      targetCommitSha: "c".repeat(40),
      newProject: true,
    });
    assert.equal(await store.deleteProject(leaderProject.project_id, leaderProject.owner_id), true);
    const update = await store.loadRepositoryUpdateForProject(waiterProject.project_id);
    assert.equal(update?.leader_project_id, waiterProject.project_id);
    assert.equal((await store.loadJob(waiter.job.job_id))?.execution_role, "leader");
    assert.equal((await store.claimAnalysisJob("worker:promoted", 60))?.job_id, waiter.job.job_id);
    assert.equal(await store.deleteProject(waiterProject.project_id, waiterProject.owner_id), true);
    assert.equal(await store.loadRepositoryUpdateForProject(waiterProject.project_id), null);
    assert.equal((await store.loadJob(leader.job.job_id)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store deduplicates snapshot language overlay jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-overlay-jobs-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const publicKey = "d".repeat(64);
    for (const ownerId of ["guest:overlay-one", "guest:overlay-two"]) {
      await store.saveUser(ownerId, {
        owner_id: ownerId,
        login: "guest",
        display_name: "访客",
        avatar_url: null,
        kind: "guest",
      });
    }
    const first = createProject("guest:overlay-one", "https://github.com/example/overlay", "one", "free:test", "en");
    const second = createProject("guest:overlay-two", "https://github.com/example/overlay", "two", "free:test", "en");
    for (const project of [first, second]) {
      project.analysis.canonical_snapshot_key = publicKey;
      project.analysis.snapshot_id = "snap:overlay";
    }
    const firstResult = await store.createOrJoinSnapshotLanguageOverlay({
      project: first,
      job: newAnalysisJob(first.project_id, "analysis:overlay:first"),
      publicKey,
      language: "en",
      newProject: true,
    });
    const secondResult = await store.createOrJoinSnapshotLanguageOverlay({
      project: second,
      job: newAnalysisJob(second.project_id, "analysis:overlay:second"),
      publicKey,
      language: "en",
      newProject: true,
    });
    assert.equal(firstResult.job.execution_role, "overlay");
    assert.equal(secondResult.job.execution_role, "waiter");
    assert.equal(firstResult.job.language_overlay_key, secondResult.job.language_overlay_key);
    assert.equal((await store.claimAnalysisJob("worker:overlay", 60))?.job_id, firstResult.job.job_id);
    assert.equal(await store.claimAnalysisJob("worker:overlay-two", 60), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store cancels queued and running jobs and rejects stale completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-cancel-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const ownerId = "guest:analysis-cancel";
    await store.saveUser(ownerId, {
      owner_id: ownerId,
      login: "guest",
      display_name: "访客",
      avatar_url: null,
      kind: "guest",
    });
    const project = createProject(ownerId, "https://github.com/example/cancel", "cancel", "free:test");
    const firstJob = newAnalysisJob(project.project_id, "analysis:cancel:first");
    await store.createProjectWithJob(project, firstJob);

    const cancelledQueued = await store.cancelAnalysisJob(project.project_id, ownerId, firstJob.job_id);
    assert.equal(cancelledQueued?.status, "cancelled");
    assert.equal(cancelledQueued?.error_code, "analysis_cancelled");
    assert.equal((await store.loadProject(project.project_id))?.analysis.error, "分析已停止，可重新分析。");
    assert.equal(await store.claimAnalysisJob("worker:cancel", 60), null);

    const secondJob = newAnalysisJob(project.project_id, "analysis:cancel:second");
    await store.enqueueAnalysisJob(ownerId, project.project_id, secondJob);
    const claimed = await store.claimAnalysisJob("worker:cancel", 60);
    assert.ok(claimed);
    const cancelledRunning = await store.cancelAnalysisJob(project.project_id, ownerId, claimed!.job_id);
    assert.equal(cancelledRunning?.status, "cancelled");
    assert.equal(await store.finishAnalysisJob({
      ...claimed!,
      status: "succeeded",
      lease_owner: null,
      lease_expires_at: null,
      completed_at: nowIso(),
    }, "worker:cancel", claimed!.attempt), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store promotes a repository waiter when its leader analysis is cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-cancel-shared-"));
  try {
    const store = new FileStore(root);
    await store.init();
    for (const ownerId of ["guest:cancel-leader", "guest:cancel-waiter"]) {
      await store.saveUser(ownerId, {
        owner_id: ownerId,
        login: "guest",
        display_name: "访客",
        avatar_url: null,
        kind: "guest",
      });
    }
    const identity = {
      repository: "example/cancel-shared",
      analyzerBundleVersion: "test-analyzer",
      analysisConfigDigest: "test-config",
    };
    const leaderProject = createProject("guest:cancel-leader", "https://github.com/example/cancel-shared", "leader", "free:test");
    const waiterProject = createProject("guest:cancel-waiter", "https://github.com/example/cancel-shared", "waiter", "free:test");
    const leader = await store.createOrJoinRepositoryUpdate({
      project: leaderProject,
      job: newAnalysisJob(leaderProject.project_id, "analysis:cancel-shared:leader"),
      identity,
      targetCommitSha: "a".repeat(40),
      newProject: true,
    });
    const waiter = await store.createOrJoinRepositoryUpdate({
      project: waiterProject,
      job: newAnalysisJob(waiterProject.project_id, "analysis:cancel-shared:waiter"),
      identity,
      targetCommitSha: "a".repeat(40),
      newProject: true,
    });
    const claimedLeader = await store.claimAnalysisJob("worker:cancel-shared", 60);
    assert.equal(claimedLeader?.job_id, leader.job.job_id);

    const cancelled = await store.cancelAnalysisJob(leaderProject.project_id, leaderProject.owner_id, leader.job.job_id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal((await store.loadRepositoryUpdateForProject(leaderProject.project_id)), null);
    assert.equal((await store.loadRepositoryUpdateForProject(waiterProject.project_id))?.leader_project_id, waiterProject.project_id);
    assert.equal((await store.loadJob(waiter.job.job_id))?.execution_role, "leader");

    const promoted = await store.claimAnalysisJob("worker:promoted", 60);
    assert.equal(promoted?.job_id, waiter.job.job_id);
    const cancelledLast = await store.cancelAnalysisJob(waiterProject.project_id, waiterProject.owner_id, waiter.job.job_id);
    assert.equal(cancelledLast?.status, "cancelled");
    assert.equal((await store.loadRepositoryUpdateForProject(waiterProject.project_id)), null);
    const update = JSON.parse(await readFile(join(root, "repository-updates", `${leader.update.update_id}.json`), "utf8")) as { status: string };
    assert.equal(update.status, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store promotes a language overlay waiter when its leader is cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-cancel-overlay-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const publicKey = "f".repeat(64);
    for (const ownerId of ["guest:cancel-overlay-one", "guest:cancel-overlay-two"]) {
      await store.saveUser(ownerId, {
        owner_id: ownerId,
        login: "guest",
        display_name: "访客",
        avatar_url: null,
        kind: "guest",
      });
    }
    const first = createProject("guest:cancel-overlay-one", "https://github.com/example/cancel-overlay", "one", "free:test", "en");
    const second = createProject("guest:cancel-overlay-two", "https://github.com/example/cancel-overlay", "two", "free:test", "en");
    for (const project of [first, second]) {
      project.analysis.canonical_snapshot_key = publicKey;
      project.analysis.snapshot_id = "snap:cancel-overlay";
    }
    const firstResult = await store.createOrJoinSnapshotLanguageOverlay({
      project: first,
      job: newAnalysisJob(first.project_id, "analysis:cancel-overlay:first"),
      publicKey,
      language: "en",
      newProject: true,
    });
    const secondResult = await store.createOrJoinSnapshotLanguageOverlay({
      project: second,
      job: newAnalysisJob(second.project_id, "analysis:cancel-overlay:second"),
      publicKey,
      language: "en",
      newProject: true,
    });
    assert.equal((await store.claimAnalysisJob("worker:cancel-overlay", 60))?.job_id, firstResult.job.job_id);
    await store.cancelAnalysisJob(first.project_id, first.owner_id, firstResult.job.job_id);
    assert.equal((await store.loadJob(secondResult.job.job_id))?.execution_role, "overlay");
    assert.equal((await store.claimAnalysisJob("worker:cancel-overlay-promoted", 60))?.job_id, secondResult.job.job_id);
    await store.cancelAnalysisJob(second.project_id, second.owner_id, secondResult.job.job_id);
    assert.equal((await store.loadSnapshotLanguageOverlay(publicKey, "en"))?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store does not purge a shared snapshot while a project still references it", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-snapshot-retention-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const ownerId = "guest:snapshot-retention";
    await store.saveUser(ownerId, {
      owner_id: ownerId,
      login: "guest",
      display_name: "访客",
      avatar_url: null,
      kind: "guest",
    });
    const publicKey = "e".repeat(64);
    await store.savePublicSnapshot({
      publicKey,
      repository: "example/retention",
      commitSha: "f".repeat(40),
      snapshotId: "snap:retention",
      view: { snapshot_id: "snap:retention" },
      analysis: { snapshot_id: "snap:retention" },
    });
    const project = createProject(ownerId, "https://github.com/example/retention", "retention", "free:test");
    project.analysis.canonical_snapshot_key = publicKey;
    project.analysis.snapshot_id = "snap:retention";
    await store.saveProject(project);

    const metadataPath = join(root, "public-repository-snapshots", publicKey, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.retired_at = "2026-08-01T00:00:00.000Z";
    metadata.purge_after = "2026-08-08T00:00:00.000Z";
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");

    assert.deepEqual(await store.listPurgeablePublicSnapshots("2026-08-21T00:00:00.000Z"), []);
    assert.equal(await store.purgePublicSnapshotPayload(publicKey.toUpperCase(), "2026-08-21T00:00:00.000Z"), false);
    assert.ok(await store.loadPublicSnapshot(publicKey));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file store persists large analysis payloads as validated chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-large-analysis-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const publicKey = "c".repeat(64);
    const snapshotId = "snap:large-analysis";
    const nodes = Array.from({ length: 2_100 }, (_, index) => ({
      id: `fact-node-${index}`,
      label: `Fact ${index}`,
      name: `Fact ${index}`,
      responsibility: "test",
      members: [],
      member_count: 0,
      evidence: [],
      certainty: "verified",
      review_status: "accepted",
      fan_in: 0,
      fan_out: 0,
    }));
    const edges = Array.from({ length: 2_100 }, (_, index) => ({
      id: `fact-edge-${index}`,
      source: `fact-node-${index}`,
      target: `fact-node-${(index + 1) % 2_100}`,
      relation_kind: "calls",
      label: "calls",
      description: "test",
      certainty: "verified",
      evidence: [],
      weight: 1,
    }));
    const view = { snapshot_id: snapshotId, graph: { nodes: [], edges: [] } };
    const analysis = { snapshot_id: snapshotId, fact_graph: { nodes, edges } };
    await store.savePublicSnapshot({
      publicKey,
      repository: "example/large-analysis",
      commitSha: "a".repeat(40),
      snapshotId,
      view,
      analysis,
    });

    const directory = join(root, "public-repository-snapshots", publicKey);
    const envelope = JSON.parse(await readFile(join(directory, "analysis.json"), "utf8")) as {
      schema_version?: string;
      chunks?: unknown[];
    };
    assert.equal(envelope.schema_version, "analysis-payload-chunks-v1");
    assert.ok((envelope.chunks?.length ?? 0) >= 2);
    const loaded = await store.loadPublicSnapshot(publicKey);
    assert.deepEqual((loaded?.analysis as typeof analysis).fact_graph.nodes, nodes);
    assert.deepEqual((loaded?.analysis as typeof analysis).fact_graph.edges, edges);

    const metadataPath = join(directory, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    metadata.retired_at = "2026-08-01T00:00:00.000Z";
    metadata.purge_after = "2026-08-08T00:00:00.000Z";
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, "utf8");
    assert.equal(await store.purgePublicSnapshotPayload(publicKey, "2026-08-31T00:00:00.000Z"), true);
    await assert.rejects(readFile(join(directory, "analysis.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    await assert.rejects(readdir(join(directory, "analysis-chunks")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TypeScript migration owns messages, encrypted keys, memories and Pi sessions", async () => {
  const sql = await readFile(join(process.cwd(), "migrations", "0001_product.sql"), "utf8");
  for (const table of [
    "project_messages",
    "provider_keys",
    "pi_memories",
    "pi_sessions",
    "pi_session_log",
  ]) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.ok(sql.includes("ciphertext bytea"));
  assert.ok(!sql.includes("api_key text"));
  const evolutionSql = await readFile(join(process.cwd(), "migrations", "0004_evolution_feedback.sql"), "utf8");
  assert.ok(evolutionSql.includes("CREATE TABLE IF NOT EXISTS evolution_feedback_requests"));
  const evolutionTasksSql = await readFile(join(process.cwd(), "migrations", "0010_evolution_tasks.sql"), "utf8");
  assert.ok(evolutionTasksSql.includes("CREATE TABLE IF NOT EXISTS evolution_tasks"));
  assert.ok(evolutionTasksSql.includes("ledger_payload jsonb NOT NULL"));
  const externalPayloadSql = await readFile(
    join(process.cwd(), "migrations", "0005_external_snapshot_payloads.sql"),
    "utf8",
  );
  assert.ok(externalPayloadSql.includes("ALTER COLUMN analysis_payload DROP NOT NULL"));
  assert.ok(externalPayloadSql.includes("analysis_storage_key"));
  const manifestSql = await readFile(
    join(process.cwd(), "migrations", "0011_snapshot_manifest_integrity.sql"),
    "utf8",
  );
  assert.ok(manifestSql.includes("manifest_storage_key"));
  assert.ok(manifestSql.includes("canonical_public_snapshots_manifest_integrity_ck"));
  const sourceManifestSql = await readFile(
    join(process.cwd(), "migrations", "0012_source_snapshot_manifest.sql"),
    "utf8",
  );
  assert.ok(sourceManifestSql.includes("source_manifest_sha256"));
  assert.ok(sourceManifestSql.includes("source_file_count"));
  assert.ok(sourceManifestSql.includes("canonical_public_snapshots_source_manifest_integrity_ck"));
  const providerDeploymentIndexSql = await readFile(
    join(process.cwd(), "migrations", "0013_provider_usage_deployment_index.sql"),
    "utf8",
  );
  assert.ok(providerDeploymentIndexSql.includes("provider_usage_started_idx"));
  assert.ok(providerDeploymentIndexSql.includes("provider_usage_events(started_at DESC)"));
});
