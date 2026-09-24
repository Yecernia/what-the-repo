import type { ServerConfig } from '../config.js';
import type { BackgroundRepositoryCandidate, RepositoryIdentityInput } from '../persistence/store.js';

export interface CheckedRepositoryFreshness {
  baseSnapshotId: string | null;
  upstreamCommitSha: string | null;
  behindCommits: number | null;
  relation: 'same' | 'ahead' | 'diverged' | 'rewound' | 'unknown';
  checkedAt: string | null;
}

export interface BackgroundRefreshDependencies {
  listCandidates(now: string, activeSince: string, limit: number): Promise<BackgroundRepositoryCandidate[]>;
  checkFreshness(identity: RepositoryIdentityInput): Promise<CheckedRepositoryFreshness>;
  requestUpdate(input: {
    identity: RepositoryIdentityInput;
    projectId: string;
    targetCommitSha: string;
  }): Promise<'queued' | 'deferred' | 'up_to_date'>;
  now?: () => number;
}

export type BackgroundRefreshOutcome = {
  examined: number;
  checked: number;
  queued: number;
  deferred: number;
  failedChecks: number;
};

/**
 * Only evaluates recently used repositories. Store admission must atomically
 * enforce the daily count, money cap, queue slots, per-repository lock and
 * resource reserve; this loop never treats a page read as paid authorization.
 */
export function createRepositoryBackgroundRefreshTask(
  config: ServerConfig,
  dependencies: BackgroundRefreshDependencies,
): () => Promise<BackgroundRefreshOutcome> {
  const now = dependencies.now ?? Date.now;
  return async () => {
    const outcome: BackgroundRefreshOutcome = {
      examined: 0, checked: 0, queued: 0, deferred: 0, failedChecks: 0,
    };
    if (!config.repositoryBackgroundRefreshEnabled) return outcome;
    const at = now();
    const activeSince = new Date(at - (config.repositoryActiveWindowDays ?? 7) * 86400_000).toISOString();
    const candidates = await dependencies.listCandidates(
      new Date(at).toISOString(), activeSince, 8,
    );
    // Two GitHub metadata operations at a time; each tick has a fixed batch.
    for (let index = 0; index < candidates.length; index += 2) {
      await Promise.all(candidates.slice(index, index + 2).map(async candidate => {
        outcome.examined++;
        if (Date.parse(candidate.lastRealUseAt) < Date.parse(activeSince)) return;
        const identity: RepositoryIdentityInput = {
          repository: candidate.repository,
          analyzerBundleVersion: candidate.analyzerBundleVersion,
          analysisConfigDigest: candidate.analysisConfigDigest,
        };
        let freshness: CheckedRepositoryFreshness = {
          baseSnapshotId: candidate.currentSnapshotId,
          upstreamCommitSha: candidate.upstreamCommitSha,
          behindCommits: candidate.behindCommits,
          relation: candidate.relation,
          checkedAt: candidate.lastCheckedAt,
        };
        const due = !candidate.nextCheckAt || Date.parse(candidate.nextCheckAt) <= at;
        if (due) {
          try {
            freshness = await dependencies.checkFreshness(identity);
            outcome.checked++;
          } catch {
            outcome.failedChecks++;
            return;
          }
        }
        if (freshness.baseSnapshotId !== candidate.currentSnapshotId
          || !freshness.checkedAt
          || at - Date.parse(freshness.checkedAt) > (config.repositoryHeadCheckTtlMinutes ?? 60) * 60_000
          || !freshness.upstreamCommitSha
          || freshness.upstreamCommitSha.toLowerCase() === candidate.currentCommitSha.toLowerCase()) return;
        const changed = freshness.relation === 'ahead'
          || freshness.relation === 'diverged' || freshness.relation === 'rewound';
        if (!changed) return;
        const enoughCommits = freshness.relation === 'ahead'
          && (freshness.behindCommits ?? 0) >= (config.repositoryBackgroundCommitThreshold ?? 20);
        const oldSnapshot = at - Date.parse(candidate.publishedAt)
          >= (config.repositoryBackgroundMaxSnapshotAgeDays ?? 7) * 86400_000;
        if (!enoughCommits && !oldSnapshot) return;
        if (candidate.lastBackgroundStartedAt
          && at - Date.parse(candidate.lastBackgroundStartedAt)
            < (config.repositoryBackgroundMinUpdateIntervalHours ?? 24) * 3600_000) return;
        const admission = await dependencies.requestUpdate({
          identity, projectId: candidate.projectId,
          targetCommitSha: freshness.upstreamCommitSha,
        });
        if (admission === 'queued') outcome.queued++;
        else if (admission === 'deferred') outcome.deferred++;
      }));
    }
    return outcome;
  };
}
