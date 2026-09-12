export type EvolutionStatus =
  | "created"
  | "workspace_prepared"
  | "agent_running"
  | "candidate_produced"
  | "checks_running"
  | "awaiting_review"
  | "published"
  | "rejected"
  | "rolled_back"
  | "failed"
  | "needs_manual_recovery";

export type OperationStatus = "started" | "succeeded" | "failed" | "uncertain";

export interface ErrorSummary {
  name: string;
  message: string;
  messageDigest: string;
  truncated: boolean;
}

export interface EvolutionTask {
  taskId: string;
  trigger: "trace" | "eval" | "human_feedback";
  failureEvidence: string[];
  skillId: string;
  baseSkillVersion: string;
  baseRevision: number;
  baseSnapshotDigest: string;
  whitelist: string[];
  checkIds: string[];
  checkDefinitionDigests: Record<string, string>;
  evaluation: EvaluationRequirement;
  maxSteps: number;
  maxTimeMs: number;
  maxTokens: number;
  maxCostUsd: number;
  maxCandidateBytes?: number;
}

export interface EvalMetricRequirement {
  direction: "higher" | "lower";
  maxRegression: number;
}

export interface EvaluationRequirement {
  checkId: string;
  suiteId: string;
  datasetVersion: string;
  definitionDigest: string;
  metrics: Record<string, EvalMetricRequirement>;
}

export interface EvalMetricResult extends EvalMetricRequirement {
  baseline: number;
  candidate: number;
  delta: number;
  passed: boolean;
}

export interface EvaluationResult {
  checkId: string;
  suiteId: string;
  datasetVersion: string;
  definitionDigest: string;
  baselineVersion: string;
  baselineOutputDigest: string;
  metrics: Record<string, EvalMetricResult>;
  passed: boolean;
  outputDigest: string;
  elapsedMs: number;
  isolation: IsolationAttestation;
}

export interface OperationRecord {
  operationId: string;
  kind:
    | "prepare_workspace"
    | "pi_session"
    | "read"
    | "write"
    | "edit"
    | "check"
    | "submit"
    | "publish"
    | "rollback";
  status: OperationStatus;
  replay: "safe" | "never" | "manual";
  inputDigest: string;
  startedAt: string;
  completedAt?: string;
  artifactDigest?: string;
  error?: ErrorSummary;
}

export interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface PiTraceEvent {
  eventType: string;
  toolName?: string;
  toolCallId?: string;
  operationId?: string;
  resultDigest?: string;
  isError?: boolean;
  elapsedMs?: number;
}

export interface PiSessionReport {
  sessionId: string;
  events: PiTraceEvent[];
  usage: PiUsage;
}

export interface OperationLedger {
  taskId: string;
  taskDigest: string;
  status: EvolutionStatus;
  createdAt: string;
  updatedAt: string;
  steps: string[];
  allowedTools: RestrictedToolName[];
  operations: OperationRecord[];
  checkResults: CheckResult[];
  evaluation?: EvaluationResult;
  sideEffects: string[];
  compactionContext: string;
  piReport?: PiSessionReport;
  piSession?: PiSessionPersistence;
  diffDigest?: string;
  candidateDigest?: string;
  recoveryBundleDigest?: string;
  publishedVersion?: string;
  publishedRevision?: number;
  publishedSnapshotDigest?: string;
  rollbackTarget?: string;
  error?: ErrorSummary;
}

export interface PiSessionPersistence {
  sessionId: string;
  agentDir: string;
  sessionDir: string;
  eventLog: string;
}

export interface RecoveryBundle {
  taskId: string;
  createdAt: string;
  changedFiles: string[];
  artifacts: CandidateArtifact[];
  references: RecoveryArtifactReference[];
  diff: string;
  diffTruncated: boolean;
  diffDigest: string;
  changeSummary: string;
  risks: string[];
  unresolvedIssues: string[];
  error: ErrorSummary;
  ledger: {
    status: EvolutionStatus;
    steps: string[];
    operations: OperationRecord[];
    checks: Array<{
      checkId: string;
      passed: boolean;
      timedOut: boolean;
      outputDigest: string;
      elapsedMs: number;
      isolation: IsolationAttestation;
    }>;
    evaluation?: EvaluationResult;
    sideEffects: string[];
    usage?: PiUsage;
  };
}

export interface RecoveryArtifactReference {
  path: string;
  sha256: string;
  bytes: number;
  objectId: string;
}

export interface CandidateArtifact {
  path: string;
  content: string;
  sha256: string;
  bytes: number;
}

export interface SkillVersionBinding {
  skillId: string;
  version: string;
  revision: number;
  snapshotDigest: string;
  artifacts: CandidateArtifact[];
}

export interface SkillCandidate {
  candidateId: string;
  taskId: string;
  skillId: string;
  baseVersion: string;
  baseRevision: number;
  baseSnapshotDigest: string;
  candidateVersion: string;
  prompt: string;
  failureEvidence: string[];
  changedFiles: string[];
  baseArtifacts: CandidateArtifact[];
  artifacts: CandidateArtifact[];
  diff: string;
  diffDigest: string;
  checks: CheckResult[];
  evaluation: EvaluationResult;
  changeSummary: string;
  risks: string[];
  unresolvedIssues: string[];
  rollbackTarget: string;
  status: "candidate" | "approved" | "rejected" | "rolled_back";
}

export interface CheckDefinition {
  id: string;
  cwd: { kind: "workspace" } | { kind: "fixed"; path: string };
  argv: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Record<string, string>;
}

export interface CheckResult {
  checkId: string;
  definitionDigest: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputDigest: string;
  outputBytes: number;
  outputTruncated: boolean;
  elapsedMs: number;
  isolation: IsolationAttestation;
}

export interface IsolationAttestation {
  schemaVersion: 1;
  trustDomain: "production" | "test";
  provider: string;
  runtime: string;
  sandboxId: string;
  policyDigest: string;
  executorConfigDigest: string;
  runtimeProbeDigest: string;
  requestDigest: string;
  imageDigest: string;
  platform: string;
  runAsUser: string;
  network: "disabled";
  ipcNamespace: "private";
  cgroupNamespace: "private";
  hostFilesystem: "unavailable";
  rootFilesystem: "read-only";
  workspaceFilesystem: "tmpfs";
  capabilities: "dropped";
  noNewPrivileges: true;
  seccompProfile: "builtin";
  resourceLimits: IsolationResourceLimits;
  runtimeProbe: IsolationRuntimeProbe;
}

export interface IsolationResourceLimits {
  cpuCount: number;
  memoryBytes: number;
  pidsLimit: number;
  workspaceBytes: number;
  tempBytes: number;
  sharedMemoryBytes: number;
  timeoutMs: number;
}

export interface IsolationRuntimeProbe {
  schemaVersion: 1;
  uid: number;
  gid: number;
  noNewPrivileges: true;
  seccompMode: 2;
  effectiveCapabilities: string;
  boundingCapabilities: string;
  networkInterfaces: ["lo"];
  rootReadOnly: true;
  workspaceFilesystem: "tmpfs";
  workspaceBytes: number;
  tempFilesystem: "tmpfs";
  tempBytes: number;
  sharedMemoryFilesystem: "tmpfs";
  sharedMemoryBytes: number;
  cgroupVersion: 2;
  memoryMaxBytes: number;
  swapMaxBytes: 0;
  pidsMax: number;
  cpuQuota: number;
  cpuPeriod: number;
}

export interface IsolationPolicy {
  schemaVersion: 1;
  policyId: string;
  trustDomain: "production" | "test";
  provider: string;
  runtime: string;
  executorConfigDigest: string;
  imageDigest: string;
  platform: string;
  runAsUser: string;
  network: "disabled";
  ipcNamespace: "private";
  cgroupNamespace: "private";
  hostFilesystem: "unavailable";
  rootFilesystem: "read-only";
  workspaceFilesystem: "tmpfs";
  capabilities: "dropped";
  noNewPrivileges: true;
  seccompProfile: "builtin";
  resourceLimits: Omit<IsolationResourceLimits, "timeoutMs">;
}

export interface SandboxFile {
  path: string;
  contentBase64: string;
  sha256: string;
  bytes: number;
}

export interface SandboxCheckScope {
  allowedFiles: string[];
  maxWorkspaceBytes: number;
  maxFileCount: number;
}

export interface SandboxCheckRequest {
  definition: CheckDefinition;
  workspaceFiles: SandboxFile[];
  scope: SandboxCheckScope;
}

export interface SandboxCheckExecution {
  exitCode: number | null;
  timedOut: boolean;
  terminationReason: "exit" | "timeout" | "output_limit";
  stdout: string;
  stderr: string;
  elapsedMs: number;
  isolation: IsolationAttestation;
}

export interface SandboxCheckExecutor {
  readonly isolationPolicy: IsolationPolicy;
  readonly startupGraceMs: number;
  readonly abortGraceMs: number;
  execute(
    request: SandboxCheckRequest,
    signal?: AbortSignal,
  ): Promise<SandboxCheckExecution>;
}

export interface ReviewDecision {
  taskId: string;
  reviewerId: string;
  decision: "approve" | "reject";
  candidateDigest: string;
  taskDigest: string;
  baseRevision: number;
  baseSnapshotDigest: string;
  claimedAt: string;
  reason?: string;
}

export type RestrictedToolName =
  | "read_candidate"
  | "write_candidate"
  | "edit_candidate"
  | "run_check"
  | "submit_candidate";

export interface RestrictedToolResult {
  text: string;
  isError?: boolean;
}

export interface RestrictedToolDescriptor {
  name: RestrictedToolName;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: { toolCallId?: string },
  ): Promise<RestrictedToolResult>;
}

export interface PiSessionLike {
  prompt(input: string): Promise<PiSessionReport>;
  compact?(instructions: string): Promise<void>;
  abort?(): Promise<void>;
  dispose?(): void | Promise<void>;
}

export type PiSessionFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  sessionId: string;
  systemPrompt: string;
  getCompactionContext: () => string | Promise<string>;
  persistEvent: (event: PiTraceEvent) => void;
  tools: RestrictedToolDescriptor[];
  budget: {
    maxTokens: number;
    maxCostUsd: number;
  };
}) => Promise<PiSessionLike>;
