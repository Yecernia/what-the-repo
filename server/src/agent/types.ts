import type {
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, FetchFunction, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { ProviderCallGate } from "./provider-gate.js";
import type { ProviderUsageBudget } from "./provider-budget.js";
import type { ProductSkill, ProductSkillId } from "./skill-registry.js";
import type { RuntimeMetrics } from "../observability/metrics.js";

export interface PiSessionIdentity {
  sessionId: string;
  ownerId: string;
  projectId: string;
  snapshotId: string | null;
  skillId: string;
  skillVersion: string;
}

export interface PiMemoryRecord {
  memoryId: string;
  ownerId: string;
  scope: "user" | "project" | "session";
  key: string;
  value: string;
  sourceMessageIds: string[];
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface PiUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export type PiRunDisplayKind = "summary" | "commentary" | "tool" | "answer";
export type PiRunDisplayStatus = "running" | "completed" | "failed" | "cancelled" | "paused";

/** Safe, user-visible metadata derived from a runtime event.
 *
 * This is deliberately separate from provider thinking blocks. The latter can
 * contain hidden chain-of-thought and must never be copied into this shape.
 */
export interface PiRunDisplay {
  kind: PiRunDisplayKind;
  stage: string;
  label: string;
  text?: string;
  toolName?: string;
  status: PiRunDisplayStatus;
  visible: boolean;
}

export interface PiRunEvent {
  runId: string;
  sequence: number;
  timestamp: string;
  type:
    | "capacity_waiting"
    | "run_started"
    | "model_started"
    | "assistant_delta"
    | "tool_call_requested"
    | "tool_result_received"
    | "usage_updated"
    | "run_completed"
    | "run_failed"
    | "run_paused"
    | "run_cancelled"
    | "thinking_started"
    | "thinking_completed"
    | "turn_completed"
    | "answer_started"
    | "assistant_commentary";
  summary: string;
  /** Milliseconds since this run started, when available. */
  elapsedMs?: number;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  usage?: PiUsageSummary;
  text?: string;
  errorCode?: string;
  isError?: boolean;
  display?: PiRunDisplay;
}

export interface PiRunResult {
  runId: string;
  text: string;
  stopReason: string;
  usage: PiUsageSummary;
  events: PiRunEvent[];
}

export type PiSessionCommitMode = "accepted" | "discard";

export interface PiRunFinalization<T> {
  value: T;
  sessionCommit: PiSessionCommitMode;
  /** Canonical answer shown to the user, including citation uncertainty. */
  assistantText?: string;
}

export interface PiModelRuntime {
  roleRuntimes?: Readonly<Partial<Record<ProductSkillId, PiModelRuntime>>>;
  /** Reserve one analysis request before dispatch; the job owns persistence and limits. */
  beforeWorkerRequest?: (identity: import("./worker-diagnostics.js").WorkerDiagnosticIdentity | undefined) => Promise<void>;
  /** Skills selected once for this analysis, shared by identity, budgets and execution. */
  skills?: Readonly<Partial<Record<ProductSkillId, ProductSkill>>>;
  models: Models;
  model: Model<Api>;
  apiKey?: string;
  /** Fetch wrapper used for user-configured provider endpoints. */
  fetch?: FetchFunction;
  networkTimeoutMs?: number;
  providerGate?: ProviderCallGate;
  /** A producer bound; actual grants come from the shared model scheduler. */
  analysisBatchConcurrency?: number;
  providerBudget?: ProviderUsageBudget;
  providerConnectionId?: string;
  attribution?: import('./provider-budget.js').UsageAttribution;
  ownerId?: string;
  metrics?: RuntimeMetrics;
}

export interface PiAgentRunOptions {
  identity: PiSessionIdentity;
  systemPrompt: string;
  userMessage: string;
  modelRuntime: PiModelRuntime;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  runId: string;
  signal?: AbortSignal;
  onEvent?: (event: PiRunEvent) => void;
  /** Visible turn identity; editing rewinds the current Pi branch before this turn. */
  turn?: { messageId: string; replace: boolean; previousMessages: AgentMessage[] };
  beforePrompt?: () => Promise<void>;
}

export interface PersistedPiMessage {
  role: AgentMessage["role"];
  content: unknown;
  timestamp?: number;
  [key: string]: unknown;
}

export type { AgentMessage, AgentTool, Api, Model, Models, ThinkingLevel, Usage };
