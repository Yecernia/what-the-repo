import test from "node:test";
import assert from "node:assert/strict";
import { createProject, type Project } from "../domain/conversation.js";
import { resolveRevisionRedirectChain, type RevisionRedirect, type RevisionRedirectKind } from "../domain/lifecycle.js";
import type { SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { ensureLearningMigration, learningMigrationStatus, planLearningMigration, resolveLearningReview } from "./learning-migration.js";

function evidence(id: string, path: string): SnapshotEvidence {
  return { stable_id: id, label: id, path, start_line: 1, end_line: 2, kind: "symbol" };
}

function fixture() {
  let project = createProject("guest:migrate", "https://github.com/example/repo", "repo", "free:test");
  project.analysis.stage = "done";
  project.analysis.snapshot_id = "snap:new";
  project.analysis.canonical_snapshot_key = "new-key";
  const step = (id: string, refs: string[]) => ({ step_id: id, order: 0, title: id, objective: "", evidence_refs: refs,
    component_ids: ["component:x"], completion_check: "" });
  project.study.dynamic_learning_plan = [step("same", ["e-same"]), step("edited", ["e-edited"]),
    step("moved", ["e-moved"]), step("gone", ["e-gone"]), step("later", ["e-later"])];
  project.study.snapshot_id = "snap:old";
  project.study.current_step = 4;
  project.study.skipped_steps = ["moved"];
  const old = new Map([evidence("e-same", "same.ts"), evidence("e-edited", "edited.ts"), evidence("e-moved", "moved.ts"),
    evidence("e-gone", "gone.ts"), evidence("e-later", "later.ts")].map((row) => [row.stable_id, row]));
  // The renamed file's evidence id did not survive; the edited file's did.
  const current = new Map([evidence("e-same", "same.ts"), evidence("e-edited", "edited.ts"), evidence("e-later", "later.ts")]
    .map((row) => [row.stable_id, row]));
  const kinds: Record<string, RevisionRedirectKind> = { "same.ts": "unchanged", "edited.ts": "modified",
    "moved.ts": "renamed", "gone.ts": "deleted", "later.ts": "modified" };
  const store = {
    findPublicSnapshotKeyBySnapshotId: async (id: string) => id === "snap:old" ? "old-key" : null,
    readPublicSnapshotEvidence: async (input: { publicKey: string; evidenceIds: string[] }) => {
      const rows = input.publicKey === "old-key" ? old : current;
      return input.evidenceIds.flatMap((id) => rows.get(id) ?? []);
    },
    resolveRevisionRedirect: async (input: { oldPath: string }) => ({ kind: kinds[input.oldPath] }),
    updateProject: async (_id: string, _owner: string, mutate: (row: Project) => void) => {
      const row = structuredClone(project);
      mutate(row);
      project = row;
      return row;
    },
  } as unknown as ProductStore;
  return { store, get project() { return project; } };
}

test("a route keeps reliable steps and asks only about learned steps whose code changed", async () => {
  const state = fixture();
  const migration = await planLearningMigration(state.store, state.project);
  assert.deepEqual(migration?.items.map((item) => [item.step_id, item.reason, item.previously, item.needs_decision]), [
    ["edited", "changed", "completed", true],
    ["moved", "missing", "skipped", true],
    ["gone", "deleted", "completed", true],
    ["later", "changed", "pending", false],
  ]);
  assert.equal(migration?.from_snapshot_id, "snap:old");
});

test("migration runs once, keeps history and resolves relearn and skip idempotently", async () => {
  const state = fixture();
  const migrated = await ensureLearningMigration(state.store, state.project);
  assert.equal(migrated.study.snapshot_id, "snap:new");
  assert.equal(migrated.study.current_step, 4, "progress is not silently rewound");
  const status = learningMigrationStatus(migrated);
  assert.deepEqual([status.status, status.changed_items, status.marked_steps], ["needs_review", 3, 1]);
  assert.deepEqual(status.items?.map((item) => item.step_id), ["edited", "moved", "gone"]);
  const migrationId = migrated.study.migration!.migration_id;
  assert.equal((await ensureLearningMigration(state.store, migrated)).study.migration!.migration_id, migrationId);
  const input = { ownerId: migrated.owner_id, projectId: migrated.project_id, migrationId };
  const relearned = await resolveLearningReview(state.store, { ...input, stepId: "edited", action: "relearn" });
  assert.equal(relearned.study.current_step, 1);
  assert.equal(relearned.study.phase, "explaining");
  const skipped = await resolveLearningReview(state.store, { ...input, stepId: "gone", action: "skip" });
  assert.ok(skipped.study.skipped_steps?.includes("gone"));
  assert.equal(skipped.study.mastered.includes("gone"), false, "a skip is never mastery");
  await resolveLearningReview(state.store, { ...input, stepId: "gone", action: "skip" });
  await assert.rejects(resolveLearningReview(state.store, { ...input, stepId: "gone", action: "relearn" }), { code: "learning_review_resolved" });
  await assert.rejects(resolveLearningReview(state.store, { ...input, stepId: "later", action: "skip" }), { code: "learning_review_not_found" });
  await assert.rejects(resolveLearningReview(state.store, { ...input, migrationId: "stale", stepId: "moved", action: "skip" }),
    { code: "learning_migration_not_found" });
  const done = await resolveLearningReview(state.store, { ...input, stepId: "moved", action: "relearn" });
  assert.equal(done.study.skipped_steps?.includes("moved"), false);
  assert.deepEqual([learningMigrationStatus(done).status, learningMigrationStatus(done).changed_items], ["ready", 0]);
});

test("projects without a route only record the version", async () => {
  const state = fixture();
  state.project.study.dynamic_learning_plan = [];
  const migrated = await ensureLearningMigration(state.store, state.project);
  assert.equal(migrated.study.snapshot_id, "snap:new");
  assert.equal(migrated.study.migration ?? null, null);
  assert.deepEqual(learningMigrationStatus(migrated), { status: "not_needed", changed_items: 0 });
});

test("a change anywhere in a version chain stays a change", () => {
  const row = (from: string, to: string, kind: RevisionRedirectKind): RevisionRedirect => ({ repository_identity: "r",
    from_public_snapshot_key: from, to_public_snapshot_key: to, old_path: "a.ts", old_stable_id: null, kind,
    candidates: [{ path: "a.ts", stable_id: null, confidence: 1 }], created_at: "" });
  const links = [{ repository_identity: "r", from_public_snapshot_key: "A", to_public_snapshot_key: "B", created_at: "" },
    { repository_identity: "r", from_public_snapshot_key: "B", to_public_snapshot_key: "C", created_at: "" }];
  const chain = (first: RevisionRedirectKind, second: RevisionRedirectKind) => resolveRevisionRedirectChain({
    fromPublicKey: "A", toPublicKey: "C", oldPath: "a.ts", links, redirects: [row("A", "B", first), row("B", "C", second)] })?.kind;
  assert.equal(chain("modified", "unchanged"), "modified");
  assert.equal(chain("unchanged", "modified"), "modified");
  assert.equal(chain("unchanged", "unchanged"), "unchanged");
});
