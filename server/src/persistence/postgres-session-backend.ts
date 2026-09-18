import type { Pool, PoolClient } from "pg";
import { AsyncLocalStorage } from 'node:async_hooks';
import { CapacityScheduler, PostgresPermitStore, assertSessionPermit, connectWithAbort } from '../scheduling/permits.js';
import {
  Session,
  type AgentMessage,
  type BranchBounds,
  type Entry,
  type EntryQuery,
  type LaneRecord,
  type LogItem,
  type NewRecord,
  type OperationStartedRecord,
  type ProvisionedEntry,
  type RecordQuery,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
} from "@earendil-works/pi-agent-core";
import type { PiSessionBackend, PiSessionBackendOptions } from "../agent/session-store.js";
import type { PiSessionIdentity } from "../agent/types.js";

interface ProductSessionMetadata extends SessionMetadata {
  ownerId: string;
  projectId: string;
  snapshotId: string | null;
  skillId: string;
  skillVersion: string;
}

function object<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function durable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function orderSql(order: "newestFirst" | "oldestFirst" | undefined): string {
  return order === "newestFirst" ? "DESC" : "ASC";
}

class PostgresSessionStorage implements SessionStorage<ProductSessionMetadata> {
  private readonly transactionClient = new AsyncLocalStorage<PoolClient>();
  constructor(private readonly pool: Pool, private readonly sessionId: string, private readonly permitId: string, private readonly signal: AbortSignal) {}
  private get client(): Pool | PoolClient { this.signal.throwIfAborted(); return this.transactionClient.getStore() ?? this.pool; }

  async getMetadata(): Promise<ProductSessionMetadata> {
    const result = await this.client.query<{ metadata: ProductSessionMetadata }>(
      "SELECT metadata FROM pi_sessions WHERE session_id = $1",
      [this.sessionId],
    );
    if (!result.rows[0]) throw new Error("pi_session_not_found");
    return object<ProductSessionMetadata>(result.rows[0].metadata);
  }

  async getLanes(): Promise<Array<{ lane: string; leafId: string | null }>> {
    const lanes = await this.lanes();
    return Object.entries(lanes).map(([lane, leafId]) => ({ lane, leafId }));
  }

  async createLane(lane: string, at: string | null): Promise<void> {
    await this.changeLane(lane, at, true);
  }

  async moveLane(lane: string, to: string | null): Promise<void> {
    await this.changeLane(lane, to, false);
  }

  async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
    return this.transaction(async () => {
      const lanes = await this.lanes();
      if (!(lane in lanes)) throw new Error("invalid session lane");
      const seq = await this.nextSequence();
      const timestamp = Date.now();
      const value = durable({
        ...entry,
        parentId: lanes[lane],
        seq,
        timestamp,
      }) as unknown as TEntry;
      await this.client.query(
        `INSERT INTO pi_session_log(
           session_id, seq, kind, item_id, item_type, lane, timestamp_ms, payload
         ) VALUES ($1, $2, 'entry', $3, $4, $5, $6, $7::jsonb)`,
        [this.sessionId, seq, value.id, value.type, lane, timestamp, JSON.stringify(value)],
      );
      lanes[lane] = value.id;
      await this.saveLanes(lanes);
      return value;
    });
  }

  async appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
    return this.transaction(async () => {
      const seq = await this.nextSequence();
      const timestamp = Date.now();
      const value = durable({ ...record, seq, timestamp }) as unknown as TRecord;
      const operationKind = value.type === "operation_started" ? value.intent.kind : null;
      const runId = "runId" in value && typeof value.runId === "string" ? value.runId : null;
      await this.client.query(
        `INSERT INTO pi_session_log(
           session_id, seq, kind, item_id, item_type, lane, run_id,
           operation_kind, timestamp_ms, payload
         ) VALUES ($1, $2, 'record', $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          this.sessionId,
          seq,
          value.id,
          value.type,
          value.lane,
          runId,
          operationKind,
          timestamp,
          JSON.stringify(value),
        ],
      );
      return value;
    });
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const result = await this.client.query<{ payload: Entry }>(
      "SELECT payload FROM pi_session_log WHERE session_id = $1 AND kind = 'entry' AND item_id = $2 LIMIT 1",
      [this.sessionId, id],
    );
    return result.rows[0] ? object<Entry>(result.rows[0].payload) : undefined;
  }

  async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
    const params: unknown[] = [this.sessionId];
    const where = ["session_id = $1", "kind = 'entry'"];
    if (query.type) {
      params.push(query.type);
      where.push(`item_type = $${params.length}`);
    }
    if (query.customType) {
      params.push(query.customType);
      where.push(`payload->>'customType' = $${params.length}`);
    }
    if (query.cursor) {
      params.push(query.cursor.afterSeq);
      where.push(`seq > $${params.length}`);
    }
    let limit = "";
    if (query.limit !== undefined) {
      params.push(query.limit);
      limit = ` LIMIT $${params.length}`;
    }
    const result = await this.client.query<{ payload: Entry }>(
      `SELECT payload FROM pi_session_log
       WHERE ${where.join(" AND ")}
       ORDER BY seq ${orderSql(query.order)}${limit}`,
      params,
    );
    return result.rows.map((row) => object<Entry>(row.payload));
  }

  async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
    const all = await this.findEntries({ order: "oldestFirst" });
    const byId = new Map(all.map((entry) => [entry.id, entry]));
    const branch: Entry[] = [];
    let current: Entry | undefined = byId.get(query.start);
    while (current) {
      branch.push(current);
      if (query.stopAtId === current.id || query.stopAtType === current.type) break;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let result = branch.reverse().filter((entry) =>
      (!query.type || entry.type === query.type)
      && (!query.customType || (entry.type === "custom" && entry.customType === query.customType))
      && (!query.cursor || entry.seq > query.cursor.afterSeq));
    if (query.order === "newestFirst") result = result.reverse();
    return query.limit === undefined ? result : result.slice(0, query.limit);
  }

  async findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & { type: K },
  ): Promise<Array<Extract<LaneRecord, { type: K }>>>;
  async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
    const params: unknown[] = [this.sessionId];
    const where = ["session_id = $1", "kind = 'record'"];
    if (query.lane) {
      params.push(query.lane);
      where.push(`lane = $${params.length}`);
    }
    if (query.type) {
      params.push(query.type);
      where.push(`item_type = $${params.length}`);
    }
    if (query.runId) {
      params.push(query.runId);
      where.push(`run_id = $${params.length}`);
    }
    if (query.operationKind) {
      params.push(query.operationKind);
      where.push(`operation_kind = $${params.length}`);
    }
    if (query.afterSeq !== undefined) {
      params.push(query.afterSeq);
      where.push(`seq > $${params.length}`);
    }
    let limit = "";
    if (query.limit !== undefined) {
      params.push(query.limit);
      limit = ` LIMIT $${params.length}`;
    }
    const result = await this.client.query<{ payload: LaneRecord }>(
      `SELECT payload FROM pi_session_log
       WHERE ${where.join(" AND ")}
       ORDER BY seq ${orderSql(query.order)}${limit}`,
      params,
    );
    return result.rows.map((row) => object<LaneRecord>(row.payload));
  }

  async findOpenOperations(lane: string, options: { limit?: number } = {}): Promise<OperationStartedRecord[]> {
    const records = await this.findRecords({ lane, order: "oldestFirst" });
    const finished = new Set(records
      .filter((record) => record.type === "operation_finished")
      .map((record) => record.runId));
    const open = records
      .filter((record): record is OperationStartedRecord => record.type === "operation_started")
      .filter((record) => !finished.has(record.id))
      .reverse();
    return options.limit === undefined ? open : open.slice(0, options.limit);
  }

  async getLog(options: { afterSeq?: number; limit?: number } = {}): Promise<LogItem[]> {
    const params: unknown[] = [this.sessionId];
    const where = ["session_id = $1"];
    if (options.afterSeq !== undefined) {
      params.push(options.afterSeq);
      where.push(`seq > $${params.length}`);
    }
    let limit = "";
    if (options.limit !== undefined) {
      params.push(options.limit);
      limit = ` LIMIT $${params.length}`;
    }
    const result = await this.client.query<{ seq: string; kind: string; payload: unknown }>(
      `SELECT seq, kind, payload FROM pi_session_log
       WHERE ${where.join(" AND ")} ORDER BY seq${limit}`,
      params,
    );
    return result.rows.map((row) => {
      const seq = Number(row.seq);
      if (row.kind === "entry") return { kind: "entry", seq, entry: object<Entry>(row.payload) };
      if (row.kind === "record") return { kind: "record", seq, record: object<LaneRecord>(row.payload) };
      if (row.kind === "lane") {
        const lane = object<{ lane: string; leafId: string | null }>(row.payload);
        return { kind: "lane", seq, lane: lane.lane, leafId: lane.leafId };
      }
      const fact = object<{ fact: "name"; name: string } | { fact: "label"; targetId: string; label?: string }>(row.payload);
      return fact.fact === "name"
        ? { kind: "fact", seq, fact: "name", name: fact.name }
        : { kind: "fact", seq, fact: "label", targetId: fact.targetId, label: fact.label };
    });
  }

  async getName(): Promise<string | undefined> {
    const result = await this.client.query<{ name: string | null }>(
      "SELECT name FROM pi_sessions WHERE session_id = $1",
      [this.sessionId],
    );
    return result.rows[0]?.name ?? undefined;
  }

  async setName(name: string): Promise<void> {
    await this.transaction(async () => {
      const seq = await this.nextSequence();
      const timestamp = Date.now();
      await this.client.query("UPDATE pi_sessions SET name = $2, updated_at = now() WHERE session_id = $1", [this.sessionId, name]);
      await this.client.query(
        `INSERT INTO pi_session_log(session_id, seq, kind, item_type, timestamp_ms, payload)
         VALUES ($1, $2, 'fact', 'name', $3, $4::jsonb)`,
        [this.sessionId, seq, timestamp, JSON.stringify({ fact: "name", name })],
      );
    });
  }

  async getLabel(id: string): Promise<string | undefined> {
    const result = await this.client.query<{ labels: Record<string, string> }>(
      "SELECT labels FROM pi_sessions WHERE session_id = $1",
      [this.sessionId],
    );
    return object<Record<string, string>>(result.rows[0]?.labels ?? {})[id];
  }

  async setLabel(id: string, label: string | undefined): Promise<void> {
    await this.transaction(async () => {
      const result = await this.client.query<{ labels: Record<string, string> }>(
        "SELECT labels FROM pi_sessions WHERE session_id = $1 FOR UPDATE",
        [this.sessionId],
      );
      const labels = object<Record<string, string>>(result.rows[0]?.labels ?? {});
      if (label === undefined) delete labels[id];
      else labels[id] = label;
      const seq = await this.nextSequence();
      const timestamp = Date.now();
      await this.client.query("UPDATE pi_sessions SET labels = $2::jsonb, updated_at = now() WHERE session_id = $1", [this.sessionId, JSON.stringify(labels)]);
      await this.client.query(
        `INSERT INTO pi_session_log(session_id, seq, kind, item_id, item_type, timestamp_ms, payload)
         VALUES ($1, $2, 'fact', $3, 'label', $4, $5::jsonb)`,
        [this.sessionId, seq, id, timestamp, JSON.stringify({ fact: "label", targetId: id, label })],
      );
    });
  }

  async getStats(): Promise<SessionStats> {
    const entries = await this.findEntries({ type: "message", order: "oldestFirst" });
    let messageCount = 0;
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let totalTokens = 0;
    let costTotal = 0;
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      messageCount += 1;
      const message = entry.message as AgentMessage & {
        usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number; cost?: { total?: number } };
      };
      if (!message.usage) continue;
      const cached = message.usage.cacheRead ?? 0;
      const total = message.usage.totalTokens ?? (message.usage.input ?? 0) + (message.usage.output ?? 0);
      cachedTokens += cached;
      totalTokens += total;
      uncachedTokens += Math.max(0, total - cached);
      costTotal += message.usage.cost?.total ?? 0;
    }
    return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
  }

  private async lanes(): Promise<Record<string, string | null>> {
    const result = await this.client.query<{ lanes: Record<string, string | null> }>(
      "SELECT lanes FROM pi_sessions WHERE session_id = $1",
      [this.sessionId],
    );
    if (!result.rows[0]) throw new Error("pi_session_not_found");
    return object<Record<string, string | null>>(result.rows[0].lanes);
  }

  private async saveLanes(lanes: Record<string, string | null>): Promise<void> {
    await this.client.query(
      "UPDATE pi_sessions SET lanes = $2::jsonb, updated_at = now() WHERE session_id = $1",
      [this.sessionId, JSON.stringify(lanes)],
    );
  }

  private async changeLane(lane: string, leafId: string | null, create: boolean): Promise<void> {
    await this.transaction(async () => {
      const lanes = await this.lanes();
      if (create ? lane in lanes : !(lane in lanes)) throw new Error("invalid session lane");
      if (leafId && !(await this.getEntry(leafId))) throw new Error("invalid session lane target");
      lanes[lane] = leafId;
      const seq = await this.nextSequence();
      const timestamp = Date.now();
      await this.saveLanes(lanes);
      await this.client.query(
        `INSERT INTO pi_session_log(session_id, seq, kind, item_type, lane, timestamp_ms, payload)
         VALUES ($1, $2, 'lane', 'lane', $3, $4, $5::jsonb)`,
        [this.sessionId, seq, lane, timestamp, JSON.stringify({ lane, leafId })],
      );
    });
  }

  private async nextSequence(): Promise<number> {
    const result = await this.client.query<{ next_seq: string }>(
      "UPDATE pi_sessions SET next_seq = next_seq + 1, updated_at = now() WHERE session_id = $1 RETURNING next_seq",
      [this.sessionId],
    );
    if (!result.rows[0]) throw new Error("pi_session_not_found");
    return Number(result.rows[0].next_seq);
  }

  private async transaction<T>(task: () => Promise<T>): Promise<T> {
    const client = await connectWithAbort<PoolClient>(this.pool, this.signal);
    try {
      await client.query('BEGIN');
      await assertSessionPermit(client, this.permitId);
      const result = await this.transactionClient.run(client, task);
      this.signal.throwIfAborted();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

export class PostgresPiSessionBackend implements PiSessionBackend {
  constructor(private readonly pool: Pool) {}

  async withSession<T>(
    identity: PiSessionIdentity,
    task: (session: Session<SessionMetadata>) => Promise<T>,
    options: PiSessionBackendOptions = {},
  ): Promise<T> {
    const permit = await new CapacityScheduler(new PostgresPermitStore(this.pool), 'session', {
      // Zero queue means conflicting sessions fail fast; SQL admission still needs a bounded RPC deadline.
      running: 1024, waiting: 0, waitMs: 30_000, exclusiveResource: true,
    }).acquire(identity.ownerId, identity.sessionId, options.signal);
    try {
      permit.signal.throwIfAborted();
      options.onAcquired?.();
      permit.signal.throwIfAborted();
      const metadata: ProductSessionMetadata = {
        id: identity.sessionId,
        createdAt: Date.now(),
        ownerId: identity.ownerId,
        projectId: identity.projectId,
        snapshotId: identity.snapshotId,
        skillId: identity.skillId,
        skillVersion: identity.skillVersion,
      };
      const opened = await this.pool.query<{ owner_id: string; project_id: string }>(
        `INSERT INTO pi_sessions(
           session_id, owner_id, project_id, snapshot_id, skill_id, skill_version, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT(session_id) DO UPDATE SET
           snapshot_id = EXCLUDED.snapshot_id,
           skill_id = EXCLUDED.skill_id,
           skill_version = EXCLUDED.skill_version,
           metadata = pi_sessions.metadata || jsonb_build_object(
             'snapshotId', EXCLUDED.snapshot_id,
             'skillId', EXCLUDED.skill_id,
             'skillVersion', EXCLUDED.skill_version
           ),
           updated_at = now()
         WHERE pi_sessions.owner_id = EXCLUDED.owner_id
           AND pi_sessions.project_id = EXCLUDED.project_id
         RETURNING owner_id, project_id`,
        [
          identity.sessionId,
          identity.ownerId,
          identity.projectId,
          identity.snapshotId,
          identity.skillId,
          identity.skillVersion,
          JSON.stringify(metadata),
        ],
      );
      if (!opened.rowCount) throw new Error("pi_session_identity_mismatch");
      const storage = new PostgresSessionStorage(this.pool, identity.sessionId, permit.id, permit.signal);
      return await task(new Session(storage) as unknown as Session<SessionMetadata>);
    } catch (error) {
      if (permit.signal.aborted) throw permit.signal.reason;
      throw error;
    } finally {
      await permit.release();
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM pi_sessions WHERE session_id = $1", [sessionId]);
  }

  async listOwnerSessions(ownerId: string): Promise<Array<{
    sessionId: string;
    projectId: string;
    snapshotId: string | null;
  }>> {
    const result = await this.pool.query<{
      session_id: string;
      project_id: string;
      snapshot_id: string | null;
    }>(
      "SELECT session_id, project_id, snapshot_id FROM pi_sessions WHERE owner_id = $1 ORDER BY created_at",
      [ownerId],
    );
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id,
      snapshotId: row.snapshot_id,
    }));
  }

  async deleteOwner(ownerId: string): Promise<number> {
    const result = await this.pool.query("DELETE FROM pi_sessions WHERE owner_id = $1", [ownerId]);
    return result.rowCount ?? 0;
  }
}
