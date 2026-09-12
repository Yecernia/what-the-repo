/** Prepare and explain bounded component batches. */
import { createRepositoryExplorationTools } from "../agent/repository-exploration-tools.js";
import { runStructuredWorker } from "../agent/structured-worker.js";
import { runtimeForSkill } from "../agent/role-models.js";
import { loadProductSkill } from "../agent/skill-registry.js";
import { type PiModelRuntime } from "../agent/types.js";
import { displayLanguageInstruction, displayLanguageLabel } from "../domain/display-language.js";
import { type SnapshotEdge, type SnapshotNode } from "../domain/snapshot.js";
import { type BuiltSnapshot } from "./graph.js";
import {
  architectureTrace,
  cachedStructuredResult,
  runRecordedSemanticBatch,
  semanticBatchInputIdentity,
  semanticRunContract,
} from "./semantic-batch-runner.js";
import {
  ARCHITECTURE_BATCH_SIZE,
  COMPONENT_WORKER_RESULT,
  COMPONENT_FACT_RESULT,
  type ComponentFactResult,
  type ComponentPatch,
  type ComponentWorkerResult,
  MAX_REPAIR_COMPONENTS,
  MAX_REPAIR_MISSING_RATIO,
  type SemanticBatchContext,
  type SemanticWorkerRun,
  componentLanguageError,
} from "./semantic-contracts.js";
import { componentById, componentOverviews, componentSections, prepareOverviewExcerpts, seedEvidence, sourceReader } from "./semantic-snapshot.js";

/**
 * Select only bounded, partial-coverage misses for a single repair pass.
 * Whole-batch provider failures are systemic signals, not a reason to fan out
 * dozens of smaller retries.
 */
export function selectRepairComponentIds(
  results: ReadonlyArray<{
    missing: readonly string[];
    trace: Pick<SemanticWorkerRun, "stop_reason" | "requested_component_count" | "covered_component_count">;
  }>,
  totalComponents: number,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const requested = Math.max(
      0,
      result.trace.requested_component_count ?? result.missing.length + (result.trace.covered_component_count ?? 0),
    );
    const covered = Math.max(0, result.trace.covered_component_count ?? requested - result.missing.length);
    const missingCount = result.missing.length;
    if (!requested || !missingCount || !covered) continue;
    if (missingCount / requested > MAX_REPAIR_MISSING_RATIO) continue;
    if (/structured_output_missing|provider_request_failed|provider_transient_error/u.test(result.trace.stop_reason)) continue;
    for (const componentId of result.missing) {
      if (seen.has(componentId)) continue;
      seen.add(componentId);
      selected.push(componentId);
      if (selected.length >= MAX_REPAIR_COMPONENTS) return selected;
    }
  }
  if (totalComponents > 0 && selected.length / totalComponents > MAX_REPAIR_MISSING_RATIO) return [];
  return selected;
}

export function architectureComponentBatches(
  snapshot: { graph: { nodes: SnapshotNode[]; edges: SnapshotEdge[] } },
  batchSize = ARCHITECTURE_BATCH_SIZE,
): string[][] {
  const componentNodes = snapshot.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component");
  const adjacency = new Map<string, Array<{ id: string; weight: number }>>();
  const componentIds = new Set(componentNodes.map((node) => node.id));
  for (const node of componentNodes) adjacency.set(node.id, []);
  for (const edge of snapshot.graph.edges) {
    if (!componentIds.has(edge.source) || !componentIds.has(edge.target)) continue;
    adjacency.get(edge.source)?.push({ id: edge.target, weight: edge.weight });
    adjacency.get(edge.target)?.push({ id: edge.source, weight: edge.weight });
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
  }
  const ranked = componentNodes
    .slice()
    .sort((left, right) =>
      ((adjacency.get(right.id)?.length ?? 0) - (adjacency.get(left.id)?.length ?? 0))
      || right.member_count - left.member_count
      || left.id.localeCompare(right.id))
    .map((node) => node.id);
  const remaining = new Set(ranked);
  const batches: string[][] = [];
  while (remaining.size) {
    const batch: string[] = [];
    const queued = new Set<string>();
    const queue: string[] = [];
    const enqueue = (componentId: string | undefined): void => {
      if (componentId && remaining.has(componentId) && !queued.has(componentId)) {
        queue.push(componentId);
        queued.add(componentId);
      }
    };
    enqueue(ranked.find((componentId) => remaining.has(componentId)));
    while (batch.length < batchSize && remaining.size) {
      if (!queue.length) enqueue(ranked.find((componentId) => remaining.has(componentId)));
      const current = queue.shift();
      if (!current || !remaining.delete(current)) continue;
      batch.push(current);
      for (const neighbor of adjacency.get(current) ?? []) enqueue(neighbor.id);
    }
    if (batch.length) batches.push(batch);
  }
  return batches;
}

export function componentScope(snapshot: BuiltSnapshot, targetIds: string[]): Set<string> {
  const result = new Set(targetIds);
  for (const edge of snapshot.graph.edges) {
    if (result.has(edge.source) || result.has(edge.target)) {
      result.add(edge.source);
      result.add(edge.target);
    }
  }
  return result;
}

export function componentBatchInput(
  snapshot: BuiltSnapshot,
  componentIds: string[],
  batchId: string,
  repair: boolean,
  displayLanguage: string,
): Record<string, unknown> {
  const nodes = componentById(snapshot);
  const target = new Set(componentIds);
  return {
    mode: "components",
    batch_id: batchId,
    repair_batch: repair,
    display_language: displayLanguage,
    display_language_label: displayLanguageLabel(displayLanguage),
    repository: snapshot.repository,
    summary: snapshot.summary,
    languages: snapshot.languages,
    required_component_ids: componentIds,
    components: componentIds.flatMap((componentId) => {
      const component = nodes.get(componentId);
      if (!component) return [];
      const adjacent = snapshot.graph.edges.filter((edge) => edge.source === componentId || edge.target === componentId);
      return [{
        component_id: component.id,
        current_name: component.name,
        current_responsibility: component.responsibility,
        structural_group: component.attributes?.structural_group ?? null,
        overview_evidence: componentOverviews(component),
        member_sections: componentSections(component),
        member_count: component.member_count,
        sample_members: component.members.slice(0, 6).map((row) => ({
          evidence_id: row.stable_id,
          path: row.path,
          label: row.label,
          start_line: row.start_line,
          end_line: row.end_line,
        })),
        evidence_ids: component.evidence.slice(0, 8).map((row) => row.stable_id),
        internal_relation_count: adjacent.filter((edge) => target.has(edge.source) && target.has(edge.target)).length,
        external_relation_count: adjacent.filter((edge) => !target.has(edge.source) || !target.has(edge.target)).length,
        fan_in: component.fan_in,
        fan_out: component.fan_out,
      }];
    }),
  };
}

export async function prepareComponentBatchInput(
  snapshot: BuiltSnapshot, componentIds: string[], batchId: string, repair: boolean, displayLanguage: string,
) {
  const input = componentBatchInput(snapshot, componentIds, batchId, repair, displayLanguage);
  const diagnostics = await prepareOverviewExcerpts(snapshot, input.components as Array<Record<string, unknown>>, true);
  return { input, diagnostics };
}

export function validateComponentSubmission(value: ComponentWorkerResult | ComponentFactResult, componentIds: string[], language: string): string[] {
  if (value.mode !== "components") return ["component_mode: 需要组件结果"];
  const required = new Set(componentIds), seen = new Set<string>(), errors: string[] = [];
  for (const patch of value.components) {
    if (!required.has(patch.component_id)) errors.push(`component_unknown: ${patch.component_id}`);
    if (seen.has(patch.component_id)) errors.push(`component_duplicate: ${patch.component_id}`);
    seen.add(patch.component_id);
    const languageError = componentLanguageError(patch, language);
    if (languageError) errors.push(`language_mismatch: ${patch.component_id}：${languageError}`);
  }
  const missing = componentIds.filter((id) => !seen.has(id));
  if (missing.length) errors.push(`component_missing: ${missing.join(", ")}；先补充相关证据，仍无法可靠判断时可保留部分结果，不能编造职责`);
  return [...new Set(errors)];
}

export async function runComponentBatch(input: {
  snapshot: BuiltSnapshot;
  componentIds: string[];
  batchId: string;
  ordinal: number;
  repair: boolean;
  deferLayerPlanning?: boolean;
  displayLanguage: string;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
  batchContext?: SemanticBatchContext;
}): Promise<{ patches: ComponentPatch[]; missing: string[]; trace: SemanticWorkerRun }> {
  input = { ...input, modelRuntime: runtimeForSkill(input.modelRuntime, "component-explanation") };
  const target = new Set(input.componentIds);
  const productSkill = input.modelRuntime.skills?.["component-explanation"] ?? await loadProductSkill("component-explanation");
  const scope = componentScope(input.snapshot, input.componentIds);
  const seed = seedEvidence(input.snapshot, target);
  const repository = createRepositoryExplorationTools({
    snapshot: input.snapshot,
    readLines: sourceReader(input.snapshot),
    allowedComponentIds: scope,
    seedEvidenceIds: seed.evidenceIds,
    seedPaths: seed.paths,
  });
  const prepared = await prepareComponentBatchInput(
    input.snapshot,
    input.componentIds,
    input.batchId,
    input.repair,
    input.displayLanguage,
  );
  const batchInput = input.deferLayerPlanning
    ? { ...prepared.input, layer_planning: "global" }
    : prepared.input;
  const result = await runRecordedSemanticBatch({
    descriptor: {
      batch_id: input.batchId,
      job_id: input.batchContext?.jobId ?? "semantic-untracked",
      snapshot_id: input.snapshot.snapshot_id,
      phase: input.repair ? "architecture_repair" : "architecture_components",
      ordinal: input.ordinal,
      input: semanticBatchInputIdentity(batchInput, input.modelRuntime, "component-explanation", productSkill),
    },
    context: input.batchContext,
    run: () => runStructuredWorker({
      productSkill,
      diagnosticIdentity: { jobId: input.batchContext?.jobId ?? "semantic-untracked", jobAttempt: input.batchContext?.jobAttempt ?? 0, batchId: input.batchId },
      skillId: "component-explanation",
      ...semanticRunContract("component-explanation"),
      modelRuntime: input.modelRuntime,
      signal: input.signal,
      thinkingLevel: "medium",
      schema: input.deferLayerPlanning ? COMPONENT_FACT_RESULT : COMPONENT_WORKER_RESULT,
      repairTextFields: ["name", "responsibility", "grouping_rationale", "layer_name", "layer_rationale"],
      tools: repository.tools,
      systemPrompt: [
        displayLanguageInstruction(input.displayLanguage),
        "程序锁定组件边界、成员、关系方向、Evidence ID 和输出 Schema。",
        ...(input.deferLayerPlanning ? ["layer_planning=global：本批只解释组件职责、成员归组与实现差异，不拟架构层名或层归属理由；最终分层由后续完整全局材料统一决定。"] : []),
        "输入已列出本批所有组件及完整member_sections目录覆盖，overview_excerpt是带位置的受限文档材料。先了解整个组件的成员角色，再按矛盾和缺口查实现；不能把最先读到的子包当成全部职责，也不重复列举已完整给出的组件清单。",
        input.repair
          ? "本轮是 component semantics repair 模式；只补充 required_component_ids 中尚未覆盖的组件，并用仓库工具补足判断。"
          : "本轮是 component semantics 模式；只返回 required_component_ids 中的组件，并用仓库工具补足判断。",
        "必须调用 submit_result，mode 必须是 components。",
      ].join("\n"),
      userPrompt: JSON.stringify(batchInput),
      validateSubmitted: (value) => validateComponentSubmission(value, input.componentIds, input.displayLanguage),
    }),
    decode: (value) => cachedStructuredResult<ComponentWorkerResult | ComponentFactResult>(value),
  });
  const patches: ComponentPatch[] = [];
  const seen = new Set<string>();
  if (result.value?.mode === "components") {
    for (const patch of result.value.components ?? []) {
      if (!target.has(patch.component_id) || seen.has(patch.component_id)) continue;
      seen.add(patch.component_id);
      patches.push(patch);
    }
  }
  const missing = input.componentIds.filter((componentId) => !seen.has(componentId));
  const trace = architectureTrace(result, {
    mode: "components",
    batchId: input.batchId,
    requested: input.componentIds.length,
    covered: patches.length,
    toolsUsed: repository.state.toolsUsed,
    displayLanguage: input.displayLanguage,
  });
  trace.evidence_preparation = prepared.diagnostics;
  return {
    patches,
    missing,
    trace,
  };
}
