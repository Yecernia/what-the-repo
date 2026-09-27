import { createHash, randomUUID } from 'node:crypto';
import { Type, type Static } from 'typebox';
import { nowIso, profileClaimId, type Message, type Project } from '../domain/conversation.js';
import type { ProductStore } from '../persistence/store.js';
import { PostgresStore } from '../persistence/postgres-store.js';
import { MemoryWorkQueue, type MemoryWork } from '../persistence/memory-work.js';
import { changeLearner, readLearner, invalidateMemory } from '../services/learner-context.js';
import { memoryId, type PiMemoryRepository } from './memory-store.js';
import { runStructuredWorker } from './structured-worker.js';
import type { PiModelRuntime } from './types.js';
import { containsSensitiveMemory, generateMemorySummary } from './memory-summary.js';

const sourceFields = { source_message_id: Type.String({ maxLength: 128 }), evidence: Type.String({ minLength: 1, maxLength: 300 }) };
const MEMORY_RESULT = Type.Object({
  memories: Type.Array(Type.Object({ ...sourceFields, key: Type.String({ minLength: 1, maxLength: 120 }),
    value: Type.String({ minLength: 1, maxLength: 500 }), confidence: Type.Number({ minimum: 0, maximum: 1 }) }), { maxItems: 8 }),
  profile_claims: Type.Array(Type.Object({ ...sourceFields, claim: Type.String({ minLength: 1, maxLength: 500 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    supersedes: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 })) }), { maxItems: 8 }),
  retractions: Type.Optional(Type.Array(Type.Object({ ...sourceFields,
    kind: Type.Union([Type.Literal('memory'), Type.Literal('claim')]), key: Type.String({ minLength: 1, maxLength: 128 }),
  }), { maxItems: 8 })),
});
export type MemoryWorkerOutput = Static<typeof MEMORY_RESULT>;
export const memoryMessageRevision = (message: Message): string => createHash('sha256').update(message.content).digest('hex');

export async function applyMemoryOutput(input: {
  ownerId: string; project: Project; output: MemoryWorkerOutput; store: ProductStore; memories: PiMemoryRepository;
  expectedRevision?: number; work?: { queue: MemoryWorkQueue; lease: MemoryWork; processed: Record<string, string>; complete: boolean };
}): Promise<{ memories: number; profileClaims: number }> {
  if (input.project.owner_id !== input.ownerId) throw new Error('memory_owner_mismatch');
  let accepted = false;
  const applied = await changeLearner(input.store, input.memories, input.ownerId, async (state, client) => {
    const { profile } = state;
    const finish = async (accepted: boolean) => {
      if (!input.work) return;
      const { queue, lease, processed, complete } = input.work;
      if (!await queue.owns(lease, client)) throw new Error('memory_lease_lost');
      if (client) await queue.finish(lease, accepted ? processed : lease.processed, accepted && complete, client);
    };
    if (!profile.enabled || profile.memory_summary_mode === 'edited' || (input.expectedRevision !== undefined && (profile.memory_revision ?? 0) !== input.expectedRevision)) {
      await finish(false); return { memories: 0, profileClaims: 0 };
    }
    const sources = new Map(input.project.messages.filter(message => message.role === 'user' && message.context_eligible && !message.error
      && (!profile.memory_cutoff_at || message.created_at > profile.memory_cutoff_at)).map(message => [message.message_id, message]));
    if (client) {
      // Hold the project lock until the facts and cursor commit, so editing/deletion cannot race validation.
      const project = await client.query('SELECT 1 FROM projects WHERE project_id=$1 AND owner_id=$2 FOR SHARE', [input.project.project_id, input.ownerId]);
      if (!project.rowCount) throw new Error('memory_source_changed');
      const rows = await client.query<{ payload: Message }>('SELECT payload FROM project_messages WHERE project_id=$1 AND message_id=ANY($2::text[])', [input.project.project_id, [...sources.keys()]]);
      if (rows.rows.length !== sources.size || rows.rows.some(({ payload }) => payload.role !== 'user' || !payload.context_eligible || payload.error || memoryMessageRevision(payload) !== memoryMessageRevision(sources.get(payload.message_id)!))) throw new Error('memory_source_changed');
    } else {
      const latest = await input.store.loadProject(input.project.project_id, input.ownerId);
      if (!latest || [...sources.values()].some(source => !latest.messages.some(row => row.message_id === source.message_id
        && row.role === 'user' && row.context_eligible && !row.error && memoryMessageRevision(row) === memoryMessageRevision(source)))) throw new Error('memory_source_changed');
    }
    const valid = (row: { source_message_id: string; evidence: string }, ...values: string[]) => {
      const source = sources.get(row.source_message_id);
      return source && source.content.includes(row.evidence) && !containsSensitiveMemory(source.content, row.evidence, ...values);
    };
    let savedMemories = 0, savedClaims = 0;
    const versions = profile.memory_fact_versions ??= {};
    const newer = (kind: string, key: string, date: string) => (versions[kind + ':' + key] ?? '') <= date;
    for (const row of input.output.retractions ?? []) {
      if (!valid(row, row.key)) continue;
      const date = sources.get(row.source_message_id)!.created_at;
      if (!newer(row.kind, row.key, date)) continue;
      versions[row.kind + ':' + row.key] = date;
      if (row.kind === 'memory') state.memories = state.memories.filter(memory => memory.key !== row.key || (memory.sourceCreatedAt ?? memory.createdAt) > date);
      else profile.inferred = profile.inferred.filter(claim => claim.claim_id !== row.key || claim.observed_at > date);
    }
    for (const row of input.output.memories) {
      if (row.confidence < 0.65 || !valid(row, row.key, row.value)) continue;
      const old = state.memories.find(memory => memory.key === row.key), timestamp = nowIso();
      const sourceCreatedAt = sources.get(row.source_message_id)!.created_at;
      if (!newer('memory', row.key, sourceCreatedAt)) continue;
      if (old && (old.sourceCreatedAt ?? old.createdAt) > sourceCreatedAt) continue;
      versions['memory:' + row.key] = sourceCreatedAt;
      state.memories = state.memories.filter(memory => memory.key !== row.key);
      state.memories.push({ memoryId: memoryId(input.ownerId, row.key), ownerId: input.ownerId, scope: 'user', key: row.key,
        value: row.value, confidence: row.confidence, sourceMessageIds: [row.source_message_id], sourceCreatedAt, createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp });
      savedMemories++;
    }
    for (const row of input.output.profile_claims) {
      if (row.confidence < 0.65 || !valid(row, row.claim)) continue;
      const id = profileClaimId(row.claim, row.evidence, input.project.project_id);
      const date = sources.get(row.source_message_id)!.created_at;
      if (!newer('claim', id, date)) continue;
      if (profile.inferred.some(claim => row.supersedes?.includes(claim.claim_id) && claim.observed_at > sources.get(row.source_message_id)!.created_at)) continue;
      profile.inferred = profile.inferred.filter(claim => claim.claim_id !== id && !row.supersedes?.includes(claim.claim_id));
      for (const key of row.supersedes ?? []) versions['claim:' + key] = date;
      profile.inferred.push({ claim_id: id, claim: row.claim, confidence: row.confidence, evidence: row.evidence,
        observed_at: sources.get(row.source_message_id)!.created_at, source_project_id: input.project.project_id, source_message_id: row.source_message_id });
      savedClaims++;
    }
    profile.inferred = profile.inferred.slice(-50);
    // Informational only; scheduling uses per-project message revisions.
    profile.last_inferred_message_id = [...sources.keys()].at(-1) ?? profile.last_inferred_message_id;
    profile.memory_summary = generateMemorySummary(profile, state.memories);
    profile.memory_summary_updated_at = nowIso();
    await finish(true);
    invalidateMemory(profile);
    accepted = true;
    return { memories: savedMemories, profileClaims: savedClaims };
  });
  if (input.work && !(input.store instanceof PostgresStore)) {
    const { queue, lease, processed, complete } = input.work;
    await queue.finish(lease, accepted ? processed : lease.processed, accepted && complete);
  }
  return applied;
}

/** Durable, coalesced platform work. Jobs never contain provider credentials. */
export class MemoryMaintenance {
  readonly queue: MemoryWorkQueue;
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  constructor(private readonly store: ProductStore, private readonly memories: PiMemoryRepository,
    private readonly runtime?: (ownerId: string, taskId: string) => Promise<PiModelRuntime | undefined>) {
    this.queue = new MemoryWorkQueue(store.root, store instanceof PostgresStore ? store.pool : undefined);
  }
  async schedule(input: { ownerId: string; projectId: string; modelRuntime?: PiModelRuntime }): Promise<void> {
    // Never retain request-scoped BYOK credentials.
    if (this.store instanceof PostgresStore) return; // Message persistence already wrote the transactional outbox.
    await this.queue.enqueue(input.ownerId, input.projectId);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runPending(); }, 15_000); this.timer.unref();
    void this.runPending();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.abort.abort(); await this.running; }
  async runPending(runtimeOverride?: PiModelRuntime): Promise<void> {
    if (this.running || this.abort.signal.aborted) return this.running;
    this.running = this.drain(runtimeOverride).catch(() => { console.warn('memory_queue_poll_failed'); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async drain(runtimeOverride?: PiModelRuntime): Promise<void> {
    for (let i = 0; i < 8 && !this.abort.signal.aborted; i++) {
      const work = await this.queue.claim(); if (!work) return;
      try { await this.run(work, runtimeOverride); }
      catch {
        await this.queue.fail(work);
        const traceId = 'memory-failed:' + randomUUID();
        await this.store.saveTrace(traceId, { trace_id: traceId, owner_id: work.ownerId, project_id: work.projectId,
          worker: 'memory-profile-maintenance', stop_reason: 'memory_extraction_failed', updated: false, created_at: nowIso() });
      }
    }
  }
  private async run(work: MemoryWork, override?: PiModelRuntime): Promise<void> {
    const project = await this.store.loadProject(work.projectId, work.ownerId);
    if (!project) { await this.queue.finish(work, {}, true); return; }
    const { profile, memories } = await readLearner(this.store, this.memories, work.ownerId);
    const eligible = project.messages.filter(message => message.role === 'user' && message.context_eligible && !message.error
      && (!profile.memory_cutoff_at || message.created_at > profile.memory_cutoff_at));
    const processed = Object.fromEntries(eligible.filter(message => work.processed[message.message_id] === memoryMessageRevision(message))
      .map(message => [message.message_id, memoryMessageRevision(message)]));
    const pending = eligible.filter(message => processed[message.message_id] !== memoryMessageRevision(message));
    if (!profile.enabled || profile.memory_summary_mode === 'edited') { await this.queue.finish(work, processed, true); return; }
    let bytes = 0;
    const batch: Message[] = [];
    for (const message of pending) {
      if (batch.length && (batch.length >= 3 || bytes + message.content.length > 24_000)) break;
      batch.push(message); bytes += message.content.length;
    }
    if (!batch.length) { await this.queue.finish(work, processed, true); return; }
    const runtime = override ?? await this.runtime?.(work.ownerId, 'memory:' + work.projectId);
    if (!runtime || runtime.attribution?.payer === 'user') throw new Error('memory_platform_runtime_unavailable');
    const result = await runStructuredWorker({
      skillId: 'memory-maintenance', inputSchemaId: 'memory-maintenance-input-v1', outputSchemaId: 'memory-maintenance-output-v2',
      contextBuilderId: 'memory-maintenance-context-v3', modelRuntime: runtime, thinkingLevel: 'low',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]), schema: MEMORY_RESULT,
      systemPrompt: 'Extract only sourced stable user facts. Reuse existing keys; explicit replacements and retractions outrank older facts. Never persist secrets. Call submit_result.',
      userPrompt: JSON.stringify({ existing_profile: { ...profile, memory_fact_versions: undefined }, existing_memories: memories.map(row => ({ key: row.key, value: row.value, confidence: row.confidence, source_created_at: row.sourceCreatedAt })),
        recent_messages: batch.map(message => ({ message_id: message.message_id, created_at: message.created_at, role: 'user',
          content: containsSensitiveMemory(message.content) ? '[Sensitive message omitted; do not extract facts from it.]' : message.content })) }),
    });
    if (!result.value) throw new Error('memory_extraction_failed');
    const latest = await this.store.loadProject(work.projectId, work.ownerId);
    if (!latest || batch.some(message => !latest.messages.some(row => row.message_id === message.message_id
      && row.context_eligible && !row.error && memoryMessageRevision(row) === memoryMessageRevision(message)))) throw new Error('memory_source_changed');
    for (const message of batch) processed[message.message_id] = memoryMessageRevision(message);
    const applied = await applyMemoryOutput({ ownerId: work.ownerId, project: { ...project, messages: batch }, output: result.value,
      store: this.store, memories: this.memories, expectedRevision: profile.memory_revision ?? 0,
      work: { queue: this.queue, lease: work, processed, complete: batch.length === pending.length },
    });
    const traceId = 'memory:' + randomUUID();
    await this.store.saveTrace(traceId, { trace_id: traceId, owner_id: work.ownerId, project_id: work.projectId,
      worker: 'memory-profile-maintenance', model: result.model, provider: result.provider, stop_reason: result.stopReason,
      memories_updated: applied.memories, profile_claims_updated: applied.profileClaims, usage: result.usage, created_at: nowIso() });
  }
}
