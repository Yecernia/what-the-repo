import type { Project } from "../domain/conversation.js";
import type { PublicSnapshotMetadata } from "../domain/lifecycle.js";
import { parseGithubRepository } from "../analysis/github.js";
import type { ProductStore } from "../persistence/store.js";
import { serviceError } from "./errors.js";

export function repositoryIdentityOf(project: Project): string {
  const parsed = parseGithubRepository(project.source.value);
  return `${parsed.owner}/${parsed.repo}`.toLowerCase();
}

/** A retired version stops serving new requests at purge_after. */
export function snapshotExpired(metadata: PublicSnapshotMetadata): boolean {
  return Boolean(metadata.payload_purged_at
    || (metadata.retired_at && metadata.purge_after && Date.parse(metadata.purge_after) <= Date.now()));
}

/**
 * Resolves the version a page or request reads. The current binding needs no
 * lookup; an older version must belong to the same repository, be retired
 * (never an arbitrary snapshot ID) and still be inside its grace period.
 */
export async function resolveSnapshotView(store: ProductStore, project: Project,
  viewSnapshotId?: string | null): Promise<{ project: Project; historical: boolean }> {
  if (!viewSnapshotId || viewSnapshotId === project.analysis.snapshot_id) return { project, historical: false };
  if (project.source.kind !== "github") throw serviceError("snapshot_mismatch", "页面版本与项目不匹配", 409);
  const key = await store.findPublicSnapshotKeyBySnapshotId(viewSnapshotId);
  const metadata = key ? await store.loadPublicSnapshotMetadata(key) : null;
  if (!metadata || metadata.repository_identity !== repositoryIdentityOf(project)) {
    throw serviceError("snapshot_mismatch", "页面版本与项目不匹配", 409);
  }
  const current = await store.loadCurrentRepositoryHead(metadata.repository_identity);
  if (metadata.public_snapshot_key !== current?.current_public_snapshot_key && !metadata.retired_at) {
    throw serviceError("snapshot_mismatch", "页面版本与项目不匹配", 409);
  }
  if (snapshotExpired(metadata)) {
    throw serviceError("snapshot_expired", "旧版已过期，请刷新到最新版本。", 410);
  }
  const view = structuredClone(project);
  view.analysis.snapshot_id = metadata.analysis_snapshot_id;
  view.analysis.canonical_snapshot_key = metadata.public_snapshot_key;
  view.analysis.stage = "done";
  view.source.commit_sha = metadata.commit_sha;
  return { project: view, historical: true };
}
