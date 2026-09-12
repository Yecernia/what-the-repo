import { Pool, type QueryResult, type QueryResultRow } from "pg";
import type {
  EvolutionTask,
  OperationLedger,
  ReviewDecision,
  SkillCandidate,
} from "./contracts.js";
import type {
  FeedbackEvolutionRequest,
  FeedbackEvolutionRequestStore,
} from "./feedback-queue.js";
import { validateFeedbackEvolutionRequest } from "./feedback-queue.js";
import { stableJson } from "./integrity.js";
import {
  type EvolutionStateJournal,
  validateCandidate,
  validateDecision,
  validateLedger,
  validateTask,
} from "./state-store.js";

interface SqlClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** PostgreSQL authority shared by the product feedback lane and Pi worker. */
export class PostgresEvolutionPersistence
implements EvolutionStateJournal, FeedbackEvolutionRequestStore {
  private constructor(
    private readonly db: SqlClient,
    private readonly closeDatabase?: () => Promise<void>,
  ) {}

  static connect(databaseUrl: string, maxConnections = 4): PostgresEvolutionPersistence {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "what-the-repo:evolution-worker",
      max: Math.max(1, Math.min(16, Math.floor(maxConnections))),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    return new PostgresEvolutionPersistence(pool, async () => { await pool.end(); });
  }

  /** Test/custom-composition entry that does not take ownership of the client. */
  static fromClient(db: SqlClient): PostgresEvolutionPersistence {
    return new PostgresEvolutionPersistence(db);
  }

  async hasTask(taskId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM evolution_tasks WHERE task_id = $1",
      [taskId],
    );
    return Boolean(result.rowCount);
  }

  async listTaskIds(status?: OperationLedger["status"]): Promise<string[]> {
    const result = status
      ? await this.db.query<{ task_id: string }>(
          "SELECT task_id FROM evolution_tasks WHERE status = $1 ORDER BY created_at, task_id",
          [status],
        )
      : await this.db.query<{ task_id: string }>(
          "SELECT task_id FROM evolution_tasks ORDER BY created_at, task_id",
        );
    return result.rows.map((row) => row.task_id);
  }

  async create(task: EvolutionTask, ledger: OperationLedger): Promise<void> {
    const checkedTask = validateTask(structuredClone(task));
    const checkedLedger = validateLedger(structuredClone(ledger));
    const result = await this.db.query(
      `INSERT INTO evolution_tasks(
         task_id, skill_id, trigger, status, task_payload, ledger_payload,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8::timestamptz)
       ON CONFLICT(task_id) DO NOTHING`,
      [
        checkedTask.taskId,
        checkedTask.skillId,
        checkedTask.trigger,
        checkedLedger.status,
        JSON.stringify(checkedTask),
        JSON.stringify(checkedLedger),
        checkedLedger.createdAt,
        checkedLedger.updatedAt,
      ],
    );
    if (result.rowCount) return;
    const [existingTask, existingLedger] = await Promise.all([
      this.loadTask(checkedTask.taskId),
      this.loadLedger(checkedTask.taskId),
    ]);
    if (!existingTask || !existingLedger
      || stableJson(existingTask) !== stableJson(checkedTask)
      || stableJson(existingLedger) !== stableJson(checkedLedger)) {
      throw new Error("existing PostgreSQL EvolutionTask does not match the requested task");
    }
  }

  async saveLedger(ledger: OperationLedger): Promise<void> {
    const checked = validateLedger(structuredClone(ledger));
    const result = await this.db.query(
      `UPDATE evolution_tasks
       SET status = $2, ledger_payload = $3::jsonb, updated_at = $4::timestamptz
       WHERE task_id = $1`,
      [checked.taskId, checked.status, JSON.stringify(checked), checked.updatedAt],
    );
    if (!result.rowCount) throw new Error("PostgreSQL EvolutionTask is missing");
  }

  async loadTask(taskId: string): Promise<EvolutionTask | null> {
    const result = await this.db.query<{ task_payload: unknown }>(
      "SELECT task_payload FROM evolution_tasks WHERE task_id = $1",
      [taskId],
    );
    return result.rows[0]
      ? validateTask(jsonValue(result.rows[0].task_payload))
      : null;
  }

  async loadLedger(taskId: string): Promise<OperationLedger | null> {
    const result = await this.db.query<{ ledger_payload: unknown }>(
      "SELECT ledger_payload FROM evolution_tasks WHERE task_id = $1",
      [taskId],
    );
    return result.rows[0]
      ? validateLedger(jsonValue(result.rows[0].ledger_payload))
      : null;
  }

  async saveCandidate(candidate: SkillCandidate): Promise<void> {
    const checked = validateCandidate(structuredClone(candidate));
    const result = await this.db.query(
      `UPDATE evolution_tasks
       SET candidate_payload = $2::jsonb, updated_at = now()
       WHERE task_id = $1`,
      [checked.taskId, JSON.stringify(checked)],
    );
    if (!result.rowCount) throw new Error("PostgreSQL EvolutionTask is missing");
  }

  async loadCandidate(taskId: string): Promise<SkillCandidate | null> {
    const result = await this.db.query<{ candidate_payload: unknown | null }>(
      "SELECT candidate_payload FROM evolution_tasks WHERE task_id = $1",
      [taskId],
    );
    const payload = result.rows[0]?.candidate_payload;
    return payload ? validateCandidate(jsonValue(payload)) : null;
  }

  async claimReviewDecision(decision: ReviewDecision): Promise<void> {
    const checked = validateDecision(structuredClone(decision));
    const result = await this.db.query(
      `UPDATE evolution_tasks
       SET review_decision_payload = $2::jsonb, updated_at = now()
       WHERE task_id = $1 AND review_decision_payload IS NULL`,
      [checked.taskId, JSON.stringify(checked)],
    );
    if (!result.rowCount) throw new Error("a review decision has already been recorded or the task is missing");
  }

  async loadReviewDecision(taskId: string): Promise<ReviewDecision | null> {
    const result = await this.db.query<{ review_decision_payload: unknown | null }>(
      "SELECT review_decision_payload FROM evolution_tasks WHERE task_id = $1",
      [taskId],
    );
    const payload = result.rows[0]?.review_decision_payload;
    return payload ? validateDecision(jsonValue(payload)) : null;
  }

  async list(requestIds: string[] | undefined, limit: number): Promise<FeedbackEvolutionRequest[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = requestIds?.length
      ? await this.db.query<{ payload: unknown }>(
          `SELECT payload FROM evolution_feedback_requests
           WHERE request_id = ANY($1::text[]) AND status IN ('pending', 'task_created')
           ORDER BY created_at, request_id LIMIT $2`,
          [requestIds, boundedLimit],
        )
      : await this.db.query<{ payload: unknown }>(
          `SELECT payload FROM evolution_feedback_requests
           WHERE status = 'pending'
           ORDER BY created_at, request_id LIMIT $1`,
          [boundedLimit],
        );
    return result.rows.map((row) => validateFeedbackEvolutionRequest(jsonValue(row.payload)));
  }

  async save(request: FeedbackEvolutionRequest): Promise<void> {
    const checked = validateFeedbackEvolutionRequest(structuredClone(request));
    const result = await this.db.query(
      `UPDATE evolution_feedback_requests
       SET dedupe_key = $2, status = $3, updated_at = $4::timestamptz, payload = $5::jsonb
       WHERE request_id = $1`,
      [
        checked.request_id,
        checked.dedupe_key,
        checked.status,
        checked.updated_at,
        JSON.stringify(checked),
      ],
    );
    if (!result.rowCount) throw new Error("PostgreSQL evolution feedback request is missing");
  }

  async close(): Promise<void> {
    await this.closeDatabase?.();
  }
}
