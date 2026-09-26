import type { ServerConfig } from '../config.js';
import {
  backgroundUpdateAllowedAt,
  type BackgroundAdmission, type BackgroundRepositoryCandidate, type RepositoryIdentityInput,
} from '../persistence/store.js';

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
  /** When the newest release was published, or null; asked only when the other rules would wait. */
  latestReleasePublishedAt?(identity: RepositoryIdentityInput): Promise<string | null>;
  requestUpdate(input: {
    identity: RepositoryIdentityInput;
    projectId: string;
    targetCommitSha: string;
  }): Promise<BackgroundAdmission>;
  /** Brings the repository's next upstream check forward, so a waiting update is not left for the daily check. */
  scheduleCheck?(repository: string, at: string): Promise<void>;
  now?: () => number;
}

/** Waits that end on their own; the repository is checked again when the wait can be over. */
const RECHECK_DEFERRALS: ReadonlySet<BackgroundDecision> = new Set([
  'deferred:interval', 'deferred:capacity', 'deferred:active_update', 'deferred:daily_budget',
]);

/** What one pass decided for one repository, shown in the admin console. */
export type BackgroundDecision =
  | 'inactive' | 'check_failed' | 'check_stale' | 'same' | 'unknown_relation'
  | 'below_threshold' | 'interval' | BackgroundAdmission;

export type BackgroundRefreshOutcome = {
  examined: number;
  checked: number;
  queued: number;
  deferred: number;
  failedChecks: number;
  decisions: Array<{
    repository: string;
    decision: BackgroundDecision;
    relation: CheckedRepositoryFreshness['relation'];
    behindCommits: number | null;
  }>;
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
      examined: 0, checked: 0, queued: 0, deferred: 0, failedChecks: 0, decisions: [],
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
        const decide = (decision: BackgroundDecision, seen = candidate as Pick<CheckedRepositoryFreshness, 'relation' | 'behindCommits'>) => {
          outcome.decisions.push({ repository: candidate.repository, decision,
            relation: seen.relation, behindCommits: seen.behindCommits });
        };
        // A decision needs a check from the last hour, while unforced checks are daily: a repository that
        // only has to wait is checked again when the wait can be over instead of on its next daily check.
        const recheckAt = async (time: number) => {
          await dependencies.scheduleCheck?.(candidate.repository, new Date(time).toISOString()).catch(() => undefined);
        };
        if (Date.parse(candidate.lastRealUseAt) < Date.parse(activeSince)) return decide('inactive');
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
            return decide('check_failed');
          }
        }
        if (freshness.baseSnapshotId !== candidate.currentSnapshotId
          || !freshness.checkedAt
          || at - Date.parse(freshness.checkedAt) > (config.repositoryHeadCheckTtlMinutes ?? 60) * 60_000
          || !freshness.upstreamCommitSha) return decide('check_stale', freshness);
        if (freshness.upstreamCommitSha.toLowerCase() === candidate.currentCommitSha.toLowerCase()) return decide('same', freshness);
        const changed = freshness.relation === 'ahead'
          || freshness.relation === 'diverged' || freshness.relation === 'rewound';
        if (!changed) return decide(freshness.relation === 'same' ? 'same' : 'unknown_relation', freshness);
        const enoughCommits = freshness.relation === 'ahead'
          && (freshness.behindCommits ?? 0) >= (config.repositoryBackgroundCommitThreshold ?? 20);
        const oldSnapshot = at - Date.parse(candidate.publishedAt)
          >= (config.repositoryBackgroundMaxSnapshotAgeDays ?? 7) * 86400_000;
        // A release is the author's own "this is a complete step", so it is worth updating for even when
        // only a few commits have landed.
        const releasedSince = async () => {
          const releasedAt = await dependencies.latestReleasePublishedAt?.(identity).catch(() => null);
          return Boolean(releasedAt && Date.parse(releasedAt) > Date.parse(candidate.publishedAt));
        };
        if (!enoughCommits && !oldSnapshot && !(await releasedSince())) return decide('below_threshold', freshness);
        const allowedAt = backgroundUpdateAllowedAt({
          lastStartedAt: candidate.lastBackgroundStartedAt, lastFailedAt: candidate.lastBackgroundFailedAt,
          minUpdateIntervalHours: config.repositoryBackgroundMinUpdateIntervalHours ?? 24,
          failureRetryHours: config.repositoryBackgroundFailureRetryHours ?? 6,
        });
        if (allowedAt !== null && at < allowedAt) {
          await recheckAt(allowedAt);
          return decide('interval', freshness);
        }
        const admission = await dependencies.requestUpdate({
          identity, projectId: candidate.projectId,
          targetCommitSha: freshness.upstreamCommitSha,
        });
        if (admission === 'queued') outcome.queued++;
        else if (admission.startsWith('deferred')) outcome.deferred++;
        if (RECHECK_DEFERRALS.has(admission)) await recheckAt(at + (config.repositoryHeadCheckTtlMinutes ?? 60) * 60_000);
        decide(admission, freshness);
      }));
    }
    return outcome;
  };
}
