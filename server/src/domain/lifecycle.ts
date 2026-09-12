export type RepositoryUpdateStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RepositoryHead {
  repository_identity: string;
  analyzer_bundle_version: string;
  analysis_config_digest: string;
  current_public_snapshot_key: string | null;
  current_commit_sha: string | null;
  last_checked_at: string | null;
  updated_at: string;
}

export interface RepositoryUpdate {
  update_id: string;
  repository_identity: string;
  analyzer_bundle_version: string;
  analysis_config_digest: string;
  target_commit_sha: string | null;
  status: RepositoryUpdateStatus;
  leader_project_id: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  result_public_snapshot_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RepositoryUpdateJoin {
  project_id: string;
  update_id: string;
  created_at: string;
}

export interface SnapshotLanguageOverlay {
  public_snapshot_key: string;
  language: string;
  status: "pending" | "ready" | "degraded" | "failed";
  payload: Record<string, unknown> | null;
  generated_at: string | null;
  error: string | null;
}

export function snapshotLanguageOverlayKey(publicKey: string, language: string): string {
  return `${publicKey.toLowerCase()}:${language.trim().toLowerCase()}`;
}

export type RevisionRedirectKind = "unchanged" | "renamed" | "deleted" | "split" | "merged" | "unknown";

export interface RevisionRedirectCandidate {
  path: string;
  stable_id: string | null;
  confidence: number;
}

export interface RevisionRedirect {
  repository_identity: string;
  from_public_snapshot_key: string;
  to_public_snapshot_key: string;
  old_path: string;
  old_stable_id: string | null;
  kind: RevisionRedirectKind;
  candidates: RevisionRedirectCandidate[];
  created_at: string;
}

export interface RevisionLink {
  repository_identity: string;
  from_public_snapshot_key: string;
  to_public_snapshot_key: string;
  created_at: string;
}

/** Resolve a historical path through one or more immutable snapshot links. */
export function resolveRevisionRedirectChain(input: {
  fromPublicKey: string;
  toPublicKey: string;
  oldPath: string;
  oldStableId?: string | null;
  links: RevisionLink[];
  redirects: RevisionRedirect[];
}): RevisionRedirect | null {
  const oldStableId = input.oldStableId ?? null;
  const direct = findRevisionRedirect(
    input.redirects,
    input.fromPublicKey,
    input.toPublicKey,
    input.oldPath,
    oldStableId,
  );
  if (direct) return direct;
  if (input.fromPublicKey === input.toPublicKey) return null;

  type State = {
    key: string;
    path: string;
    stableId: string | null;
    confidence: number;
    history: RevisionRedirect[];
    terminal: RevisionRedirectKind | null;
    depth: number;
  };
  const queue: State[] = [{
    key: input.fromPublicKey,
    path: input.oldPath,
    stableId: oldStableId,
    confidence: 1,
    history: [],
    terminal: null,
    depth: 0,
  }];
  const visited = new Set<string>();
  const outgoing = new Map<string, RevisionLink[]>();
  for (const link of input.links) {
    const rows = outgoing.get(link.from_public_snapshot_key) ?? [];
    rows.push(link);
    outgoing.set(link.from_public_snapshot_key, rows);
  }
  while (queue.length) {
    const state = queue.shift() as State;
    const visitKey = `${state.key}|${state.path}|${state.stableId ?? ""}|${state.terminal ?? ""}`;
    if (visited.has(visitKey) || state.depth > 16) continue;
    visited.add(visitKey);
    if (state.key === input.toPublicKey && state.history.length) {
      return composeRevisionRedirect({ ...input, oldStableId }, state);
    }
    for (const link of outgoing.get(state.key) ?? []) {
      if (state.terminal) {
        queue.push({ ...state, key: link.to_public_snapshot_key, depth: state.depth + 1 });
        continue;
      }
      const row = findRevisionRedirect(
        input.redirects,
        link.from_public_snapshot_key,
        link.to_public_snapshot_key,
        state.path,
        state.stableId,
      );
      if (!row) continue;
      if (row.kind === "deleted" || row.kind === "unknown") {
        queue.push({
          ...state,
          key: link.to_public_snapshot_key,
          history: [...state.history, row],
          terminal: row.kind,
          depth: state.depth + 1,
        });
        continue;
      }
      const candidates = row.candidates.length
        ? row.candidates
        : row.kind === "unchanged"
          ? [{ path: row.old_path, stable_id: row.old_stable_id, confidence: 1 }]
          : [];
      for (const candidate of candidates) {
        queue.push({
          key: link.to_public_snapshot_key,
          path: candidate.path,
          stableId: candidate.stable_id,
          confidence: Math.min(state.confidence, Math.max(0, Math.min(1, candidate.confidence))),
          history: [...state.history, row],
          terminal: null,
          depth: state.depth + 1,
        });
      }
    }
  }
  return null;
}

function findRevisionRedirect(
  rows: RevisionRedirect[],
  fromPublicKey: string,
  toPublicKey: string,
  path: string,
  stableId: string | null,
): RevisionRedirect | null {
  const matches = rows.filter((row) => row.from_public_snapshot_key === fromPublicKey
    && row.to_public_snapshot_key === toPublicKey
    && row.old_path === path);
  return matches.find((row) => (row.old_stable_id ?? null) === stableId)
    ?? matches.find((row) => row.old_stable_id === null)
    ?? null;
}

function composeRevisionRedirect(input: {
  fromPublicKey: string;
  toPublicKey: string;
  oldPath: string;
  oldStableId: string | null;
}, state: {
  path: string;
  stableId: string | null;
  confidence: number;
  history: RevisionRedirect[];
  terminal: RevisionRedirectKind | null;
}): RevisionRedirect {
  const kind = state.terminal
    ?? (state.history.some((row) => row.kind === "split") ? "split"
      : state.history.some((row) => row.kind === "merged") ? "merged"
        : state.path !== input.oldPath || state.history.some((row) => row.kind === "renamed") ? "renamed" : "unchanged");
  return {
    repository_identity: state.history[0]?.repository_identity ?? "",
    from_public_snapshot_key: input.fromPublicKey,
    to_public_snapshot_key: input.toPublicKey,
    old_path: input.oldPath,
    old_stable_id: input.oldStableId,
    kind,
    candidates: kind === "deleted" || kind === "unknown"
      ? []
      : [{ path: state.path, stable_id: state.stableId, confidence: state.confidence }],
    created_at: state.history.at(-1)?.created_at ?? new Date(0).toISOString(),
  };
}

export type RepositoryMigrationStatus =
  | "pending"
  | "confirmed"
  | "declined"
  | "executed"
  | "failed";

export interface RepositoryMigrationAction {
  migration_id: string;
  from_public_snapshot_key: string;
  to_public_snapshot_key: string;
  from_snapshot_id: string;
  to_snapshot_id: string;
  from_commit_sha: string;
  to_commit_sha: string;
  status: RepositoryMigrationStatus;
  route_replanned: boolean;
  resume_step: number | null;
  summary: string | null;
  created_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  error: string | null;
}

export interface PublicSnapshotMetadata {
  public_snapshot_key: string;
  repository_identity: string;
  commit_sha: string;
  analyzer_bundle_version: string;
  analysis_config_digest: string;
  analysis_snapshot_id: string;
  language_overlay_version: string | null;
  retired_at: string | null;
  purge_after: string | null;
  payload_purged_at: string | null;
}

export interface GuestRetentionCandidate {
  owner_id: string;
  action: "soft_delete" | "delete";
  project_count: number;
}

export interface OwnerLifecycle {
  owner_id: string;
  last_seen_at: string;
  deleted_at: string | null;
  purge_after: string | null;
}

export interface OwnerMergeSummary {
  source_owner_id: string;
  target_owner_id: string;
  projects: number;
  messages: number;
  memories: number;
  sessions: number;
  traces: number;
  feedback_requests: number;
  merged_at: string;
}
