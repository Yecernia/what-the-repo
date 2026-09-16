/* API types matching backend schemas */
import type { DetailedAnalysisStageId } from './analysis-stage-catalog';

export type RepoSourceKind = 'github' | 'local' | 'fixture';
export type AnalysisStage = 'idle' | 'fetching' | 'scanning' | 'extracting' | 'clustering' | 'interpreting' | 'done' | 'failed';
export type AnalysisProgressKind =
  // Detailed analysis stages authored by the server.
  | DetailedAnalysisStageId
  | 'checking_existing'
  | 'confirming_upstream'
  | 'reusing_snapshot'
  | 'fetching_source'
  | 'comparing_versions'
  | 'full_analysis'
  | 'incremental_analysis'
  | 'scanning'
  | 'interpreting'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type AnalysisStrategy = 'reuse' | 'full' | 'incremental' | null;
export type TeachingPhase = 'orienting' | 'proposing' | 'explaining' | 'assessing' | 'remediating' | 'completed';
export type MessageRole = 'user' | 'assistant' | 'system';
export type ConversationSelectionKind = 'component' | 'relation' | 'value_point' | 'learning_step';
export type LearningActionKind =
  | 'start_learning_route'
  | 'advance_learning_step'
  | 'switch_learning_target'
  | 'stop_guided_learning';
export type LearningTargetKind = 'repository' | 'value_point' | 'component' | 'layer' | 'learning_step';
export type LearningActionStatus = 'pending' | 'confirmed' | 'declined' | 'executed' | 'expired' | 'failed';

export interface LearningActionCard {
  action_id: string;
  action: LearningActionKind;
  target: {
    kind: LearningTargetKind;
    stable_id: string | null;
    label: string;
  } | null;
  title: string;
  description: string;
  request: string;
  snapshot_id: string;
  status: LearningActionStatus;
  skip_understanding_check?: boolean;
  progress: {
    mastered_items: string[];
    evidence_ids: string[];
  } | null;
  created_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  error: string | null;
}

export interface ConversationSelection {
  snapshot_id: string;
  kind: ConversationSelectionKind;
  stable_id: string;
  label: string;
  /** Canonical graph entity behind the clicked projection item. */
  entity_id?: string | null;
  /** First directly supporting Evidence ID, when the item has one. */
  evidence_id?: string | null;
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

export type MessageFeedbackVote = 'up' | 'down';

export interface FeedbackSignal {
  sentiment: 'positive' | 'negative' | 'mixed' | 'neutral';
  strengths: string[];
  issues: string[];
  skill_hypotheses: string[];
  confidence: number;
  source: 'button' | 'language';
  observed_at: string;
}

export interface MessageFeedback {
  vote: MessageFeedbackVote | null;
  updated_at: string;
  signal?: FeedbackSignal | null;
}

export interface MessageThinkingSummaryEvent {
  sequence: number;
  timestamp: string;
  kind: 'summary';
  stage: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  elapsed_ms: number;
}

export interface Message {
  unresolved_references?: string[];
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
  analysis_snapshot_id?: string | null;
  analysis_commit_sha?: string | null;
  feedback?: MessageFeedback | null;
  trace_id?: string | null;
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
  stage: AnalysisStage;
  snapshot_id: string | null;
  file_count: number;
  symbol_count: number;
  call_count: number;
  languages: string[];
  error: string | null;
  canonical_snapshot_key: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  progress_events?: AnalysisProgressEvent[];
  strategy?: AnalysisStrategy;
}

export interface AnalysisProgressEvent {
  instance_id?: string;
  completed_batches?: number;
  total_batches?: number;
  reused_batches?: number;
  sequence: number;
  kind: AnalysisProgressKind;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'degraded' | 'reused';
  timestamp: string;
  elapsed_ms: number;
}

export interface StudyState {
  phase: TeachingPhase;
  selected_value_point: string | null;
  current_step: number;
  total_steps: number;
  mastered: string[];
  skipped_steps?: string[];
  misconceptions: string[];
  open_questions: string[];
  used_evidence: string[];
  dynamic_learning_plan?: LearningStep[];
}

export interface Project {
  chat_limits?: { max_rounds: number; max_content_bytes: number };
  display_language?: string;
  project_id: string;
  title: string;
  source: RepoSource;
  created_at: string;
  updated_at: string;
  messages: Message[];
  analysis: AnalysisState;
  study: StudyState;
  model_override: string | null;
  repository_migration?: RepositoryMigrationAction | null;
}

export type RepositoryMigrationStatus = 'pending' | 'confirmed' | 'declined' | 'executed' | 'failed';
export interface RepositoryMigrationAction {
  migration_id: string;
  from_public_snapshot_key: string;
  to_public_snapshot_key: string;
  from_snapshot_id: string;
  to_snapshot_id: string;
  from_commit_sha: string;
  to_commit_sha: string;
  status: RepositoryMigrationStatus;
  route_replanned: boolean;
  resume_step: number | null;
  summary: string | null;
  created_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  error: string | null;
}

export type RevisionRedirectKind = 'unchanged' | 'renamed' | 'deleted' | 'split' | 'merged' | 'unknown';
export interface RevisionRedirect {
  repository_identity: string;
  from_public_snapshot_key: string;
  to_public_snapshot_key: string;
  old_path: string;
  old_stable_id: string | null;
  kind: RevisionRedirectKind;
  candidates: Array<{ path: string; stable_id: string | null; confidence: number }>;
  created_at: string;
}

export interface ProjectSummary {
  project_id: string;
  title: string;
  source_kind: RepoSourceKind;
  source_value: string;
  analysis_stage: AnalysisStage;
  teaching_phase: TeachingPhase;
  message_count: number;
  updated_at: string;
}

export interface ProjectDetail {
  project: Project;
  snapshot_available: boolean;
  analysis_job: AnalysisJob | null;
  analysis_error_code?: string | null;
}

export interface AnalysisJob {
  job_id: string;
  project_id: string;
  idempotency_key: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  available_at: string;
  completed_at: string | null;
  error: string | null;
  error_code?: string | null;
}

export interface AnalysisStatus extends AnalysisState {
  error_code?: string | null;
  job_id: string | null;
  job_status: AnalysisJob['status'] | null;
  job_attempt: number | null;
  job_max_attempts: number | null;
  lease_owner: string | null;
  heartbeat_at: string | null;
  retryable: boolean;
}

export interface SnapshotSummary {
  file_count: number;
  symbol_count: number;
  call_count: number;
  import_count: number;
  inherit_count: number;
  component_count: number;
}

export interface GraphEvidence {
  stable_id: string;
  label: string;
  path: string;
  start_line: number | null;
  end_line?: number | null;
  kind: string;
  source_id?: string;
  target_id?: string;
  source_label?: string | null;
  target_label?: string | null;
}

export interface GraphNode {
  id: string;
  entity_kind?: 'repository' | 'system' | 'subsystem' | 'domain' | 'module' | 'component' | 'fact';
  parent_entity_id?: string | null;
  depth?: number;
  label: string;
  name: string;
  responsibility: string;
  grouping_rationale: string;
  architecture_layer_id: string | null;
  architecture_layer_name: string | null;
  architecture_layer_candidates: { id: string; name: string }[];
  architecture_layer_rationale: string | null;
  architecture_layer_certainty: string;
  members: GraphEvidence[];
  member_count: number;
  evidence: GraphEvidence[];
  certainty: string;
  review_status: string;
  source_report_ids: string[];
  fan_in: number;
  fan_out: number;
  attributes?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation_kind: string;
  label: string;
  description: string;
  certainty: string;
  evidence: GraphEvidence[];
  source_report_ids: string[];
  weight: number;
}

export interface SnapshotOverlay {
  id: string;
  kind: 'community' | 'architecture_layer' | 'process' | 'runtime';
  name: string;
  responsibility: string;
  member_entity_ids: string[];
  relation_ids: string[];
  evidence_ids: string[];
  certainty: string;
}

export interface SnapshotProjectionNode {
  projection_node_id: string;
  entity_id: string;
  parent_projection_node_id: string | null;
  depth: number;
  aggregate_member_entity_ids: string[];
  evidence_ids: string[];
  overlay_ids?: string[];
}

export interface SnapshotProjectionEdge {
  projection_edge_id: string;
  relation_id: string | null;
  source_projection_node_id: string;
  target_projection_node_id: string;
  aggregate_relation_ids: string[];
  evidence_ids: string[];
  overlay_ids?: string[];
}

export interface SnapshotProjection {
  kind: 'human' | 'agent';
  snapshot_id: string;
  nodes: SnapshotProjectionNode[];
  edges: SnapshotProjectionEdge[];
  truncated: boolean;
  next_cursor: string | null;
  partial?: boolean;
  omitted_entity_count?: number;
  omitted_relation_count?: number;
}

export interface ArchitectureLayer {
  id: string;
  name: string;
  responsibility: string;
  component_ids: string[];
  evidence: GraphEvidence[];
  certainty: string;
  source_report_ids: string[];
}

export interface ValuePoint {
  stable_id: string;
  kind: string;
  title: string;
  claim: string;
  problem: string | null;
  implementation: string | null;
  tradeoffs: string | null;
  transfer_conditions: string | null;
  certainty: string;
  evidence: GraphEvidence[];
  connectivity: number;
}

export interface LanguageRow {
  language: string;
  quality_tier: 'verified' | 'degraded' | 'unavailable';
  files_seen: number;
  files_analyzed: number;
  files_failed: number;
  reason_codes: string[];
}

export interface LearningStep {
  step_id: string;
  order: number;
  title: string;
  objective: string;
  evidence_refs: string[];
  component_ids: string[];
  completion_check: string;
}

export interface LearningPlan {
  snapshot_id: string;
  selected_value_point: string | null;
  steps: LearningStep[];
}

export interface Snapshot {
  snapshot_id: string;
  display_language?: 'zh-CN' | 'en';
  summary: SnapshotSummary;
  graph: {
    semantic_mode: 'empty' | 'structural_candidate' | 'partial_provider_supported' | 'provider_supported';
    semantic_coverage?: {
      total_components: number;
      provider_supported_components: number;
      degraded_component_ids: string[];
    };
    nodes: GraphNode[];
    edges: GraphEdge[];
    layers: ArchitectureLayer[];
    unassigned_component_ids: string[];
    schema_version?: string;
    hierarchy?: { root_entity_ids: string[]; max_depth: number };
    overlays?: SnapshotOverlay[];
    projections?: { human: SnapshotProjection; agent: SnapshotProjection };
  };
  value_points: ValuePoint[];
  languages: LanguageRow[];
  learning_plan: LearningPlan;
}

export interface SettingsResponse {
  base_url: string;
  model: string;
  thinking_level: ThinkingLevel;
  api_key_management: 'interactive' | 'deployment';
  available_models: string[];
  model_options: ModelOption[];
  selected_model_option: ModelOption | null;
  providers: ProviderConnection[];
  provider_presets: ProviderPreset[];
  models_endpoint_supported: boolean | null;
  has_api_key: boolean;
  api_key_masked: string | null;
  last_verified_at: string | null;
  verify_error: string | null;
  can_manage_api_key: boolean;
  free_experience_model: string;
  free_experience_provider_model: string;
  free_experience_configured: boolean;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelOption {
  selector: string;
  connection_id: string;
  provider: string;
  model_id: string;
  label: string;
  thinking_levels: ThinkingLevel[];
  thinking_mode?: 'pi' | 'provider-default';
}

export interface ProviderConnection {
  connection_id: string;
  provider: string;
  label: string;
  base_url: string | null;
  custom_models: string[];
  models_source?: 'provider' | 'verified' | null;
  manually_verified_models?: string[];
  last_verified_at: string | null;
  verify_error: string | null;
  retired?: boolean;
  has_api_key: boolean;
  api_key_masked: string | null;
}

export interface ProviderPreset {
  id: string;
  family?: string;
  family_label?: string;
  variant_label?: string;
  icon?: string;
  api?: string;
  label: string;
  base_url: string;
  custom_base_url: boolean;
}

export interface LearnerProfile {
  enabled: boolean;
  languages: string[];
  goals: string[];
  explanation_preference: string;
  experience_level: string;
  inferred: {
    claim_id: string;
    claim: string;
    confidence: number;
    evidence: string;
    observed_at: string;
    source_project_id: string | null;
  }[];
  last_inferred_message_id: string | null;
  memory_summary?: string;
  memory_summary_mode?: 'generated' | 'edited';
  memory_summary_updated_at?: string | null;
}

export interface IdentityResponse {
  owner_id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  kind: 'guest' | 'github';
  auth_mode: 'github';
  merge_summary?: OwnerMergeSummary | null;
}

export interface OwnerMergeSummary {
  source_owner_id: string;
  target_owner_id: string;
  projects: number;
  messages: number;
  memories: number;
  sessions: number;
  traces: number;
  feedback_requests: number;
  merged_at: string;
}

export interface AuthConfigResponse {
  auth_mode: 'github';
  guest_enabled: boolean;
  guest_retention?: {
    empty_days: number;
    project_inactive_days: number;
    recovery_days: number;
    notice: string;
  };
}

export interface RuntimeProgressEvent {
  analysis_progress?: AnalysisProgressEvent;
  run_id?: string;
  stage: string;
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  elapsed_ms: number;
  tool_name?: string;
  sequence?: number;
  delta?: string;
  timestamp?: string;
  event_type?: string;
  display_stage?: string;
  kind?: 'summary' | 'commentary' | 'tool' | 'answer';
  text?: string;
  visible?: boolean;
  tool_error?: boolean;
}

export interface SendMessageResult {
  error?: { code: string; message: string };
  user_message: Message;
  assistant_message: Message;
  teaching_phase: TeachingPhase;
  validation_errors: string[];
  tools_used: string[];
  state_changed: boolean;
}

export interface LearningActionResolution {
  project: Project;
  action: LearningActionCard;
  state_changed: boolean;
}
