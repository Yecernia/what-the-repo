import { randomUUID } from "node:crypto";
import type { LearningReviewItem, Project, StudyMigration } from "../domain/conversation.js";
import type { RevisionRedirectKind } from "../domain/lifecycle.js";
import type { SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { serviceError } from "./errors.js";

/** File kinds whose content is known to be the same in the target version. */
const EQUIVALENT: ReadonlySet<RevisionRedirectKind> = new Set(["unchanged", "renamed"]);

async function evidenceById(store: ProductStore, publicKey: string, snapshotId: string, ids: string[]) {
  const rows = new Map<string, SnapshotEvidence>();
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = await store.readPublicSnapshotEvidence({ publicKey, snapshotId, evidenceIds: ids.slice(offset, offset + 20) })
      .catch(() => [] as SnapshotEvidence[]);
    for (const row of batch) rows.set(row.stable_id, row);
  }
  return rows;
}

/**
 * Deterministically carries a personal learning route to the project's current
 * version. A step stays valid only when every file behind its evidence kept its
 * content and every evidence id still exists; otherwise completed or skipped
 * steps need the learner's decision and unfinished steps are marked as changed.
 * Nothing is dropped and no model is called.
 */
export async function planLearningMigration(store: ProductStore, project: Project): Promise<StudyMigration | null> {
  const plan = project.study.dynamic_learning_plan ?? [];
  const to = project.analysis.snapshot_id;
  const toKey = project.analysis.canonical_snapshot_key;
  const migration = project.repository_migration;
  // Routes recorded before versions were tracked belong to the last migration's source.
  const from = project.study.snapshot_id
    ?? (migration?.to_snapshot_id === to ? migration.from_snapshot_id : to);
  if (!plan.length || !to || !toKey || !from || from === to) return null;
  const fromKey = await store.findPublicSnapshotKeyBySnapshotId(from);
  const refs = [...new Set(plan.flatMap((step) => step.evidence_refs))];
  const [before, after] = await Promise.all([
    fromKey ? evidenceById(store, fromKey, from, refs) : Promise.resolve(new Map<string, SnapshotEvidence>()),
    evidenceById(store, toKey, to, refs),
  ]);
  const fileKinds = new Map<string, RevisionRedirectKind>();
  for (const path of new Set([...before.values()].map((row) => row.path))) {
    const redirect = fromKey
      ? await store.resolveRevisionRedirect({ fromPublicKey: fromKey, toPublicKey: toKey, oldPath: path }).catch(() => null)
      : null;
    fileKinds.set(path, redirect?.kind ?? "unknown");
  }
  const skipped = new Set(project.study.skipped_steps ?? []);
  const items: LearningReviewItem[] = [];
  plan.forEach((step, index) => {
    const paths = [...new Set(step.evidence_refs.map((id) => before.get(id)?.path).filter((path): path is string => Boolean(path)))];
    const kinds = paths.map((path) => fileKinds.get(path) ?? "unknown");
    const missing = step.evidence_refs.some((id) => !after.has(id));
    const reason: LearningReviewItem["reason"] | null = kinds.includes("deleted") ? "deleted"
      : paths.length < 1 || kinds.some((kind) => kind === "unknown") ? "unknown"
        : kinds.some((kind) => !EQUIVALENT.has(kind)) ? "changed"
          : missing ? "missing" : null;
    if (!reason) return;
    const previously = skipped.has(step.step_id) ? "skipped"
      : index < project.study.current_step ? "completed" : "pending";
    items.push({ step_id: step.step_id, title: step.title, reason, paths: paths.slice(0, 8), previously,
      needs_decision: previously !== "pending", resolution: null });
  });
  return { migration_id: randomUUID().replaceAll("-", "").slice(0, 20), from_snapshot_id: from, to_snapshot_id: to,
    created_at: new Date().toISOString(), items };
}

/**
 * Records the route against the current version once. Safe to call on every
 * read: a route already on this version, or without steps, is left alone.
 */
export async function ensureLearningMigration(store: ProductStore, project: Project): Promise<Project> {
  const to = project.analysis.snapshot_id;
  if (!to || project.study.snapshot_id === to || project.analysis.stage !== "done") return project;
  const planned = await planLearningMigration(store, project);
  const updated = await store.updateProject(project.project_id, project.owner_id, (row) => {
    // Another request may have migrated or replaced the route meanwhile.
    if (row.analysis.snapshot_id !== to || row.study.snapshot_id === to) return;
    if (planned && row.study.dynamic_learning_plan?.length
      && row.study.snapshot_id === project.study.snapshot_id) row.study.migration = planned;
    row.study.snapshot_id = to;
  });
  return updated ?? project;
}

/** "relearn" reopens the step as the current one; "skip" records an explicit skip, never mastery. */
export async function resolveLearningReview(store: ProductStore, input: {
  ownerId: string; projectId: string; migrationId: string; stepId: string; action: "relearn" | "skip";
}): Promise<Project> {
  const updated = await store.updateProject(input.projectId, input.ownerId, (row) => {
    const migration = row.study.migration;
    if (!migration || migration.migration_id !== input.migrationId || migration.to_snapshot_id !== row.analysis.snapshot_id) {
      throw serviceError("learning_migration_not_found", "这次学习迁移已不存在，请刷新。", 409);
    }
    const item = migration.items.find((candidate) => candidate.step_id === input.stepId);
    if (!item || !item.needs_decision) throw serviceError("learning_review_not_found", "没有需要复核的学习项。", 404);
    if (item.resolution === input.action) return;
    if (item.resolution) throw serviceError("learning_review_resolved", "这个学习项已处理。", 409);
    const plan = row.study.dynamic_learning_plan ?? [];
    const index = plan.findIndex((step) => step.step_id === input.stepId);
    if (input.action === "relearn") {
      row.study.skipped_steps = (row.study.skipped_steps ?? []).filter((id) => id !== input.stepId);
      if (index >= 0 && index < row.study.current_step) {
        row.study.current_step = index;
        row.study.phase = "explaining";
      }
    } else {
      row.study.skipped_steps = [...new Set([...(row.study.skipped_steps ?? []), input.stepId])];
    }
    item.resolution = input.action;
  });
  if (!updated) throw serviceError("not_found", "项目不存在", 404);
  return updated;
}

export interface LearningMigrationStatus {
  status: "not_needed" | "pending" | "ready" | "needs_review";
  changed_items: number;
  migration_id?: string;
  /** Learned or skipped steps waiting for the learner's relearn/skip decision. */
  items?: Array<Pick<LearningReviewItem, "step_id" | "title" | "reason" | "paths" | "previously">>;
  /** Unfinished steps whose code changed; the tutor re-checks them when reached. */
  marked_steps?: number;
}

export function learningMigrationStatus(project: Project): LearningMigrationStatus {
  const to = project.analysis.snapshot_id;
  if (project.study.dynamic_learning_plan?.length && project.study.snapshot_id && project.study.snapshot_id !== to) {
    return { status: "pending", changed_items: 0 };
  }
  const migration = project.study.migration;
  if (!migration || migration.to_snapshot_id !== to) return { status: "not_needed", changed_items: 0 };
  const open = migration.items.filter((item) => item.needs_decision && !item.resolution);
  return { status: open.length ? "needs_review" : "ready", changed_items: open.length, migration_id: migration.migration_id,
    items: open.map(({ step_id, title, reason, paths, previously }) => ({ step_id, title, reason, paths, previously })),
    marked_steps: migration.items.filter((item) => !item.needs_decision).length };
}
