import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { emptyProfile, normalizeProfile, nowIso, type LearnerProfile, type Project } from '../domain/conversation.js';
import type { ProductStore } from '../persistence/store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { PostgresMemoryStore } from '../persistence/postgres-memory-store.js';
import type { PiMemoryRepository } from '../agent/memory-store.js';
import type { PiMemoryRecord } from '../agent/types.js';
import { withLearnerLocks } from '../persistence/learner-lock.js';
import { containsSensitiveMemory, generateMemorySummary, sanitizeMemorySummary } from '../agent/memory-summary.js';

export interface LearnerState { profile: LearnerProfile; memories: PiMemoryRecord[]; clearMemories?: boolean; }

function safeState(profile: LearnerProfile, memories: PiMemoryRecord[]): LearnerState {
  profile.languages = profile.languages.filter(value => !containsSensitiveMemory(value));
  profile.goals = profile.goals.filter(value => !containsSensitiveMemory(value));
  profile.explanation_preference = sanitizeMemorySummary(profile.explanation_preference);
  profile.experience_level = sanitizeMemorySummary(profile.experience_level);
  profile.inferred = profile.inferred.filter(row => !containsSensitiveMemory(row.claim, row.evidence));
  return { profile, memories: memories.filter(row => !containsSensitiveMemory(row.key, row.value)) };
}

/** Short owner transaction only; never put model/network work in this callback. */
export async function changeLearner<T>(store: ProductStore, memories: PiMemoryRepository, ownerId: string,
  change: (state: LearnerState, client?: PoolClient) => T | Promise<T>): Promise<T> {
  const apply = async (profile: LearnerProfile, repository: PiMemoryRepository, client?: PoolClient) => {
    const previous = { profile: structuredClone(profile), memories: await repository.list(ownerId) };
    const state = safeState(profile, structuredClone(previous.memories));
    const result = await change(state, client);
    Object.assign(state, safeState(state.profile, state.memories));
    if (state.clearMemories) await repository.clear(ownerId);
    for (const old of previous.memories) if (!state.memories.some(row => row.key === old.key)) await repository.remove(ownerId, old.key);
    for (const row of state.memories) if (state.clearMemories || !isDeepStrictEqual(row, previous.memories.find(old => old.key === row.key))) await repository.upsert(row);
    if (!isDeepStrictEqual(previous.profile, state.profile)) {
      state.profile.updated_at = nowIso();
      if (client) await client.query(`INSERT INTO learner_profiles(owner_id,payload) VALUES($1,$2::jsonb)
        ON CONFLICT(owner_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=clock_timestamp()`, [ownerId, JSON.stringify(state.profile)]);
      else await store.saveProfile(ownerId, state.profile);
    }
    return result;
  };
  if (!(store instanceof PostgresStore)) return withLearnerLocks(store.root, [ownerId],
    async () => apply(await store.loadProfile(ownerId), memories));
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['learner:' + ownerId]);
    const owner = await client.query('SELECT 1 FROM app_users WHERE owner_id=$1 FOR KEY SHARE', [ownerId]);
    if (!owner.rowCount) throw new Error('learner_owner_missing');
    const row = await client.query('SELECT payload FROM learner_profiles WHERE owner_id=$1 FOR UPDATE', [ownerId]);
    const result = await apply(row.rows[0] ? normalizeProfile(row.rows[0].payload) : emptyProfile(), new PostgresMemoryStore(client), client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function learnerView(state: LearnerState): LearnerState {
  const view = safeState(structuredClone(state.profile), structuredClone(state.memories));
  if (view.profile.memory_summary_mode !== 'edited') view.profile.memory_summary = generateMemorySummary(view.profile, view.memories);
  // A manual summary is an explicit user override, not a second set of inferred facts.
  else { view.profile.inferred = []; view.memories = []; }
  return view;
}

export async function readLearner(store: ProductStore, memories: PiMemoryRepository, ownerId: string): Promise<LearnerState> {
  return changeLearner(store, memories, ownerId, state => learnerView(state));
}

/** User changes fence in-flight extraction. A cutoff also prevents replay after forgetting. */
export function invalidateMemory(profile: LearnerProfile, forgetPast = false): void {
  profile.memory_revision = (profile.memory_revision ?? 0) + 1;
  if (forgetPast) profile.memory_cutoff_at = nowIso();
}

export function routeConversation(project: Project): Array<{ role: 'user'; content: string }> {
  let remaining = 24_000;
  const rows: Array<{ role: 'user'; content: string }> = [];
  for (const message of [...project.messages].reverse()) {
    if (message.role !== 'user' || message.error || !message.context_eligible) continue;
    if (message.content.length > remaining) break;
    rows.unshift({ role: 'user', content: containsSensitiveMemory(message.content) ? '[Sensitive message omitted.]' : message.content });
    remaining -= message.content.length;
    if (rows.length === 8) break;
  }
  return rows;
}
