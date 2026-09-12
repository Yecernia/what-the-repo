import type { AnalysisJob } from "../domain/jobs.js";
import type { Project } from "../domain/conversation.js";
import type {
  ConversationOwner,
  ConversationResult,
  ConversationRunInput,
} from "../services/conversation-service.js";
import type {
  EvidenceQuery,
  StartAnalysisResult,
} from "../services/repository-service.js";
import { serviceError } from "../services/errors.js";

export interface McpRepositoryOperations {
  startAnalysis(input: {
    owner: ConversationOwner;
    projectId?: string | null;
    kind?: string | null;
    value?: string | null;
    title?: string;
    model?: string | null;
  }): Promise<StartAnalysisResult>;
  getAnalysisStatus(ownerId: string, projectId: string): Promise<Record<string, unknown>>;
  listValuePoints(ownerId: string, projectId: string, snapshotId: string): Promise<Record<string, unknown>>;
  queryCodeEvidence(ownerId: string, projectId: string, snapshotId: string, query: EvidenceQuery): Promise<Record<string, unknown>>;
  getLearningPlan(ownerId: string, projectId: string, snapshotId: string, selectedValuePoint?: string | null): Promise<Record<string, unknown>>;
  ensureCurrentSnapshot(ownerId: string, projectId: string, snapshotId: string): Promise<void>;
}

export interface McpConversationOperations {
  run(input: ConversationRunInput): Promise<ConversationResult | null>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class OwnerRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(requestsPerMinute = 60, private readonly clock = () => Date.now()) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 10_000) {
      throw new Error("MCP 每分钟请求数必须在 1-10000 之间");
    }
    this.capacity = requestsPerMinute;
    this.refillPerMs = requestsPerMinute / 60_000;
  }

  consume(ownerId: string): void {
    const now = this.clock();
    const current = this.buckets.get(ownerId);
    if (!current) {
      this.buckets.set(ownerId, { tokens: this.capacity - 1, updatedAt: now });
      return;
    }
    const available = Math.min(
      this.capacity,
      current.tokens + Math.max(0, now - current.updatedAt) * this.refillPerMs,
    );
    current.updatedAt = now;
    if (available < 1) {
      current.tokens = available;
      throw serviceError("rate_limited", "MCP 请求过于频繁，请稍后重试", 429);
    }
    current.tokens = available - 1;
  }
}

export class RepositoryMcpGateway {
  constructor(
    private readonly repository: McpRepositoryOperations,
    private readonly conversation: McpConversationOperations,
    private readonly rateLimiter = new OwnerRateLimiter(),
  ) {}

  async startRepositoryAnalysis(owner: ConversationOwner, input: {
    project_id?: string;
    kind?: "github";
    value?: string;
    title?: string;
    model?: string;
  }): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    const result = await this.repository.startAnalysis({
      owner,
      projectId: input.project_id,
      kind: input.kind,
      value: input.value,
      title: input.title,
      model: input.model,
    });
    return analysisStartPayload(result.project, result.job, result.created);
  }

  async getAnalysisStatus(owner: ConversationOwner, projectId: string): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    return this.repository.getAnalysisStatus(owner.owner_id, projectId);
  }

  async listValuePoints(owner: ConversationOwner, projectId: string, snapshotId: string): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    return this.repository.listValuePoints(owner.owner_id, projectId, snapshotId);
  }

  async queryCodeEvidence(
    owner: ConversationOwner,
    projectId: string,
    snapshotId: string,
    query: EvidenceQuery,
  ): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    return this.repository.queryCodeEvidence(owner.owner_id, projectId, snapshotId, query);
  }

  async getLearningPlan(
    owner: ConversationOwner,
    projectId: string,
    snapshotId: string,
    selectedValuePoint?: string,
  ): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    return this.repository.getLearningPlan(
      owner.owner_id,
      projectId,
      snapshotId,
      selectedValuePoint,
    );
  }

  async explainLearningTopic(
    owner: ConversationOwner,
    projectId: string,
    snapshotId: string,
    content: string,
  ): Promise<Record<string, unknown>> {
    this.begin(owner.owner_id);
    await this.repository.ensureCurrentSnapshot(owner.owner_id, projectId, snapshotId);
    const result = await this.conversation.run({ owner, projectId, content });
    if (!result) throw serviceError("provider_unavailable", "本次未生成可用回答，请稍后重试", 503);
    return {
      project_id: projectId,
      snapshot_id: snapshotId,
      user_message: result.user_message,
      assistant_message: result.assistant_message,
      teaching_phase: result.teaching_phase,
      validation_errors: result.validation_errors,
      tools_used: result.tools_used,
      state_changed: result.state_changed,
    };
  }

  private begin(ownerId: string): void {
    this.rateLimiter.consume(ownerId);
  }
}

function analysisStartPayload(
  project: Project,
  job: AnalysisJob,
  created: boolean,
): Record<string, unknown> {
  return {
    project_id: project.project_id,
    title: project.title,
    created,
    job_id: job.job_id,
    job_status: job.status,
    analysis: project.analysis,
  };
}
