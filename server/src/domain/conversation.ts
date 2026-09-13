import { createHash, randomUUID } from "node:crypto";
import type { SnapshotLearningStep } from "./snapshot.js";
import type { RepositoryMigrationAction } from "./lifecycle.js";
import { isProviderPreset, type ProviderPreset } from "../agent/provider-catalog.js";
import { sanitizeMemorySummary } from "../agent/memory-summary.js";

export type MessageRole = "user" | "assistant" | "system";
export type RepoSourceKind = "github" | "local" | "fixture";
export type AnalysisStage = "idle" | "fetching" | "scanning" | "extracting" | "clustering" | "interpreting" | "done" | "failed";
export type AnalysisProgressKind =
  | "researching_project" | "parsing_source" | "resolving_relations" | "building_fact_graph"
  | "explaining_components" | "repairing_components" | "planning_architecture" | "discovering_values"
  | "assembling_architecture" | "merging_analysis" | "preparing_source" | "validating_analysis"
  | "publishing_analysis" | "translating_components" | "translating_layers" | "translating_relations"
  | "translating_values" | "publishing_translation" | "cancelled"
  | "checking_existing"
  | "confirming_upstream"
  | "reusing_snapshot"
  | "fetching_source"
  | "comparing_versions"
  | "full_analysis"
  | "incremental_analysis"
  | "scanning"
  | "interpreting"
  | "completed"
  | "failed";
export type AnalysisStrategy = "reuse" | "full" | "incremental" | null;
export type TeachingPhase = "orienting" | "proposing" | "explaining" | "assessing" | "remediating" | "completed";
export type LearningActionKind =
  | "start_learning_route"
  | "advance_learning_step"
  | "switch_learning_target"
  | "stop_guided_learning";
export type LearningTargetKind = "repository" | "value_point" | "component" | "layer" | "learning_step";
export type LearningActionStatus = "pending" | "confirmed" | "declined" | "executed" | "expired" | "failed";

/** Database owner used for deployment-funded repository analysis calls. */
export const REPOSITORY_ANALYSIS_OWNER_ID = "system:repository-analysis";

export interface LearningActionTarget {
  kind: LearningTargetKind;
  stable_id: string | null;
  label: string;
}

export interface LearningActionProgress {
  mastered_items: string[];
  evidence_ids: string[];
}

export interface LearningActionCard {
  action_id: string;
  action: LearningActionKind;
  target: LearningActionTarget | null;
  title: string;
  description: string;
  request: string;
  snapshot_id: string;
  status: LearningActionStatus;
  /** True when the user explicitly chose to advance without passing this step's understanding check. */
  skip_understanding_check?: boolean;
  progress: LearningActionProgress | null;
  created_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  error: string | null;
}

export interface EvidenceRef {
  stable_id: string;
  label: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  kind: string;
  snapshot_id?: string | null;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export type MessageFeedbackVote = "up" | "down";

export interface FeedbackSignal {
  sentiment: "positive" | "negative" | "mixed" | "neutral";
  strengths: string[];
  issues: string[];
  skill_hypotheses: string[];
  confidence: number;
  source: "button" | "language";
  observed_at: string;
}

export interface MessageFeedback {
  /** Null means the signal came from natural language, not a button vote. */
  vote: MessageFeedbackVote | null;
  updated_at: string;
  signal?: FeedbackSignal | null;
}

export interface MessageThinkingSummaryEvent {
  sequence: number;
  timestamp: string;
  kind: "summary";
  stage: string;
  label: string;
  status: "running" | "completed" | "failed" | "cancelled" | "paused";
  elapsed_ms: number;
}

export interface Message {
  message_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  evidence: EvidenceRef[];
  model: string | null;
  usage: TokenUsage | null;
  latency_ms: number | null;
  error: string | null;
  placeholder: boolean;
  analysis_snapshot_id: string | null;
  analysis_commit_sha?: string | null;
  context_eligible: boolean;
  /** References with no unique confirmed link; existence may still be established. */
  unresolved_references?: string[];
  feedback?: MessageFeedback | null;
  trace_id?: string | null;
  /** Bounded, user-visible run summaries. Raw provider thinking is never stored here. */
  thinking_summary?: MessageThinkingSummaryEvent[] | null;
  learning_action?: LearningActionCard | null;
}

export interface RepoSource {
  kind: RepoSourceKind;
  value: string;
  commit_sha: string | null;
  display_name: string;
}

export interface AnalysisState {
  removed_by_admin?: boolean;
  stage: AnalysisStage;
  snapshot_id: string | null;
  file_count: number;
  symbol_count: number;
  call_count: number;
  languages: string[];
  error: string | null;
  canonical_snapshot_key: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** Bounded, server-authored progress history. Older projects may omit it. */
  progress_events?: AnalysisProgressEvent[];
  /** The server's final reuse/full/incremental decision for this run. */
  strategy?: AnalysisStrategy;
}

export interface AnalysisProgressEvent {
  sequence: number;
  kind: AnalysisProgressKind;
  status: "running" | "completed" | "failed" | "cancelled" | "skipped" | "degraded" | "reused";
  /** Job/attempt/stage identity; concurrent stages are updated independently. */
  instance_id?: string;
  completed_batches?: number;
  total_batches?: number;
  reused_batches?: number;
  timestamp: string;
  elapsed_ms: number;
}

export const MAX_ANALYSIS_PROGRESS_EVENTS = 32;

export interface StudyState {
  phase: TeachingPhase;
  selected_value_point: string | null;
  current_step: number;
  total_steps: number;
  mastered: string[];
  /** Stable step ids the user explicitly chose to skip rather than mark as mastered. */
  skipped_steps?: string[];
  misconceptions: string[];
  open_questions: string[];
  used_evidence: string[];
  /** User-specific route generated only after an explicit learning request. */
  dynamic_learning_plan?: SnapshotLearningStep[];
}

export interface Project {
  project_id: string;
  owner_id: string;
  title: string;
  source: RepoSource;
  /** BCP-47-ish language used for user-visible semantic labels and explanations. */
  display_language?: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  analysis: AnalysisState;
  study: StudyState;
  repository_migration?: RepositoryMigrationAction | null;
  model_override: string | null;
}

export interface ProfileClaim {
  claim_id: string;
  claim: string;
  confidence: number;
  evidence: string;
  observed_at: string;
  source_project_id: string | null;
}

export interface LearnerProfile {
  enabled: boolean;
  languages: string[];
  goals: string[];
  explanation_preference: string;
  experience_level: string;
  inferred: ProfileClaim[];
  last_inferred_message_id: string | null;
  updated_at: string;
  /** User-facing projection; structured fields and evidence remain authoritative. */
  memory_summary: string;
  memory_summary_mode: "generated" | "edited";
  memory_summary_updated_at: string | null;
}

export type { ProviderPreset } from "../agent/provider-catalog.js";

export type ThinkingLevelPreference = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderConnectionSettings {
  connection_id: string;
  provider: ProviderPreset;
  label: string;
  base_url: string | null;
  custom_models: string[];
  /** Accepted from upstream discovery, or a mix including verified chat probes. */
  models_source?: "provider" | "verified" | null;
  manually_verified_models?: string[];
  last_verified_at: string | null;
  verify_error: string | null;
}

export interface ProviderSettings {
  model: string;
  thinking_level: ThinkingLevelPreference;
  connections: ProviderConnectionSettings[];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function emptyAnalysis(): AnalysisState {
  return {
    stage: "idle",
    snapshot_id: null,
    file_count: 0,
    symbol_count: 0,
    call_count: 0,
    languages: [],
    error: null,
    canonical_snapshot_key: null,
    started_at: null,
    completed_at: null,
    progress_events: [],
    strategy: null,
  };
}

/** Record a real server-side analysis transition without growing project JSON forever. */
export function recordAnalysisProgress(
  analysis: AnalysisState,
  kind: AnalysisProgressKind,
  status: AnalysisProgressEvent["status"],
  timestamp = nowIso(),
  detail: Pick<AnalysisProgressEvent, "instance_id" | "completed_batches" | "total_batches" | "reused_batches"> = {},
): void {
  const events = Array.isArray(analysis.progress_events) ? analysis.progress_events : [];
  const elapsed = analysis.started_at
    ? Math.max(0, Date.parse(timestamp) - Date.parse(analysis.started_at))
    : 0;
  const last = events.at(-1);
  if (detail.instance_id) {
    const existing = events.find(event => event.instance_id === detail.instance_id);
    if (existing) Object.assign(existing, detail, { status, timestamp, elapsed_ms: elapsed });
    else events.push({ sequence: (last?.sequence ?? 0) + 1, kind, status, timestamp, elapsed_ms: elapsed, ...detail });
    analysis.progress_events = events.slice(-MAX_ANALYSIS_PROGRESS_EVENTS);
    return;
  }
  // Terminal transitions also settle parallel stages, without rewriting branches
  // that already finished or silently calling interrupted work successful.
  if (kind === "completed" || kind === "failed" || kind === "cancelled") {
    for (const event of events.filter(event => event.instance_id && event.status === "running")) {
      event.status = kind === "completed"
        ? event.kind.startsWith("publishing_") ? status : "cancelled"
        : kind;
      event.timestamp = timestamp;
      event.elapsed_ms = elapsed;
    }
  }
  // Coarse interpreting events remain supported for old workers/projects. A
  // detailed run must not gain a phantom "architecture generation" completion.
  if (kind === "interpreting" && status !== "running" && events.some(event => event.instance_id)) {
    for (const event of events.filter(event => event.kind === kind && event.status === "running")) {
      Object.assign(event, { status, timestamp, elapsed_ms: elapsed });
    }
    return;
  }
  // A new server-authored phase closes the previous running phase. This keeps
  // polling/recovery deterministic even when a worker resumes between writes.
  if (last && !last.instance_id && last.status === "running" && last.kind !== kind) {
    last.status = status === "failed" || status === "cancelled" ? status : "completed";
    last.timestamp = timestamp;
    last.elapsed_ms = elapsed;
    if (status === "failed" && kind === "failed") {
      analysis.progress_events = events.slice(-MAX_ANALYSIS_PROGRESS_EVENTS);
      return;
    }
  }
  if (last?.kind === kind && last.status === "running" && status !== "running") {
    last.status = status;
    last.timestamp = timestamp;
    last.elapsed_ms = elapsed;
  } else if (last?.kind === kind && last.status === status) {
    last.timestamp = timestamp;
    last.elapsed_ms = elapsed;
  } else {
    events.push({
      sequence: (last?.sequence ?? 0) + 1,
      kind,
      status,
      timestamp,
      elapsed_ms: elapsed,
    });
  }
  analysis.progress_events = events.slice(-MAX_ANALYSIS_PROGRESS_EVENTS);
}

export function setAnalysisStrategy(analysis: AnalysisState, strategy: Exclude<AnalysisStrategy, null>): void {
  analysis.strategy = strategy;
}

export function emptyStudy(): StudyState {
  return {
    phase: "orienting",
    selected_value_point: null,
    current_step: 0,
    total_steps: 0,
    mastered: [],
    skipped_steps: [],
    misconceptions: [],
    open_questions: [],
    used_evidence: [],
    dynamic_learning_plan: [],
  };
}

export function emptyProfile(): LearnerProfile {
  return {
    enabled: true,
    languages: [],
    goals: [],
    explanation_preference: "",
    experience_level: "",
    inferred: [],
    last_inferred_message_id: null,
    updated_at: nowIso(),
    memory_summary: "",
    memory_summary_mode: "generated",
    memory_summary_updated_at: null,
  };
}

export function normalizeProfile(value: unknown): LearnerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyProfile();
  const row = value as Record<string, unknown>;
  const fallback = emptyProfile();
  const inferred = Array.isArray(row.inferred)
    ? row.inferred.filter((item): item is ProfileClaim => Boolean(
      item && typeof item === "object" && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).claim_id === "string"
      && typeof (item as Record<string, unknown>).claim === "string",
    )).slice(-200)
    : [];
  const memorySummary = typeof row.memory_summary === "string"
    ? sanitizeMemorySummary(row.memory_summary)
    : "";
  const mode = row.memory_summary_mode === "edited" && memorySummary ? "edited" : "generated";
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : fallback.enabled,
    languages: Array.isArray(row.languages)
      ? row.languages.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [],
    goals: Array.isArray(row.goals)
      ? row.goals.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [],
    explanation_preference: typeof row.explanation_preference === "string" ? row.explanation_preference.slice(0, 500) : "",
    experience_level: typeof row.experience_level === "string" ? row.experience_level.slice(0, 100) : "",
    inferred,
    last_inferred_message_id: typeof row.last_inferred_message_id === "string" ? row.last_inferred_message_id : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : fallback.updated_at,
    memory_summary: memorySummary,
    memory_summary_mode: mode,
    memory_summary_updated_at: typeof row.memory_summary_updated_at === "string" ? row.memory_summary_updated_at : null,
  };
}

export function emptySettings(): ProviderSettings {
  return {
    model: "",
    thinking_level: "medium",
    connections: [],
  };
}

export function normalizeSettings(value: unknown): ProviderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptySettings();
  const row = value as Record<string, unknown>;
  const validThinking = new Set<ThinkingLevelPreference>([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
  const thinking = validThinking.has(row.thinking_level as ThinkingLevelPreference)
    ? row.thinking_level as ThinkingLevelPreference
    : "medium";
  const rawConnections = Array.isArray(row.connections) ? row.connections : [];
  const connections = rawConnections.flatMap((candidate): ProviderConnectionSettings[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const provider = String(item.provider ?? "custom") as ProviderPreset;
    if (!isProviderPreset(provider)) return [];
    const connectionId = String(item.connection_id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(connectionId)) return [];
    return [{
      connection_id: connectionId,
      provider,
      label: String(item.label ?? provider).trim().slice(0, 80) || provider,
      // Built-in provider endpoints are selected by the server preset. Ignore
      // historical overrides so an old settings row cannot redirect a user's
      // API key to an arbitrary endpoint.
      base_url: provider === "custom"
        ? typeof item.base_url === "string" && item.base_url.trim()
          ? item.base_url.trim().replace(/\/+$/, "")
          : null
        : null,
      custom_models: Array.isArray(item.custom_models)
        ? item.custom_models.map(String).map((model) => model.trim()).filter(Boolean).slice(0, 100)
        : [],
      manually_verified_models: Array.isArray(item.manually_verified_models)
        ? item.manually_verified_models.filter((model): model is string => typeof model === "string" && Array.isArray(item.custom_models) && item.custom_models.includes(model)).slice(0, 100)
        : [],
      models_source: item.models_source === "provider" || item.models_source === "verified"
        ? item.models_source
        : null,
      last_verified_at: typeof item.last_verified_at === "string" ? item.last_verified_at : null,
      verify_error: typeof item.verify_error === "string" ? item.verify_error : null,
    }];
  });
  if (!connections.length && typeof row.base_url === "string" && row.base_url.trim()) {
    const legacyModel = typeof row.model === "string" ? row.model.trim() : "";
    connections.push({
      connection_id: "legacy",
      provider: "custom",
      label: "原有自定义接口",
      base_url: row.base_url.trim().replace(/\/+$/, ""),
      custom_models: legacyModel ? [legacyModel] : [],
      models_source: null,
      last_verified_at: typeof row.last_verified_at === "string" ? row.last_verified_at : null,
      verify_error: typeof row.verify_error === "string" ? row.verify_error : null,
    });
  }
  return {
    model: typeof row.model === "string" ? row.model.trim().slice(0, 500) : "",
    thinking_level: thinking,
    connections,
  };
}

export function createProject(
  ownerId: string,
  sourceValue: string,
  title: string,
  model: string | null = null,
  displayLanguage = "zh-CN",
): Project {
  const created = nowIso();
  const projectId = randomUUID().replaceAll("-", "").slice(0, 12);
  const source: RepoSource = {
    kind: "github",
    value: sourceValue,
    commit_sha: null,
    display_name: displayNameFromGithub(sourceValue),
  };
  return {
    project_id: projectId,
    owner_id: ownerId,
    title: title.trim() || source.display_name,
    source,
    display_language: displayLanguage,
    created_at: created,
    updated_at: created,
    messages: [],
    analysis: emptyAnalysis(),
    study: emptyStudy(),
    repository_migration: null,
    model_override: model || null,
  };
}

export function displayNameFromGithub(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : value;
  } catch {
    return value;
  }
}

export function createMessage(role: MessageRole, content: string, extra: Partial<Message> = {}): Message {
  return {
    message_id: randomUUID().replaceAll("-", "").slice(0, 16),
    role,
    content,
    created_at: nowIso(),
    evidence: [],
    model: null,
    usage: null,
    latency_ms: null,
    error: null,
    placeholder: false,
    analysis_snapshot_id: null,
    analysis_commit_sha: null,
    context_eligible: role !== "system",
    feedback: null,
    trace_id: null,
    thinking_summary: null,
    learning_action: null,
    ...extra,
  };
}

export function profileClaimId(claim: string, evidence: string, projectId: string | null): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ claim, evidence, projectId }))
    .digest("hex")
    .slice(0, 24);
  return `profile-claim:${digest}`;
}

export function personalizeProfile(profile: LearnerProfile): LearnerProfile {
  return profile.enabled
    ? structuredClone(profile)
    : { ...structuredClone(profile), languages: [], goals: [], explanation_preference: "", experience_level: "", inferred: [] };
}

export function markAnalysisComplete(project: Project, payload: Record<string, unknown>): void {
  const summary = (payload.summary && typeof payload.summary === "object" ? payload.summary : {}) as Record<string, unknown>;
  const languages = Array.isArray(payload.languages)
    ? payload.languages.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
      .map((row) => String(row.language ?? "")).filter(Boolean)
    : [];
  const timestamp = nowIso();
  project.analysis = {
    ...project.analysis,
    stage: "done",
    snapshot_id: String(payload.snapshot_id ?? ""),
    file_count: Number(summary.file_count ?? 0),
    symbol_count: Number(summary.symbol_count ?? 0),
    call_count: Number(summary.call_count ?? 0),
    languages,
    error: null,
    completed_at: timestamp,
  };
  project.updated_at = timestamp;
}
