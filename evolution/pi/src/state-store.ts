import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  CandidateArtifact,
  CheckResult,
  EvaluationRequirement,
  EvaluationResult,
  EvolutionTask,
  OperationLedger,
  PiSessionReport,
  PiSessionPersistence,
  PiTraceEvent,
  RecoveryBundle,
  RecoveryArtifactReference,
  ReviewDecision,
  SkillCandidate,
} from "./contracts.js";
import { isPortableIdentifier, portableRelativePath } from "./path-safety.js";
import { hasUnsafeAbsolutePath, summarizeError } from "./errors.js";
import {
  MAX_PI_EVENT_LOG_BYTES,
  MAX_PI_TRACE_EVENT_BYTES,
  MAX_PI_TRACE_EVENTS,
  MAX_CHECK_RESULT_TEXT_BYTES,
  MAX_LEDGER_CHECK_OUTPUT_BYTES,
  MAX_LEDGER_CHECK_RESULTS,
  utf8Bytes,
  validateCandidateExplanation,
} from "./limits.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,191}$/;
const EVOLUTION_STATUSES = new Set([
  "created",
  "workspace_prepared",
  "agent_running",
  "candidate_produced",
  "checks_running",
  "awaiting_review",
  "published",
  "rejected",
  "rolled_back",
  "failed",
  "needs_manual_recovery",
]);
const OPERATION_STATUSES = new Set(["started", "succeeded", "failed", "uncertain"]);
const OPERATION_KINDS = new Set([
  "prepare_workspace",
  "pi_session",
  "read",
  "write",
  "edit",
  "check",
  "submit",
  "publish",
  "rollback",
]);
const REPLAY_POLICIES = new Set(["safe", "never", "manual"]);
const RESTRICTED_TOOLS = new Set([
  "read_candidate",
  "write_candidate",
  "edit_candidate",
  "run_check",
  "submit_candidate",
]);
const REVIEW_LOCK_STALE_MS = 30 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PERSISTED_JSON_BYTES = 8 * 1024 * 1024;

export class StaleReviewLockError extends Error {
  override readonly name = "StaleReviewLockError";
}

/**
 * Durable business-state journal for EvolutionTask records. The filesystem
 * still owns Pi sessions and recovery artifacts; production uses PostgreSQL
 * for the task, ledger, candidate and review decision queried by workers.
 */
export interface EvolutionStateJournal {
  hasTask(taskId: string): Promise<boolean>;
  listTaskIds(status?: OperationLedger["status"]): Promise<string[]>;
  create(task: EvolutionTask, ledger: OperationLedger): Promise<void>;
  saveLedger(ledger: OperationLedger): Promise<void>;
  loadTask(taskId: string): Promise<EvolutionTask | null>;
  loadLedger(taskId: string): Promise<OperationLedger | null>;
  saveCandidate(candidate: SkillCandidate): Promise<void>;
  loadCandidate(taskId: string): Promise<SkillCandidate | null>;
  claimReviewDecision(decision: ReviewDecision): Promise<void>;
  loadReviewDecision(taskId: string): Promise<ReviewDecision | null>;
  close?(): Promise<void>;
}

function checkedId(value: string, label: string): string {
  if (!isPortableIdentifier(value, SAFE_ID)) throw new Error(`invalid ${label}`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(row).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`invalid ${label}: unexpected field ${unexpected.sort()[0]}`);
  }
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`invalid ${label}: expected string`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${label}: expected finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new Error(`invalid ${label}: expected non-negative number`);
  return result;
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isInteger(result)) throw new Error(`invalid ${label}: expected integer`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new Error(`invalid ${label}: expected positive integer`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`invalid ${label}: expected SHA-256 digest`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}: expected boolean`);
  return value;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label}: expected array`);
  return value;
}

function textList(value: unknown, label: string): string[] {
  return list(value, label).map((item, index) => text(item, `${label}[${index}]`, true));
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label, true);
}

function boundedText(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  const result = text(value, label, allowEmpty);
  if (utf8Bytes(result) > maxBytes) throw new Error(`invalid ${label}: byte budget exceeded`);
  return result;
}

function validateErrorSummary(value: unknown, label: string): void {
  const row = object(value, label);
  exactKeys(row, ["name", "message", "messageDigest", "truncated"], label);
  const name = text(row.name, `${label}.name`);
  const message = text(row.message, `${label}.message`, true);
  const messageDigest = text(row.messageDigest, `${label}.messageDigest`);
  boolean(row.truncated, `${label}.truncated`);
  if (Buffer.byteLength(name, "utf8") > 96 || Buffer.byteLength(message, "utf8") > 2_048 ||
    !SHA256.test(messageDigest) || hasUnsafeAbsolutePath(message)) {
    throw new Error(`invalid ${label}: unbounded or sensitive error data`);
  }
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`invalid ${label}: expected timestamp`);
  return result;
}

function enumText(value: unknown, allowed: Set<string>, label: string): string {
  const result = text(value, label);
  if (!allowed.has(result)) throw new Error(`invalid ${label}: unsupported value`);
  return result;
}

function validateIsolation(value: unknown, label: string): void {
  const row = object(value, label);
  exactKeys(row, [
    "schemaVersion",
    "trustDomain",
    "provider",
    "runtime",
    "sandboxId",
    "policyDigest",
    "executorConfigDigest",
    "runtimeProbeDigest",
    "requestDigest",
    "imageDigest",
    "platform",
    "runAsUser",
    "network",
    "ipcNamespace",
    "cgroupNamespace",
    "hostFilesystem",
    "rootFilesystem",
    "workspaceFilesystem",
    "capabilities",
    "noNewPrivileges",
    "seccompProfile",
    "resourceLimits",
    "runtimeProbe",
  ], label);
  if (row.schemaVersion !== 1 || (row.trustDomain !== "production" && row.trustDomain !== "test")) {
    throw new Error(`invalid ${label}: unsupported isolation schema`);
  }
  text(row.provider, `${label}.provider`);
  text(row.runtime, `${label}.runtime`);
  text(row.sandboxId, `${label}.sandboxId`);
  digest(row.policyDigest, `${label}.policyDigest`);
  digest(row.executorConfigDigest, `${label}.executorConfigDigest`);
  digest(row.runtimeProbeDigest, `${label}.runtimeProbeDigest`);
  digest(row.requestDigest, `${label}.requestDigest`);
  if (!/^sha256:[a-f0-9]{64}$/.test(text(row.imageDigest, `${label}.imageDigest`))) {
    throw new Error(`invalid ${label}: expected pinned image digest`);
  }
  text(row.platform, `${label}.platform`);
  text(row.runAsUser, `${label}.runAsUser`);
  if (row.network !== "disabled" || row.ipcNamespace !== "private" ||
    row.cgroupNamespace !== "private" || row.hostFilesystem !== "unavailable" ||
    row.rootFilesystem !== "read-only" || row.workspaceFilesystem !== "tmpfs" ||
    row.capabilities !== "dropped" || row.noNewPrivileges !== true ||
    row.seccompProfile !== "builtin") {
    throw new Error(`invalid ${label}: isolation attestation is insufficient`);
  }
  const limits = object(row.resourceLimits, `${label}.resourceLimits`);
  exactKeys(limits, [
    "cpuCount",
    "memoryBytes",
    "pidsLimit",
    "workspaceBytes",
    "tempBytes",
    "sharedMemoryBytes",
    "timeoutMs",
  ], `${label}.resourceLimits`);
  const cpuCount = finiteNumber(limits.cpuCount, `${label}.resourceLimits.cpuCount`);
  if (cpuCount <= 0) throw new Error(`invalid ${label}: expected positive CPU limit`);
  positiveInteger(limits.memoryBytes, `${label}.resourceLimits.memoryBytes`);
  positiveInteger(limits.pidsLimit, `${label}.resourceLimits.pidsLimit`);
  positiveInteger(limits.workspaceBytes, `${label}.resourceLimits.workspaceBytes`);
  positiveInteger(limits.tempBytes, `${label}.resourceLimits.tempBytes`);
  positiveInteger(limits.sharedMemoryBytes, `${label}.resourceLimits.sharedMemoryBytes`);
  positiveInteger(limits.timeoutMs, `${label}.resourceLimits.timeoutMs`);
  const probe = object(row.runtimeProbe, `${label}.runtimeProbe`);
  exactKeys(probe, [
    "schemaVersion",
    "uid",
    "gid",
    "noNewPrivileges",
    "seccompMode",
    "effectiveCapabilities",
    "boundingCapabilities",
    "networkInterfaces",
    "rootReadOnly",
    "workspaceFilesystem",
    "workspaceBytes",
    "tempFilesystem",
    "tempBytes",
    "sharedMemoryFilesystem",
    "sharedMemoryBytes",
    "cgroupVersion",
    "memoryMaxBytes",
    "swapMaxBytes",
    "pidsMax",
    "cpuQuota",
    "cpuPeriod",
  ], `${label}.runtimeProbe`);
  if (probe.schemaVersion !== 1) throw new Error(`invalid ${label}: runtime probe schema`);
  integer(probe.uid, `${label}.runtimeProbe.uid`);
  integer(probe.gid, `${label}.runtimeProbe.gid`);
  if (probe.noNewPrivileges !== true || probe.seccompMode !== 2 ||
    probe.rootReadOnly !== true || probe.workspaceFilesystem !== "tmpfs" ||
    probe.tempFilesystem !== "tmpfs" || probe.sharedMemoryFilesystem !== "tmpfs" ||
    probe.cgroupVersion !== 2 || probe.swapMaxBytes !== 0) {
    throw new Error(`invalid ${label}: runtime probe is insufficient`);
  }
  text(probe.effectiveCapabilities, `${label}.runtimeProbe.effectiveCapabilities`);
  text(probe.boundingCapabilities, `${label}.runtimeProbe.boundingCapabilities`);
  const interfaces = textList(probe.networkInterfaces, `${label}.runtimeProbe.networkInterfaces`);
  if (interfaces.length !== 1 || interfaces[0] !== "lo") {
    throw new Error(`invalid ${label}: runtime probe network isolation is insufficient`);
  }
  positiveInteger(probe.workspaceBytes, `${label}.runtimeProbe.workspaceBytes`);
  positiveInteger(probe.tempBytes, `${label}.runtimeProbe.tempBytes`);
  positiveInteger(probe.sharedMemoryBytes, `${label}.runtimeProbe.sharedMemoryBytes`);
  positiveInteger(probe.memoryMaxBytes, `${label}.runtimeProbe.memoryMaxBytes`);
  positiveInteger(probe.pidsMax, `${label}.runtimeProbe.pidsMax`);
  positiveInteger(probe.cpuQuota, `${label}.runtimeProbe.cpuQuota`);
  positiveInteger(probe.cpuPeriod, `${label}.runtimeProbe.cpuPeriod`);
}

function validateCheckResult(value: unknown, label: string): CheckResult {
  const row = object(value, label);
  exactKeys(row, [
    "checkId",
    "definitionDigest",
    "passed",
    "exitCode",
    "timedOut",
    "stdout",
    "stderr",
    "outputDigest",
    "outputBytes",
    "outputTruncated",
    "elapsedMs",
    "isolation",
  ], label);
  text(row.checkId, `${label}.checkId`);
  digest(row.definitionDigest, `${label}.definitionDigest`);
  boolean(row.passed, `${label}.passed`);
  if (row.exitCode !== null) integer(row.exitCode, `${label}.exitCode`);
  boolean(row.timedOut, `${label}.timedOut`);
  const stdout = text(row.stdout, `${label}.stdout`, true);
  const stderr = text(row.stderr, `${label}.stderr`, true);
  const persistedBytes = utf8Bytes(stdout) + utf8Bytes(stderr);
  if (persistedBytes > MAX_CHECK_RESULT_TEXT_BYTES) {
    throw new Error(`invalid ${label}: persisted output byte budget exceeded`);
  }
  digest(row.outputDigest, `${label}.outputDigest`);
  const outputBytes = nonNegativeNumber(row.outputBytes, `${label}.outputBytes`);
  if (!Number.isSafeInteger(outputBytes) || outputBytes < persistedBytes || outputBytes > 1024 * 1024) {
    throw new Error(`invalid ${label}.outputBytes`);
  }
  const outputTruncated = boolean(row.outputTruncated, `${label}.outputTruncated`);
  if (outputTruncated !== (outputBytes > persistedBytes)) {
    throw new Error(`invalid ${label}.outputTruncated`);
  }
  nonNegativeNumber(row.elapsedMs, `${label}.elapsedMs`);
  validateIsolation(row.isolation, `${label}.isolation`);
  return row as unknown as CheckResult;
}

function validateEvaluationRequirement(value: unknown, label: string): EvaluationRequirement {
  const row = object(value, label);
  exactKeys(row, ["checkId", "suiteId", "datasetVersion", "definitionDigest", "metrics"], label);
  text(row.checkId, `${label}.checkId`);
  text(row.suiteId, `${label}.suiteId`);
  text(row.datasetVersion, `${label}.datasetVersion`);
  text(row.definitionDigest, `${label}.definitionDigest`);
  const metrics = object(row.metrics, `${label}.metrics`);
  if (Object.keys(metrics).length === 0) throw new Error(`invalid ${label}.metrics: empty`);
  for (const [name, raw] of Object.entries(metrics)) {
    const metric = object(raw, `${label}.metrics.${name}`);
    exactKeys(metric, ["direction", "maxRegression"], `${label}.metrics.${name}`);
    if (metric.direction !== "higher" && metric.direction !== "lower") {
      throw new Error(`invalid ${label}.metrics.${name}.direction`);
    }
    const regression = finiteNumber(
      metric.maxRegression,
      `${label}.metrics.${name}.maxRegression`,
    );
    if (regression < 0) throw new Error(`invalid ${label}.metrics.${name}.maxRegression`);
  }
  return row as unknown as EvaluationRequirement;
}

function validateEvaluationResult(value: unknown, label: string): EvaluationResult {
  const row = object(value, label);
  exactKeys(row, [
    "checkId",
    "suiteId",
    "datasetVersion",
    "definitionDigest",
    "baselineVersion",
    "baselineOutputDigest",
    "metrics",
    "passed",
    "outputDigest",
    "elapsedMs",
    "isolation",
  ], label);
  text(row.checkId, `${label}.checkId`);
  text(row.suiteId, `${label}.suiteId`);
  text(row.datasetVersion, `${label}.datasetVersion`);
  text(row.definitionDigest, `${label}.definitionDigest`);
  text(row.baselineVersion, `${label}.baselineVersion`);
  text(row.baselineOutputDigest, `${label}.baselineOutputDigest`);
  const metrics = object(row.metrics, `${label}.metrics`);
  if (Object.keys(metrics).length === 0) throw new Error(`invalid ${label}.metrics: empty`);
  for (const [name, raw] of Object.entries(metrics)) {
    const metric = object(raw, `${label}.metrics.${name}`);
    exactKeys(metric, [
      "baseline",
      "candidate",
      "delta",
      "direction",
      "maxRegression",
      "passed",
    ], `${label}.metrics.${name}`);
    finiteNumber(metric.baseline, `${label}.metrics.${name}.baseline`);
    finiteNumber(metric.candidate, `${label}.metrics.${name}.candidate`);
    finiteNumber(metric.delta, `${label}.metrics.${name}.delta`);
    if (metric.direction !== "higher" && metric.direction !== "lower") {
      throw new Error(`invalid ${label}.metrics.${name}.direction`);
    }
    const regression = finiteNumber(metric.maxRegression, `${label}.metrics.${name}.maxRegression`);
    if (regression < 0) throw new Error(`invalid ${label}.metrics.${name}.maxRegression`);
    boolean(metric.passed, `${label}.metrics.${name}.passed`);
  }
  boolean(row.passed, `${label}.passed`);
  text(row.outputDigest, `${label}.outputDigest`);
  nonNegativeNumber(row.elapsedMs, `${label}.elapsedMs`);
  validateIsolation(row.isolation, `${label}.isolation`);
  return row as unknown as EvaluationResult;
}

export function validateTask(value: unknown): EvolutionTask {
  const row = object(value, "evolution task");
  exactKeys(row, [
    "taskId",
    "trigger",
    "failureEvidence",
    "skillId",
    "baseSkillVersion",
    "baseRevision",
    "baseSnapshotDigest",
    "whitelist",
    "checkIds",
    "checkDefinitionDigests",
    "evaluation",
    "maxSteps",
    "maxTimeMs",
    "maxTokens",
    "maxCostUsd",
    "maxCandidateBytes",
  ], "evolution task");
  const taskId = text(row.taskId, "task.taskId");
  if (!isPortableIdentifier(taskId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)) {
    throw new Error("invalid task.taskId");
  }
  enumText(row.trigger, new Set(["trace", "eval", "human_feedback"]), "task.trigger");
  textList(row.failureEvidence, "task.failureEvidence");
  const skillId = text(row.skillId, "task.skillId");
  const baseVersion = text(row.baseSkillVersion, "task.baseSkillVersion");
  positiveInteger(row.baseRevision, "task.baseRevision");
  digest(row.baseSnapshotDigest, "task.baseSnapshotDigest");
  if (!isPortableIdentifier(skillId, /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,190}$/)) {
    throw new Error("invalid task.skillId");
  }
  if (!isPortableIdentifier(baseVersion, /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,159}$/)) {
    throw new Error("invalid task.baseSkillVersion");
  }
  const whitelist = textList(row.whitelist, "task.whitelist");
  if (whitelist.length === 0) throw new Error("invalid task.whitelist: empty");
  whitelist.forEach((path) => portableRelativePath(path));
  const checkIds = textList(row.checkIds, "task.checkIds");
  if (checkIds.length === 0 || checkIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))) {
    throw new Error("invalid task.checkIds");
  }
  const checkDefinitionDigests = object(
    row.checkDefinitionDigests,
    "task.checkDefinitionDigests",
  );
  if (Object.keys(checkDefinitionDigests).length !== checkIds.length ||
    checkIds.some((id) => !SHA256.test(text(
      checkDefinitionDigests[id],
      `task.checkDefinitionDigests.${id}`,
    ))) || Object.keys(checkDefinitionDigests).some((id) => !checkIds.includes(id))) {
    throw new Error("invalid task.checkDefinitionDigests");
  }
  validateEvaluationRequirement(row.evaluation, "task.evaluation");
  const maxSteps = integer(row.maxSteps, "task.maxSteps");
  const maxTimeMs = integer(row.maxTimeMs, "task.maxTimeMs");
  const maxTokens = integer(row.maxTokens, "task.maxTokens");
  const maxCostUsd = finiteNumber(row.maxCostUsd, "task.maxCostUsd");
  if (maxSteps < 1 || maxSteps > 100 || maxTimeMs < 10 || maxTimeMs > 30 * 60_000 ||
    maxTokens < 1 || maxTokens > 10_000_000 || maxCostUsd <= 0 || maxCostUsd > 10_000) {
    throw new Error("invalid task execution budget");
  }
  if (row.maxCandidateBytes !== undefined) {
    const maxCandidateBytes = integer(row.maxCandidateBytes, "task.maxCandidateBytes");
    if (maxCandidateBytes < 1 || maxCandidateBytes > 5 * 1024 * 1024) {
      throw new Error("invalid task.maxCandidateBytes");
    }
  }
  return row as unknown as EvolutionTask;
}

export function validatePiTraceEvent(value: unknown, label = "Pi trace event"): PiTraceEvent {
  const row = object(value, label);
  exactKeys(row, [
    "eventType",
    "toolName",
    "toolCallId",
    "operationId",
    "resultDigest",
    "isError",
    "elapsedMs",
  ], label);
  boundedText(row.eventType, `${label}.eventType`, 256);
  if (row.toolName !== undefined) boundedText(row.toolName, `${label}.toolName`, 256, true);
  if (row.toolCallId !== undefined) boundedText(row.toolCallId, `${label}.toolCallId`, 512, true);
  if (row.operationId !== undefined) boundedText(row.operationId, `${label}.operationId`, 512, true);
  if (row.resultDigest !== undefined) boundedText(row.resultDigest, `${label}.resultDigest`, 512, true);
  if (row.isError !== undefined) boolean(row.isError, `${label}.isError`);
  if (row.elapsedMs !== undefined) nonNegativeNumber(row.elapsedMs, `${label}.elapsedMs`);
  if (utf8Bytes(JSON.stringify(row)) > MAX_PI_TRACE_EVENT_BYTES) {
    throw new Error(`invalid ${label}: event byte budget exceeded`);
  }
  return row as unknown as PiTraceEvent;
}

export function validatePiSessionReport(
  value: unknown,
  label = "Pi session report",
): PiSessionReport {
  const row = object(value, label);
  exactKeys(row, ["sessionId", "events", "usage"], label);
  checkedId(text(row.sessionId, `${label}.sessionId`), `${label}.sessionId`);
  const events = list(row.events, `${label}.events`);
  if (events.length > MAX_PI_TRACE_EVENTS) {
    throw new Error(`invalid ${label}.events: event count budget exceeded`);
  }
  events.forEach((event, index) =>
    validatePiTraceEvent(event, `${label}.events[${index}]`),
  );
  const usage = object(row.usage, `${label}.usage`);
  exactKeys(usage, [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "cacheWriteTokens",
    "costUsd",
  ], `${label}.usage`);
  for (const name of [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "cacheWriteTokens",
    "costUsd",
  ]) {
    nonNegativeNumber(usage[name], `${label}.usage.${name}`);
  }
  return row as unknown as PiSessionReport;
}

export function validateLedger(value: unknown): OperationLedger {
  const row = object(value, "operation ledger");
  exactKeys(row, [
    "taskId",
    "taskDigest",
    "status",
    "createdAt",
    "updatedAt",
    "steps",
    "allowedTools",
    "operations",
    "checkResults",
    "evaluation",
    "sideEffects",
    "compactionContext",
    "piReport",
    "piSession",
    "diffDigest",
    "candidateDigest",
    "recoveryBundleDigest",
    "publishedVersion",
    "publishedRevision",
    "publishedSnapshotDigest",
    "rollbackTarget",
    "error",
  ], "operation ledger");
  checkedId(text(row.taskId, "ledger.taskId"), "ledger.taskId");
  text(row.taskDigest, "ledger.taskDigest");
  enumText(row.status, EVOLUTION_STATUSES, "ledger.status");
  timestamp(row.createdAt, "ledger.createdAt");
  timestamp(row.updatedAt, "ledger.updatedAt");
  textList(row.steps, "ledger.steps");
  for (const [index, tool] of list(row.allowedTools, "ledger.allowedTools").entries()) {
    enumText(tool, RESTRICTED_TOOLS, `ledger.allowedTools[${index}]`);
  }
  for (const [index, raw] of list(row.operations, "ledger.operations").entries()) {
    const operation = object(raw, `ledger.operations[${index}]`);
    exactKeys(operation, [
      "operationId",
      "kind",
      "status",
      "replay",
      "inputDigest",
      "startedAt",
      "completedAt",
      "artifactDigest",
      "error",
    ], `ledger.operations[${index}]`);
    text(operation.operationId, `ledger.operations[${index}].operationId`);
    enumText(operation.kind, OPERATION_KINDS, `ledger.operations[${index}].kind`);
    enumText(operation.status, OPERATION_STATUSES, `ledger.operations[${index}].status`);
    enumText(operation.replay, REPLAY_POLICIES, `ledger.operations[${index}].replay`);
    text(operation.inputDigest, `ledger.operations[${index}].inputDigest`);
    timestamp(operation.startedAt, `ledger.operations[${index}].startedAt`);
    if (operation.completedAt !== undefined) {
      timestamp(operation.completedAt, `ledger.operations[${index}].completedAt`);
    }
    optionalText(operation.artifactDigest, `ledger.operations[${index}].artifactDigest`);
    if (operation.error !== undefined) validateErrorSummary(operation.error, `ledger.operations[${index}].error`);
  }
  const checkResults = list(row.checkResults, "ledger.checkResults");
  if (checkResults.length > MAX_LEDGER_CHECK_RESULTS) {
    throw new Error("invalid ledger.checkResults: item budget exceeded");
  }
  let checkOutputBytes = 0;
  checkResults.forEach((item, index) => {
    const result = validateCheckResult(item, `ledger.checkResults[${index}]`);
    checkOutputBytes += utf8Bytes(result.stdout) + utf8Bytes(result.stderr);
  });
  if (checkOutputBytes > MAX_LEDGER_CHECK_OUTPUT_BYTES) {
    throw new Error("invalid ledger.checkResults: output byte budget exceeded");
  }
  if (row.evaluation !== undefined) validateEvaluationResult(row.evaluation, "ledger.evaluation");
  textList(row.sideEffects, "ledger.sideEffects");
  text(row.compactionContext, "ledger.compactionContext", true);
  optionalText(row.diffDigest, "ledger.diffDigest");
  optionalText(row.candidateDigest, "ledger.candidateDigest");
  optionalText(row.recoveryBundleDigest, "ledger.recoveryBundleDigest");
  optionalText(row.publishedVersion, "ledger.publishedVersion");
  if (row.publishedRevision !== undefined) positiveInteger(row.publishedRevision, "ledger.publishedRevision");
  if (row.publishedSnapshotDigest !== undefined) digest(row.publishedSnapshotDigest, "ledger.publishedSnapshotDigest");
  optionalText(row.rollbackTarget, "ledger.rollbackTarget");
  if (row.error !== undefined) validateErrorSummary(row.error, "ledger.error");
  if (row.piSession !== undefined) {
    const session = object(row.piSession, "ledger.piSession");
    exactKeys(session, ["sessionId", "agentDir", "sessionDir", "eventLog"], "ledger.piSession");
    text(session.sessionId, "ledger.piSession.sessionId");
    text(session.agentDir, "ledger.piSession.agentDir");
    text(session.sessionDir, "ledger.piSession.sessionDir");
    text(session.eventLog, "ledger.piSession.eventLog");
  }
  if (row.piReport !== undefined) {
    validatePiSessionReport(row.piReport, "ledger.piReport");
  }
  return row as unknown as OperationLedger;
}

export function validateCandidate(value: unknown): SkillCandidate {
  const row = object(value, "skill candidate");
  exactKeys(row, [
    "candidateId",
    "taskId",
    "skillId",
    "baseVersion",
    "baseRevision",
    "baseSnapshotDigest",
    "candidateVersion",
    "prompt",
    "failureEvidence",
    "changedFiles",
    "baseArtifacts",
    "artifacts",
    "diff",
    "diffDigest",
    "checks",
    "evaluation",
    "changeSummary",
    "risks",
    "unresolvedIssues",
    "rollbackTarget",
    "status",
  ], "skill candidate");
  for (const field of [
    "candidateId",
    "taskId",
    "skillId",
    "baseVersion",
    "candidateVersion",
    "prompt",
    "diff",
    "diffDigest",
    "changeSummary",
    "rollbackTarget",
  ]) {
    text(row[field], `candidate.${field}`, field === "prompt" || field === "changeSummary");
  }
  for (const field of ["candidateId", "taskId", "skillId", "baseVersion", "candidateVersion", "rollbackTarget"]) {
    checkedId(row[field] as string, `candidate.${field}`);
  }
  positiveInteger(row.baseRevision, "candidate.baseRevision");
  digest(row.baseSnapshotDigest, "candidate.baseSnapshotDigest");
  textList(row.failureEvidence, "candidate.failureEvidence");
  const changedFiles = textList(row.changedFiles, "candidate.changedFiles");
  changedFiles.forEach((path) => portableRelativePath(path));
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new Error("invalid candidate.changedFiles: duplicates");
  }
  textList(row.risks, "candidate.risks");
  textList(row.unresolvedIssues, "candidate.unresolvedIssues");
  validateCandidateExplanation(
    row.changeSummary as string,
    row.risks as string[],
    row.unresolvedIssues as string[],
    "candidate",
  );
  for (const field of ["baseArtifacts", "artifacts"] as const) {
    const paths = new Set<string>();
    for (const [index, raw] of list(row[field], `candidate.${field}`).entries()) {
      const artifact = object(raw, `candidate.${field}[${index}]`);
      exactKeys(artifact, ["path", "content", "sha256", "bytes"], `candidate.${field}[${index}]`);
      const path = portableRelativePath(text(artifact.path, `candidate.${field}[${index}].path`));
      if (paths.has(path)) throw new Error(`invalid candidate.${field}: duplicate path`);
      paths.add(path);
      text(artifact.content, `candidate.${field}[${index}].content`, true);
      text(artifact.sha256, `candidate.${field}[${index}].sha256`);
      const bytes = integer(artifact.bytes, `candidate.${field}[${index}].bytes`);
      if (bytes < 0) throw new Error(`invalid candidate.${field}[${index}].bytes`);
    }
  }
  const candidateChecks = list(row.checks, "candidate.checks");
  if (candidateChecks.length > 32) throw new Error("invalid candidate.checks: item budget exceeded");
  let candidateCheckBytes = 0;
  candidateChecks.forEach((item, index) => {
    const result = validateCheckResult(item, `candidate.checks[${index}]`);
    candidateCheckBytes += utf8Bytes(result.stdout) + utf8Bytes(result.stderr);
  });
  if (candidateCheckBytes > MAX_LEDGER_CHECK_OUTPUT_BYTES) {
    throw new Error("invalid candidate.checks: output byte budget exceeded");
  }
  validateEvaluationResult(row.evaluation, "candidate.evaluation");
  enumText(row.status, new Set(["candidate", "approved", "rejected", "rolled_back"]), "candidate.status");
  return row as unknown as SkillCandidate;
}

export function validateRecoveryBundle(value: unknown): RecoveryBundle {
  const row = object(value, "recovery bundle");
  exactKeys(row, [
    "taskId",
    "createdAt",
    "changedFiles",
    "artifacts",
    "references",
    "diff",
    "diffTruncated",
    "diffDigest",
    "changeSummary",
    "risks",
    "unresolvedIssues",
    "error",
    "ledger",
  ], "recovery bundle");
  checkedId(text(row.taskId, "recovery.taskId"), "recovery.taskId");
  timestamp(row.createdAt, "recovery.createdAt");
  const changedFiles = textList(row.changedFiles, "recovery.changedFiles").map((path) => portableRelativePath(path));
  if (changedFiles.length === 0 || new Set(changedFiles).size !== changedFiles.length) {
    throw new Error("invalid recovery.changedFiles");
  }
  const artifactPaths = new Set<string>();
  const artifactDigests = new Set<string>();
  const artifacts = list(row.artifacts, "recovery.artifacts");
  if (artifacts.length > 64) throw new Error("invalid recovery.artifacts: too many files");
  let totalBytes = 0;
  for (const [index, raw] of artifacts.entries()) {
    const artifact = object(raw, `recovery.artifacts[${index}]`);
    exactKeys(artifact, ["path", "content", "sha256", "bytes"], `recovery.artifacts[${index}]`);
    const path = portableRelativePath(text(artifact.path, `recovery.artifacts[${index}].path`));
    if (artifactPaths.has(path)) throw new Error("invalid recovery.artifacts: duplicate path");
    artifactPaths.add(path);
    const content = text(artifact.content, `recovery.artifacts[${index}].content`, true);
    const bytes = integer(artifact.bytes, `recovery.artifacts[${index}].bytes`);
    if (bytes < 0 || bytes !== Buffer.byteLength(content, "utf8")) {
      throw new Error(`invalid recovery.artifacts[${index}].bytes`);
    }
    const artifactDigest = digest(artifact.sha256, `recovery.artifacts[${index}].sha256`);
    if (artifactDigest !== createHash("sha256").update(content).digest("hex")) {
      throw new Error(`invalid recovery.artifacts[${index}].sha256`);
    }
    artifactDigests.add(artifactDigest);
    totalBytes += bytes;
  }
  if (totalBytes > 256 * 1024) throw new Error("invalid recovery.artifacts: byte budget exceeded");
  const references = list(row.references, "recovery.references");
  if (references.length > 64) throw new Error("invalid recovery.references: too many files");
  const referencePaths = new Set<string>();
  let referencedBytes = 0;
  for (const [index, raw] of references.entries()) {
    const reference = object(raw, `recovery.references[${index}]`);
    exactKeys(reference, ["path", "sha256", "bytes", "objectId"], `recovery.references[${index}]`);
    const path = portableRelativePath(text(reference.path, `recovery.references[${index}].path`));
    if (artifactPaths.has(path) || referencePaths.has(path)) {
      throw new Error("invalid recovery artifact/reference path sets");
    }
    referencePaths.add(path);
    const referenceDigest = digest(reference.sha256, `recovery.references[${index}].sha256`);
    const bytes = integer(reference.bytes, `recovery.references[${index}].bytes`);
    if (bytes < 0) throw new Error(`invalid recovery.references[${index}].bytes`);
    referencedBytes += bytes;
    const objectId = text(reference.objectId, `recovery.references[${index}].objectId`);
    if (objectId !== `sha256/${referenceDigest}` || artifactDigests.has(referenceDigest)) {
      throw new Error(`invalid recovery.references[${index}].objectId`);
    }
  }
  if (referencedBytes > 5 * 1024 * 1024) throw new Error("invalid recovery.references: byte budget exceeded");
  if (artifactPaths.size + referencePaths.size === 0) {
    throw new Error("invalid recovery bundle: no recoverable changed artifacts");
  }
  const recoveredPaths = [...artifactPaths, ...referencePaths].sort();
  if (JSON.stringify(recoveredPaths) !== JSON.stringify([...changedFiles].sort())) {
    throw new Error("invalid recovery artifact/reference path sets");
  }
  const diff = text(row.diff, "recovery.diff", true);
  if (Buffer.byteLength(diff, "utf8") > 512 * 1024) throw new Error("invalid recovery.diff: byte budget exceeded");
  boolean(row.diffTruncated, "recovery.diffTruncated");
  text(row.diffDigest, "recovery.diffDigest");
  const changeSummary = text(row.changeSummary, "recovery.changeSummary", true);
  const risks = textList(row.risks, "recovery.risks");
  const unresolvedIssues = textList(row.unresolvedIssues, "recovery.unresolvedIssues");
  validateCandidateExplanation(changeSummary, risks, unresolvedIssues, "recovery");
  validateErrorSummary(row.error, "recovery.error");
  const ledger = object(row.ledger, "recovery.ledger");
  exactKeys(ledger, [
    "status",
    "steps",
    "operations",
    "checks",
    "evaluation",
    "sideEffects",
    "usage",
  ], "recovery.ledger");
  enumText(ledger.status, EVOLUTION_STATUSES, "recovery.ledger.status");
  textList(ledger.steps, "recovery.ledger.steps");
  const operationIds = new Set<string>();
  for (const [index, raw] of list(ledger.operations, "recovery.ledger.operations").entries()) {
    const operation = object(raw, `recovery.ledger.operations[${index}]`);
    exactKeys(operation, [
      "operationId",
      "kind",
      "status",
      "replay",
      "inputDigest",
      "startedAt",
      "completedAt",
      "artifactDigest",
      "error",
    ], `recovery.ledger.operations[${index}]`);
    const operationId = text(operation.operationId, `recovery.ledger.operations[${index}].operationId`);
    if (operationIds.has(operationId)) throw new Error("invalid recovery.ledger.operations: duplicate operation id");
    operationIds.add(operationId);
    enumText(operation.kind, OPERATION_KINDS, `recovery.ledger.operations[${index}].kind`);
    enumText(operation.status, OPERATION_STATUSES, `recovery.ledger.operations[${index}].status`);
    enumText(operation.replay, REPLAY_POLICIES, `recovery.ledger.operations[${index}].replay`);
    digest(operation.inputDigest, `recovery.ledger.operations[${index}].inputDigest`);
    timestamp(operation.startedAt, `recovery.ledger.operations[${index}].startedAt`);
    if (operation.completedAt !== undefined) timestamp(operation.completedAt, `recovery.ledger.operations[${index}].completedAt`);
    if (operation.artifactDigest !== undefined) digest(operation.artifactDigest, `recovery.ledger.operations[${index}].artifactDigest`);
    if (operation.error !== undefined) validateErrorSummary(operation.error, `recovery.ledger.operations[${index}].error`);
  }
  for (const [index, raw] of list(ledger.checks, "recovery.ledger.checks").entries()) {
    const check = object(raw, `recovery.ledger.checks[${index}]`);
    exactKeys(check, [
      "checkId",
      "passed",
      "timedOut",
      "outputDigest",
      "elapsedMs",
      "isolation",
    ], `recovery.ledger.checks[${index}]`);
    text(check.checkId, `recovery.ledger.checks[${index}].checkId`);
    boolean(check.passed, `recovery.ledger.checks[${index}].passed`);
    boolean(check.timedOut, `recovery.ledger.checks[${index}].timedOut`);
    digest(check.outputDigest, `recovery.ledger.checks[${index}].outputDigest`);
    nonNegativeNumber(check.elapsedMs, `recovery.ledger.checks[${index}].elapsedMs`);
    validateIsolation(check.isolation, `recovery.ledger.checks[${index}].isolation`);
  }
  if (ledger.evaluation !== undefined) validateEvaluationResult(ledger.evaluation, "recovery.ledger.evaluation");
  textList(ledger.sideEffects, "recovery.ledger.sideEffects");
  if (ledger.usage !== undefined) {
    const usage = object(ledger.usage, "recovery.ledger.usage");
    exactKeys(usage, [
      "inputTokens",
      "outputTokens",
      "cachedTokens",
      "cacheWriteTokens",
      "costUsd",
    ], "recovery.ledger.usage");
    for (const name of ["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "costUsd"]) {
      nonNegativeNumber(usage[name], `recovery.ledger.usage.${name}`);
    }
  }
  return row as unknown as RecoveryBundle;
}

export function validateDecision(value: unknown): ReviewDecision {
  const row = object(value, "review decision");
  exactKeys(row, [
    "taskId",
    "reviewerId",
    "decision",
    "candidateDigest",
    "taskDigest",
    "baseRevision",
    "baseSnapshotDigest",
    "claimedAt",
    "reason",
  ], "review decision");
  checkedId(text(row.taskId, "decision.taskId"), "decision.taskId");
  const reviewerId = text(row.reviewerId, "decision.reviewerId");
  if (reviewerId.length > 191 || /[\u0000-\u001f\u007f]/.test(reviewerId)) {
    throw new Error("invalid decision.reviewerId");
  }
  enumText(row.decision, new Set(["approve", "reject"]), "decision.decision");
  text(row.candidateDigest, "decision.candidateDigest");
  text(row.taskDigest, "decision.taskDigest");
  positiveInteger(row.baseRevision, "decision.baseRevision");
  digest(row.baseSnapshotDigest, "decision.baseSnapshotDigest");
  timestamp(row.claimedAt, "decision.claimedAt");
  const reason = optionalText(row.reason, "decision.reason");
  if (row.decision === "approve" && reason !== undefined) {
    throw new Error("invalid decision.reason: approvals cannot include a reason");
  }
  if (row.decision === "reject" && (!reason || reason.trim().length === 0)) {
    throw new Error("invalid decision.reason: rejections require a reason");
  }
  return row as unknown as ReviewDecision;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  await rename(temporary, path);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PERSISTED_JSON_BYTES) {
      throw new Error(`persisted JSON exceeds its byte budget: ${path}`);
    }
    const buffer = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PERSISTED_JSON_BYTES || offset !== metadata.size) {
      throw new Error(`persisted JSON changed or exceeds its byte budget: ${path}`);
    }
    const bytes = buffer.subarray(0, offset);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error(`persisted JSON is not valid UTF-8: ${path}`);
    }
    return JSON.parse(content) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid persisted JSON: ${path}`);
    throw error;
  } finally {
    await handle.close();
  }
}

export class EvolutionStateStore {
  readonly root: string;
  private readonly ledgerWrites = new Map<string, Promise<void>>();
  private readonly piEventBudgets = new Map<string, { count: number; bytes: number }>();

  constructor(root: string, private readonly journal?: EvolutionStateJournal) {
    this.root = resolve(root);
  }

  private taskRoot(taskId: string): string {
    return join(this.root, "tasks", checkedId(taskId, "task id"));
  }

  async hasTask(taskId: string): Promise<boolean> {
    if (await this.journal?.hasTask(taskId)) return true;
    try {
      return (await stat(this.taskRoot(taskId))).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async listTaskIds(status?: OperationLedger["status"]): Promise<string[]> {
    const journalIds = await this.journal?.listTaskIds(status) ?? [];
    const root = join(this.root, "tasks");
    const names = await readdir(root).catch(() => [] as string[]);
    const result = new Set(journalIds);
    for (const name of names.sort()) {
      if (result.has(name)) continue;
      let ledger: OperationLedger;
      try {
        ledger = await this.loadLedger(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!status || ledger.status === status) result.add(name);
    }
    return [...result].sort();
  }

  async create(task: EvolutionTask, ledger: OperationLedger): Promise<void> {
    validateTask(task);
    validateLedger(ledger);
    const root = this.taskRoot(task.taskId);
    await mkdir(join(this.root, "tasks"), { recursive: true });
    await mkdir(root, { recursive: false });
    await writeJsonAtomic(join(root, "task.json"), task);
    await writeJsonAtomic(join(root, "ledger.json"), ledger);
    await this.journal?.create(task, ledger);
  }

  async saveLedger(ledger: OperationLedger): Promise<void> {
    ledger.updatedAt = new Date().toISOString();
    const persisted = structuredClone(ledger);
    validateLedger(persisted);
    const previous = this.ledgerWrites.get(ledger.taskId) ?? Promise.resolve();
    const write = previous.then(async () => {
      await this.ensureJournalTask(ledger.taskId, persisted);
      await this.journal?.saveLedger(persisted);
      await writeJsonAtomic(join(this.taskRoot(ledger.taskId), "ledger.json"), persisted);
    });
    this.ledgerWrites.set(ledger.taskId, write);
    try {
      await write;
    } finally {
      if (this.ledgerWrites.get(ledger.taskId) === write) {
        this.ledgerWrites.delete(ledger.taskId);
      }
    }
  }

  async loadLedger(taskId: string): Promise<OperationLedger> {
    const expectedTaskId = checkedId(taskId, "task id");
    const journalLedger = await this.journal?.loadLedger(expectedTaskId);
    if (journalLedger) {
      const ledger = validateLedger(journalLedger);
      if (ledger.taskId !== expectedTaskId) throw new Error("persisted ledger task ID does not match its task directory");
      return ledger;
    }
    const ledger = validateLedger(await readJson(join(this.taskRoot(expectedTaskId), "ledger.json")));
    if (ledger.taskId !== expectedTaskId) throw new Error("persisted ledger task ID does not match its task directory");
    return ledger;
  }

  async loadTask(taskId: string): Promise<EvolutionTask> {
    const expectedTaskId = checkedId(taskId, "task id");
    const journalTask = await this.journal?.loadTask(expectedTaskId);
    if (journalTask) {
      const task = validateTask(journalTask);
      if (task.taskId !== expectedTaskId) throw new Error("persisted task ID does not match its task directory");
      return task;
    }
    const task = validateTask(await readJson(join(this.taskRoot(expectedTaskId), "task.json")));
    if (task.taskId !== expectedTaskId) throw new Error("persisted task ID does not match its task directory");
    return task;
  }

  async saveCandidate(candidate: SkillCandidate): Promise<void> {
    validateCandidate(candidate);
    await this.ensureJournalTask(candidate.taskId);
    await this.journal?.saveCandidate(candidate);
    await writeJsonAtomic(join(this.taskRoot(candidate.taskId), "candidate.json"), candidate);
  }

  async loadCandidate(taskId: string): Promise<SkillCandidate> {
    const expectedTaskId = checkedId(taskId, "task id");
    const journalCandidate = await this.journal?.loadCandidate(expectedTaskId);
    if (journalCandidate) {
      const candidate = validateCandidate(journalCandidate);
      if (candidate.taskId !== expectedTaskId) {
        throw new Error("persisted candidate task ID does not match its task directory");
      }
      return candidate;
    }
    const candidate = validateCandidate(await readJson(join(this.taskRoot(expectedTaskId), "candidate.json")));
    if (candidate.taskId !== expectedTaskId) {
      throw new Error("persisted candidate task ID does not match its task directory");
    }
    return candidate;
  }

  async saveRecoveryBundle(bundle: RecoveryBundle): Promise<void> {
    validateRecoveryBundle(bundle);
    for (const reference of bundle.references) {
      await this.loadRecoveryObject(bundle.taskId, reference);
    }
    await writeJsonAtomic(join(this.taskRoot(bundle.taskId), "recovery.json"), bundle);
  }

  async loadRecoveryBundle(taskId: string): Promise<RecoveryBundle> {
    const expectedTaskId = checkedId(taskId, "task id");
    const bundle = validateRecoveryBundle(
      await readJson(join(this.taskRoot(expectedTaskId), "recovery.json")),
    );
    if (bundle.taskId !== expectedTaskId) {
      throw new Error("persisted recovery bundle task ID does not match its task directory");
    }
    for (const reference of bundle.references) {
      await this.loadRecoveryObject(expectedTaskId, reference);
    }
    return bundle;
  }

  async saveRecoveryObjects(
    taskId: string,
    artifacts: CandidateArtifact[],
  ): Promise<RecoveryArtifactReference[]> {
    const expectedTaskId = checkedId(taskId, "task id");
    if (artifacts.length > 64) throw new Error("too many recovery objects");
    let totalBytes = 0;
    const paths = new Set<string>();
    const references: RecoveryArtifactReference[] = [];
    for (const artifact of [...artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
      const path = portableRelativePath(artifact.path);
      if (paths.has(path)) throw new Error("duplicate recovery object path");
      paths.add(path);
      const bytes = Buffer.byteLength(artifact.content, "utf8");
      if (artifact.bytes !== bytes || artifact.sha256 !== createHash("sha256").update(artifact.content).digest("hex")) {
        throw new Error("recovery object failed digest or size validation");
      }
      totalBytes += bytes;
      if (totalBytes > 5 * 1024 * 1024) throw new Error("recovery objects exceed byte budget");
      const objectId = `sha256/${artifact.sha256}`;
      const objectPath = join(this.taskRoot(expectedTaskId), "quarantine", ...objectId.split("/"));
      await mkdir(dirname(objectPath), { recursive: true });
      try {
        const handle = await open(objectPath, "wx");
        try {
          await handle.writeFile(artifact.content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stored = await readFile(objectPath, "utf8");
      if (Buffer.byteLength(stored, "utf8") !== bytes ||
        createHash("sha256").update(stored).digest("hex") !== artifact.sha256) {
        throw new Error("quarantined recovery object failed integrity validation");
      }
      references.push({ path, sha256: artifact.sha256, bytes, objectId });
    }
    return references;
  }

  async loadRecoveryObject(taskId: string, reference: RecoveryArtifactReference): Promise<string> {
    const expectedTaskId = checkedId(taskId, "task id");
    const path = portableRelativePath(reference.path);
    const digestValue = digest(reference.sha256, "recovery reference sha256");
    const bytes = integer(reference.bytes, "recovery reference bytes");
    if (bytes < 0 || reference.objectId !== `sha256/${digestValue}`) {
      throw new Error("invalid recovery object reference");
    }
    const objectPath = join(this.taskRoot(expectedTaskId), "quarantine", ...reference.objectId.split("/"));
    const content = await readFile(objectPath, "utf8");
    if (Buffer.byteLength(content, "utf8") !== bytes ||
      createHash("sha256").update(content).digest("hex") !== digestValue) {
      throw new Error(`quarantined recovery object failed integrity validation: ${path}`);
    }
    return content;
  }

  async preparePiSession(taskId: string): Promise<PiSessionPersistence> {
    const root = join(this.taskRoot(taskId), "pi");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    const eventLog = join(root, "events.jsonl");
    await mkdir(agentDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(eventLog, "", { encoding: "utf8", flag: "wx" });
    return {
      sessionId: checkedId(
        `evolution-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`,
        "Pi session id",
      ),
      agentDir,
      sessionDir,
      eventLog,
    };
  }

  appendPiEvent(taskId: string, event: PiTraceEvent): void {
    validatePiTraceEvent(event);
    const expectedTaskId = checkedId(taskId, "task id");
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    const lineBytes = utf8Bytes(line);
    if (lineBytes > MAX_PI_TRACE_EVENT_BYTES + 128) {
      throw new Error("Pi event log entry exceeds its byte budget");
    }
    const eventLog = join(this.taskRoot(expectedTaskId), "pi", "events.jsonl");
    let budget = this.piEventBudgets.get(expectedTaskId);
    if (!budget) {
      const bytes = statSync(eventLog).size;
      if (bytes > MAX_PI_EVENT_LOG_BYTES) throw new Error("Pi event log exceeds its persistence budget");
      const content = readFileSync(eventLog, "utf8");
      budget = { count: content.split("\n").length - 1, bytes };
    }
    if (budget.count >= MAX_PI_TRACE_EVENTS || budget.bytes + lineBytes > MAX_PI_EVENT_LOG_BYTES) {
      throw new Error("Pi event log exceeds its persistence budget");
    }
    appendFileSync(eventLog, line, {
      encoding: "utf8",
      flag: "a",
      flush: true,
    });
    this.piEventBudgets.set(expectedTaskId, {
      count: budget.count + 1,
      bytes: budget.bytes + lineBytes,
    });
  }

  async withReviewLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(this.taskRoot(taskId), ".review.lock");
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const metadata = await stat(lockPath).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === "ENOENT") return undefined;
          throw statError;
        });
        if (metadata && Date.now() - metadata.mtimeMs >= REVIEW_LOCK_STALE_MS) {
          const ledger = await this.loadLedger(taskId);
          ledger.status = "needs_manual_recovery";
          ledger.error = summarizeError(
            new Error("a stale review lock indicates an interrupted review, publish, or rollback operation"),
            [this.root],
          );
          ledger.steps.push("stale_review_lock_audit_required");
          await this.saveLedger(ledger);
          throw new StaleReviewLockError("stale review lock requires manual recovery");
        }
        throw new Error("review decision is busy or requires manual recovery");
      }
      throw error;
    }
    try {
      await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      await lock.sync();
      return await action();
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async claimReviewDecision(decision: ReviewDecision): Promise<void> {
    validateDecision(decision);
    await this.ensureJournalTask(decision.taskId);
    await this.journal?.claimReviewDecision(decision);
    try {
      await writeJsonExclusive(join(this.taskRoot(decision.taskId), "review-decision.json"), decision);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("a review decision has already been recorded for this task");
      }
      throw error;
    }
  }

  async loadReviewDecision(taskId: string): Promise<ReviewDecision | undefined> {
    try {
      const expectedTaskId = checkedId(taskId, "task id");
      const journalDecision = await this.journal?.loadReviewDecision(expectedTaskId);
      if (journalDecision) {
        const decision = validateDecision(journalDecision);
        if (decision.taskId !== expectedTaskId) {
          throw new Error("persisted review task ID does not match its task directory");
        }
        return decision;
      }
      const decision = validateDecision(
        await readJson(join(this.taskRoot(expectedTaskId), "review-decision.json")),
      );
      if (decision.taskId !== expectedTaskId) {
        throw new Error("persisted review task ID does not match its task directory");
      }
      return decision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.ledgerWrites.values());
    await this.journal?.close?.();
  }

  private async ensureJournalTask(taskId: string, ledger?: OperationLedger): Promise<void> {
    if (!this.journal || await this.journal.hasTask(taskId)) return;
    const expectedTaskId = checkedId(taskId, "task id");
    const task = validateTask(await readJson(join(this.taskRoot(expectedTaskId), "task.json")));
    const persistedLedger = ledger ?? validateLedger(
      await readJson(join(this.taskRoot(expectedTaskId), "ledger.json")),
    );
    await this.journal.create(task, persistedLedger);
  }
}
