/** Semantic batch identity, replay, persistence and trace metadata. */
import { skillMetadata, type ProductSkill } from "../agent/skill-registry.js";
import { skillExecutionIdentity, modelExecutionIdentity } from "./execution-identity.js";
import { type StructuredWorkerResult } from "../agent/structured-worker.js";
import { isWorkerFailureCode, WorkerExecutionError } from "../agent/worker-failure.js";
import { type PiModelRuntime } from "../agent/types.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { nowIso } from "../domain/conversation.js";
import { createSemanticBatch, digestSemanticBatch, type SemanticBatchDescriptor } from "../domain/semantic-batch.js";
import { type SemanticBatchContext, type SemanticWorkerRun } from "./semantic-contracts.js";

export function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0;index < rows.length;index += size) result.push(rows.slice(index, index + size));
  return result;
}

/** The registry owns contract versions for both execution checks and cache identity. */
type RecordedSkillId = "component-explanation" | "architecture-planning" | "repository-value-discovery" | "snapshot-language-overlay";

export function semanticRunContract(skillId: RecordedSkillId) {
  const { inputSchemaId, outputSchemaId, contextBuilderId } = skillMetadata(skillId);
  return { inputSchemaId, outputSchemaId, contextBuilderId };
}

export function semanticBatchInputIdentity(input: unknown, runtime: PiModelRuntime, skillId: RecordedSkillId, selectedSkill?: ProductSkill, thinkingLevel: ThinkingLevel = "medium") {
  const skill = selectedSkill ?? runtime.skills?.[skillId];
  const metadata = skill ?? skillMetadata(skillId);
  return {
    input, execution_contract: {
      skill: `${metadata.id}@${metadata.version}`, context: metadata.contextBuilderId,
      input_schema: metadata.inputSchemaId, output_schema: metadata.outputSchemaId,
      ...(skill ? { loaded_skill: skillExecutionIdentity(skill) } : {}),
      ...modelExecutionIdentity(runtime), thinking_level: thinkingLevel,
    }
  };
}

export function cachedStructuredResult<T>(value: unknown): StructuredWorkerResult<T> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!("value" in row) || typeof row.stopReason !== "string" || typeof row.skillVersion !== "string") return null;
  return row as unknown as StructuredWorkerResult<T>;
}

export function structuredBatchFailure(value: unknown): { reason: string; status: "failed" | "cancelled" } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!("value" in row) || typeof row.stopReason !== "string" || typeof row.skillVersion !== "string") return null;
  if (row.value !== null) {
    const result = row.value as { mode?: string; value_points?: unknown[] } | undefined;
    if (result?.mode === "components" && Array.isArray(row.validationErrors)
      && row.validationErrors.some(error => typeof error === "string" && error.startsWith("component_"))) {
      return { reason: "component_validation_failed", status: "failed" };
    }
    if (row.skillId === "snapshot-language-overlay") {
      return Array.isArray(row.validationErrors) && row.validationErrors.some(error => typeof error === "string" && error.startsWith("overlay_structure_"))
        ? { reason: "language_overlay_structure_failed", status: "failed" } : null;
    }
    if (Array.isArray(result?.value_points) && Array.isArray(row.validationErrors)
      && row.validationErrors.some((error) => typeof error === "string" && error.startsWith("value_reference_"))) {
      return { reason: "value_reference_validation_failed", status: "failed" };
    }
    if (Array.isArray(result?.value_points) && Array.isArray(row.validationErrors)
      && row.validationErrors.some((error) => typeof error === "string" && error.startsWith("value_candidate_"))) {
      return { reason: "value_candidate_validation_failed", status: "failed" };
    }
    if (result?.mode === "layers" && Array.isArray(row.validationErrors) && row.validationErrors.length) {
      return { reason: "layer_validation_failed", status: "failed" };
    }
    return null;
  }
  return {
    reason: row.stopReason,
    status: row.stopReason === "cancelled" ? "cancelled" : "failed",
  };
}

/**
 * Replays a completed semantic batch when its deterministic input digest still
 * matches; otherwise it records a new attempt and runs the provider call.
 */
export async function runRecordedSemanticBatch<T>(input: {
  descriptor: SemanticBatchDescriptor;
  context?: SemanticBatchContext;
  run: () => Promise<T>;
  decode?: (value: unknown) => T | null;
}): Promise<T> {
  const digest = input.context ? digestSemanticBatch(input.descriptor.input) : null;
  const existing = await input.context?.recorder.load(
    input.descriptor.job_id,
    input.descriptor.batch_id,
  );
  if (existing
    && existing.status === "succeeded"
    && existing.input_digest === digest
    && existing.output !== null) {
    const decoded = input.decode ? input.decode(existing.output) : existing.output as T;
    if (decoded !== null && decoded !== undefined && !structuredBatchFailure(decoded)) {
      await input.context?.batchProgress?.complete(true);
      return decoded;
    }
  }
  if (input.context) await input.context.recorder.start(createSemanticBatch(input.descriptor, 0, null, null, nowIso()));
  let failureRecorded = false;
  try {
    await input.context?.batchProgress?.start();
    const output = await input.run();
    const failure = structuredBatchFailure(output);
    if (failure) {
      await input.context?.recorder.fail(input.descriptor.batch_id, failure.reason, failure.status, output);
      failureRecorded = true;
      if (isWorkerFailureCode(failure.reason)) throw new WorkerExecutionError(failure.reason);
      await input.context?.batchProgress?.complete(false);
      return output;
    }
    await input.context?.recorder.complete(
      input.descriptor.batch_id,
      output,
      digestSemanticBatch(output),
    );
    await input.context?.batchProgress?.complete(false);
    return output;
  } catch (error) {
    const reason = error instanceof WorkerExecutionError ? error.code : "semantic_batch_failed";
    if (!failureRecorded) await input.context?.recorder.fail(
      input.descriptor.batch_id,
      reason,
      error instanceof Error && /cancel|abort/i.test(error.message) ? "cancelled" : "failed",
    ).catch(() => undefined);
    throw error;
  }
}

export function architectureTrace(
  result: StructuredWorkerResult<{ mode: "components" | "layers" }>,
  input: {
    mode: "components" | "layers";
    batchId: string;
    requested: number;
    covered: number;
    toolsUsed: string[];
    displayLanguage: string;
  },
): SemanticWorkerRun {
  const stopReason = input.covered === input.requested
    ? result.stopReason
    : `${result.stopReason}:coverage:${input.covered}/${input.requested}`;
  return {
    skill_id: input.mode === "components" ? "component-explanation" : "architecture-planning",
    skill_version: result.skillVersion,
    model: result.model, provider: result.provider,
    stop_reason: result.validationErrors.length
      ? `${stopReason}:${input.mode === "layers" ? "validation_failed_after_retry" : "language_mismatch_after_retry"}`
      : stopReason,
    eval_suite: result.evalSuite,
    display_language: input.displayLanguage,
    validation_errors: result.validationErrors,
    mode: input.mode,
    batch_id: input.batchId,
    requested_component_count: input.requested,
    covered_component_count: input.covered,
    tools_used: input.toolsUsed,
  };
}
