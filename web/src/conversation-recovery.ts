export interface ConversationRecovery {
  ownerId: string;
  projectId: string;
  snapshotId: string | null;
  runId: string;
  startedAt: number;
  lessonActionId?: string;
}

export const CONVERSATION_RECOVERY_KEY = 'conversation-active-runs-v1';
export const CONVERSATION_RECOVERY_TTL = 2 * 60 * 60 * 1000;
const MAX_RUNS = 16;

function read(): ConversationRecovery[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CONVERSATION_RECOVERY_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is ConversationRecovery => Boolean(v && typeof v === 'object'
      && typeof v.ownerId === 'string' && typeof v.projectId === 'string' && typeof v.runId === 'string'
      && (v.snapshotId === null || typeof v.snapshotId === 'string')
      && (v.lessonActionId === undefined || typeof v.lessonActionId === 'string')
      && typeof v.startedAt === 'number' && Number.isFinite(v.startedAt)));
  } catch { return []; }
}

function write(items: ConversationRecovery[]): void {
  try {
    // Copy only descriptor fields, even if a caller supplies additional data.
    localStorage.setItem(CONVERSATION_RECOVERY_KEY, JSON.stringify(items.slice(-MAX_RUNS).map(
      ({ ownerId, projectId, snapshotId, runId, startedAt, lessonActionId }) => ({ ownerId, projectId, snapshotId, runId, startedAt, ...(lessonActionId ? { lessonActionId } : {}) }),
    )));
  } catch { /* Storage may be unavailable; the live stream still works. */ }
}

export function rememberConversationRun(run: ConversationRecovery): void {
  write([...read().filter(v => v.ownerId === run.ownerId && v.projectId !== run.projectId
    && Date.now() - v.startedAt < CONVERSATION_RECOVERY_TTL), run]);
}

export function forgetConversationRun(ownerId: string, projectId?: string, runId?: string): void {
  write(read().filter(v => !(v.ownerId === ownerId && (!projectId || v.projectId === projectId)
    && (!runId || v.runId === runId))));
}

export function findConversationRun(ownerId: string, projectId: string, snapshotId: string | null): {
  run?: ConversationRecovery; unavailable?: 'expired' | 'snapshot';
} {
  const items = read();
  const candidate = items.find(v => v.ownerId === ownerId && v.projectId === projectId);
  write(items.filter(v => v.ownerId === ownerId && Date.now() - v.startedAt < CONVERSATION_RECOVERY_TTL
    && v.startedAt <= Date.now() && (v.projectId !== projectId || v.snapshotId === snapshotId)));
  if (!candidate) return {};
  if (Date.now() - candidate.startedAt >= CONVERSATION_RECOVERY_TTL || candidate.startedAt > Date.now()) return { unavailable: 'expired' };
  if (candidate.snapshotId !== snapshotId) return { unavailable: 'snapshot' };
  return { run: candidate };
}
