import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProject, createMessage } from "../domain/conversation.js";
import { newAnalysisJob } from "../domain/jobs.js";
import { FileStore } from "./file-store.js";
import { AnalysisLeaseLostError } from "./store.js";
import { PostgresStore } from "./postgres-store.js";

test("Postgres tail replacement deletes only the removed answer inside the project transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "wtr-turn-replace-pg-"));
  const project = createProject("guest:edit", "https://github.com/example/repo", "edit test");
  const question = createMessage("user", "typo");
  const answer = createMessage("assistant", "old answer");
  project.messages = [question, answer];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.startsWith("SELECT owner_id, payload")) return { rows: [{ owner_id: project.owner_id, payload: structuredClone(project) }], rowCount: 1 };
      if (sql.startsWith("SELECT payload FROM project_messages")) return { rows: project.messages.map(payload => ({ payload })), rowCount: 2 };
      return { rows: [], rowCount: 0 };
    }, release() {},
  };
  const store = new PostgresStore({ databaseUrl: "postgresql://unused", root, migrationsRoot: join(root, "migrations"), encryptionSecret: "test-edit-only" });
  const originalPool = store.pool;
  (store as unknown as { pool: unknown }).pool = { connect: async () => client };
  try {
    const updated = await store.updateProject(project.project_id, project.owner_id, row => {
      row.messages = [{ ...question, content: "correct question" }];
    });
    assert.equal(updated?.messages.length, 1);
    const deletion = queries.find(query => query.sql.startsWith("DELETE FROM project_messages"));
    assert.deepEqual(deletion?.params, [project.project_id, [answer.message_id]]);
    assert.equal(queries[0]?.sql, "BEGIN");
    assert.equal(queries.at(-1)?.sql, "COMMIT");
    assert.ok(queries.some(query => query.sql.includes("FOR UPDATE")));
    assert.ok(!queries.some(query => /DELETE FROM (?:traces|provider_usage)/u.test(query.sql)));
  } finally { await originalPool.end(); await rm(root, { recursive: true, force: true }); }
});

function isLeaseLost(error: unknown): boolean {
  return error instanceof AnalysisLeaseLostError
    && error.code === "analysis_lease_lost";
}

function validSnapshotView(snapshotId: string): Record<string, unknown> {
  return {
    snapshot_id: snapshotId,
    summary: { file_count: 0, symbol_count: 0, call_count: 0 },
    graph: {
      semantic_mode: "static",
      nodes: [],
      edges: [],
      layers: [],
      unassigned_component_ids: [],
    },
    value_points: [],
    languages: [],
    learning_plan: { snapshot_id: snapshotId, selected_value_point: null, steps: [] },
  };
}

async function expireLeaseAfterFirstRead(
  store: FileStore,
  jobId: string,
): Promise<() => void> {
  const originalLoadJob = store.loadJob.bind(store);
  let reads = 0;
  (store as unknown as { loadJob: typeof store.loadJob }).loadJob = async (id) => {
    const job = await originalLoadJob(id);
    if (id === jobId && reads++ === 0 && job) {
      await store.saveJob({
        ...job,
        lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
      });
    }
    return job;
  };
  return () => {
    (store as unknown as { loadJob: typeof store.loadJob }).loadJob = originalLoadJob;
  };
}

test("FileStore rechecks a lease before committing each fenced artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-fence-window-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const ownerId = "guest:analysis-fence-window";
    await store.saveUser(ownerId, { owner_id: ownerId, kind: "guest" });
    const project = createProject(ownerId, "https://github.com/example/fence-window", "fence-window", "free:test");
    const job = newAnalysisJob(project.project_id, "analysis:fence-window");
    await store.createProjectWithJob(project, job);
    const claimed = await store.claimAnalysisJob("worker:window", 60);
    assert.ok(claimed);
    const fence = { jobId: claimed.job_id, workerId: "worker:window", attempt: claimed.attempt };

    const restoreProjectHook = await expireLeaseAfterFirstRead(store, claimed.job_id);
    try {
      await assert.rejects(
        store.updateProject(project.project_id, ownerId, (row) => {
          row.analysis.stage = "done";
        }, fence),
        isLeaseLost,
      );
    } finally {
      restoreProjectHook();
    }
    assert.deepEqual((await store.loadProject(project.project_id))?.analysis, project.analysis);

    await store.saveJob({
      ...claimed,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const sourceRoot = join(root, "private-source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "README.md"), "private\n", "utf8");
    const publicKey = "f".repeat(64);
    const restoreSnapshotHook = await expireLeaseAfterFirstRead(store, claimed.job_id);
    try {
      await assert.rejects(
        store.savePublicSnapshot({
          publicKey,
          repository: "example/fence-window",
          commitSha: "1".repeat(40),
          snapshotId: "snap:fence-window",
          sourceRoot,
          view: validSnapshotView("snap:fence-window"),
          analysis: { snapshot_id: "snap:fence-window" },
          fence,
        }),
        isLeaseLost,
      );
    } finally {
      restoreSnapshotHook();
    }
    assert.equal(await store.loadPublicSnapshot(publicKey), null);
    assert.equal(await readFile(join(sourceRoot, "README.md"), "utf8"), "private\n");

    await store.saveJob({
      ...claimed,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const restoreTraceHook = await expireLeaseAfterFirstRead(store, claimed.job_id);
    try {
      await assert.rejects(
        store.saveTrace("analysis-fence-window", { project_id: project.project_id }, fence),
        isLeaseLost,
      );
    } finally {
      restoreTraceHook();
    }
    assert.deepEqual(await store.listTraces(project.project_id), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FileStore fences every analysis artifact after a lease transfers to a new attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-analysis-fence-"));
  try {
    const store = new FileStore(root);
    await store.init();
    const ownerId = "guest:analysis-fence";
    await store.saveUser(ownerId, {
      owner_id: ownerId,
      login: "guest",
      display_name: "访客",
      avatar_url: null,
      kind: "guest",
    });
    const project = createProject(ownerId, "https://github.com/example/fence", "fence", "free:test");
    const job = newAnalysisJob(project.project_id, "analysis:fence");
    await store.createProjectWithJob(project, job);

    const first = await store.claimAnalysisJob("worker:a", 60);
    assert.ok(first);
    const staleFence = {
      jobId: first.job_id,
      workerId: "worker:a",
      attempt: first.attempt,
    };
    await store.saveJob({
      ...first,
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const second = await store.claimAnalysisJob("worker:b", 60);
    assert.ok(second);
    assert.equal(second.attempt, 2);
    const currentProject = await store.loadProject(project.project_id);
    assert.deepEqual(currentProject?.analysis, project.analysis);

    const publicKey = "a".repeat(64);
    await assert.rejects(
      store.updateProject(project.project_id, ownerId, (row) => {
        row.analysis.stage = "done";
      }, staleFence),
      isLeaseLost,
    );
    await assert.rejects(
      store.savePublicSnapshot({
        publicKey,
        repository: "example/fence",
        commitSha: "b".repeat(40),
        snapshotId: "snap:fence",
        view: { snapshot_id: "snap:fence" },
        analysis: { snapshot_id: "snap:fence" },
        fence: staleFence,
      }),
      isLeaseLost,
    );
    await assert.rejects(
      store.saveSnapshotLanguageOverlay({
        publicKey,
        language: "zh-CN",
        status: "ready",
        payload: null,
        fence: staleFence,
      }),
      isLeaseLost,
    );
    await assert.rejects(
      store.saveTrace("analysis-fence-stale", { project_id: project.project_id }, staleFence),
      isLeaseLost,
    );

    assert.deepEqual((await store.loadProject(project.project_id))?.analysis, project.analysis);
    assert.equal(await store.loadPublicSnapshot(publicKey), null);
    assert.equal(await store.loadSnapshotLanguageOverlay(publicKey, "zh-CN"), null);
    assert.deepEqual(await store.listTraces(project.project_id), []);

    const freshFence = {
      jobId: second.job_id,
      workerId: "worker:b",
      attempt: second.attempt,
    };
    assert.ok(await store.updateProject(project.project_id, ownerId, (row) => {
      row.analysis.stage = "scanning";
    }, freshFence));
    assert.equal((await store.loadProject(project.project_id))?.analysis.stage, "scanning");

    const freshSource = join(root, "fresh-source");
    await mkdir(freshSource, { recursive: true });
    await writeFile(join(freshSource, "README.md"), "fresh\n", "utf8");
    await store.savePublicSnapshot({
      publicKey,
      repository: "example/fence",
      commitSha: "b".repeat(40),
      snapshotId: "snap:fence",
      sourceRoot: freshSource,
      view: { snapshot_id: "snap:fence" },
      analysis: { snapshot_id: "snap:fence" },
      fence: freshFence,
    });
    const publishedSource = store.publicSourceSnapshotRoot(publicKey, "snap:fence");
    assert.equal(await readFile(join(publishedSource, "README.md"), "utf8"), "fresh\n");

    const staleSource = join(root, "stale-source");
    await mkdir(staleSource, { recursive: true });
    await writeFile(join(staleSource, "README.md"), "stale\n", "utf8");
    await assert.rejects(
      store.savePublicSnapshot({
        publicKey,
        repository: "example/fence",
        commitSha: "b".repeat(40),
        snapshotId: "snap:fence",
        sourceRoot: staleSource,
        view: { snapshot_id: "snap:fence" },
        analysis: { snapshot_id: "snap:fence" },
        fence: staleFence,
      }),
      isLeaseLost,
    );
    assert.equal(await readFile(join(publishedSource, "README.md"), "utf8"), "fresh\n");
    assert.equal(await readFile(join(staleSource, "README.md"), "utf8"), "stale\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL rejects an invalid analysis fence before artifact writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-fence-"));
  const queries: string[] = [];
  let released = false;
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("SELECT job_id FROM analysis_jobs")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {
      released = true;
    },
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "analysis-fence-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() {
      return client;
    },
  };
  const fence = { jobId: "job-stale", workerId: "worker-old", attempt: 1 };
  try {
    await assert.rejects(
      store.updateProject("project-stale", "guest:stale", () => undefined, fence),
      isLeaseLost,
    );
    await assert.rejects(
      store.saveTrace("trace-stale", { project_id: "project-stale" }, fence),
      isLeaseLost,
    );
    await assert.rejects(
      store.savePublicSnapshot({
        publicKey: "c".repeat(64),
        repository: "example/stale",
        commitSha: "d".repeat(40),
        snapshotId: "snap:stale",
        view: validSnapshotView("snap:stale"),
        analysis: {},
        fence,
      }),
      isLeaseLost,
    );

    assert.equal(released, true);
    assert.equal(queries.filter((sql) => sql === "BEGIN").length, 3);
    assert.equal(queries.filter((sql) => sql === "ROLLBACK").length, 3);
    assert.equal(queries.some((sql) => sql.startsWith("UPDATE projects")), false);
    assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO traces")), false);
    assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO canonical_public_repository_snapshots")), false);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL rechecks the analysis fence before committing a fenced trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-fence-commit-"));
  const queries: string[] = [];
  let leaseChecks = 0;
  const client = {
    async query(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("SELECT job_id FROM analysis_jobs")) {
        leaseChecks += 1;
        return leaseChecks === 1
          ? { rows: [{ job_id: "job-live" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "analysis-fence-commit-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() {
      return client;
    },
  };
  try {
    await assert.rejects(
      store.saveTrace("trace-commit-stale", {
        trace_id: "trace-commit-stale",
        owner_id: "guest:stale",
        project_id: "project-stale",
      }, { jobId: "job-live", workerId: "worker-old", attempt: 1, projectId: "project-stale" }),
      isLeaseLost,
    );
    assert.equal(leaseChecks, 2);
    const projectLock = queries.findIndex((sql) => sql.startsWith("SELECT pg_advisory_xact_lock"));
    const firstLeaseCheck = queries.findIndex((sql) => sql.startsWith("SELECT job_id FROM analysis_jobs"));
    assert.ok(projectLock >= 0 && firstLeaseCheck > projectLock);
    assert.equal(queries.some((sql) => sql.startsWith("INSERT INTO traces")), true);
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(queries.includes("COMMIT"), false);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL fenced overlay publication can finalize its own running job", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-fence-overlay-"));
  let leaseChecks = 0;
  const queries: string[] = [];
  const advisoryLocks: string[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push(normalized);
      if (normalized.startsWith("SELECT pg_advisory_xact_lock")) {
        advisoryLocks.push(String(values[0]));
      }
      if (normalized.startsWith("SELECT project_id FROM analysis_jobs")) {
        return { rows: [{ project_id: "project-overlay" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT job_id FROM analysis_jobs")) {
        leaseChecks += 1;
        return leaseChecks <= 2
          ? { rows: [{ job_id: "job-overlay" }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (normalized.startsWith("SELECT * FROM analysis_jobs")) {
        return {
          rows: [{
            job_id: "job-overlay",
            project_id: "project-overlay",
            idempotency_key: "overlay-key",
            status: "running",
            attempt: 1,
            max_attempts: 3,
            lease_owner: "worker-overlay",
            lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            heartbeat_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            available_at: new Date().toISOString(),
            completed_at: null,
            error: null,
            error_code: null,
            repository_update_id: null,
            execution_role: "overlay",
            language_overlay_key: "overlay-key",
          }],
          rowCount: 1,
        };
      }
      // Make the joined project lookup empty. The publication still has to
      // transition the running job and commit the overlay atomically.
      if (normalized.startsWith("SELECT owner_id, payload FROM projects")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "overlay-fence-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() {
      return client;
    },
  };
  try {
    const completedAt = new Date().toISOString();
    const projectIds = await store.publishSnapshotLanguageOverlay({
      publicKey: "e".repeat(64),
      language: "zh-CN",
      status: "ready",
      payload: {
        schema_version: "snapshot-language-overlay-v1",
        language: "zh-CN",
        generated_at: completedAt,
        components: [],
        layers: [],
        relations: [],
        value_points: [],
      },
      completedAt,
      fence: {
        jobId: "job-overlay",
        workerId: "worker-overlay",
        attempt: 1,
        projectId: "project-overlay",
      },
    });
    assert.deepEqual(projectIds, ["project-overlay"]);
    assert.equal(leaseChecks, 2);
    assert.equal(advisoryLocks[0]?.startsWith("snapshot-language:"), true);
    assert.deepEqual(advisoryLocks.slice(1), ["project:project-overlay"]);
    const projectLock = queries.findIndex((sql, index) => index > 0 && sql.startsWith("SELECT pg_advisory_xact_lock"));
    const firstLeaseCheck = queries.findIndex((sql) => sql.startsWith("SELECT job_id FROM analysis_jobs"));
    assert.ok(projectLock >= 0 && firstLeaseCheck > projectLock);
    assert.equal(queries.at(-1), "COMMIT");
    assert.equal(queries.includes("ROLLBACK"), false);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL project deletion takes the project advisory lock before the project row", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-delete-lock-"));
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push({ sql: normalized, values });
      if (normalized.startsWith("SELECT project_id FROM projects")) {
        return { rows: [{ project_id: "project-delete" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT update_id FROM repository_analysis_updates")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "delete-lock-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() {
      return client;
    },
  };
  try {
    assert.equal(await store.deleteProject("project-delete", "guest:delete"), true);
    const projectLock = queries.findIndex((row) => row.values[0] === "project:project-delete");
    const projectRowLock = queries.findIndex((row) => row.sql.startsWith("SELECT project_id FROM projects"));
    assert.ok(projectLock >= 0 && projectRowLock > projectLock);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("PostgreSQL repository failure locks every project before the fenced job row", async () => {
  const root = await mkdtemp(join(tmpdir(), "what-the-repo-postgres-repository-lock-"));
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      queries.push({ sql: normalized, values });
      if (normalized.startsWith("SELECT repository_identity, analyzer_bundle_version")) {
        return {
          rows: [{
            repository_identity: "example/repository-lock",
            analyzer_bundle_version: "typescript-0.1.0",
            analysis_config_digest: "tree-sitter-nine-language-v1",
            leader_project_id: "project-b",
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes("FROM repository_analysis_update_projects")
        && normalized.includes("ORDER BY project_id")) {
        return {
          rows: [{ project_id: "project-b" }, { project_id: "project-a" }],
          rowCount: 2,
        };
      }
      if (normalized.startsWith("SELECT job_id FROM analysis_jobs")) {
        return { rows: [{ job_id: "job-repository" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT update_id FROM repository_analysis_updates")) {
        return { rows: [{ update_id: "update-repository" }], rowCount: 1 };
      }
      if (normalized.startsWith("SELECT project_id FROM repository_analysis_update_projects")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresStore({
    databaseUrl: "postgresql://unused",
    root,
    migrationsRoot: join(root, "migrations"),
    encryptionSecret: "repository-lock-test-secret",
  });
  const originalPool = store.pool;
  (store as unknown as { pool: { connect(): Promise<typeof client> } }).pool = {
    async connect() {
      return client;
    },
  };
  try {
    await store.failRepositoryUpdate(
      "update-repository",
      "failed",
      {
        jobId: "job-repository",
        workerId: "worker-repository",
        attempt: 1,
        projectId: "project-b",
      },
    );
    const lockKeys = queries
      .filter((row) => row.sql.startsWith("SELECT pg_advisory_xact_lock"))
      .map((row) => String(row.values[0]));
    assert.deepEqual(lockKeys, [
      "repository-update:example/repository-lock:typescript-0.1.0:tree-sitter-nine-language-v1",
      "project:project-a",
      "project:project-b",
    ]);
    let lastProjectLock = -1;
    for (let index = 0; index < queries.length; index += 1) {
      if (String(queries[index]?.values[0]).startsWith("project:")) {
        lastProjectLock = index;
      }
    }
    const firstLeaseCheck = queries.findIndex((row) => row.sql.startsWith("SELECT job_id FROM analysis_jobs"));
    assert.ok(lastProjectLock >= 0 && firstLeaseCheck > lastProjectLock);
  } finally {
    await originalPool.end();
    await rm(root, { recursive: true, force: true });
  }
});
