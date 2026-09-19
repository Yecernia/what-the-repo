/** Orchestrate the existing analysis stages; public entry points remain stable. */
import { type PiModelRuntime } from "../agent/types.js";
import type { WebResearchClient } from "../agent/web-research-tools.js";
import { DEFAULT_DISPLAY_LANGUAGE } from "../domain/display-language.js";
import { applyArchitectureResult } from "./architecture-assembly.js";
import { architectureComponentBatches, runComponentBatch, selectRepairComponentIds } from "./architecture-components.js";
import { componentLayerCandidates, consolidateLayers, globalLayerInputBudget, layerSemanticView } from "./architecture-layers.js";
import { type BuiltSnapshot } from "./graph.js";
import { chunks } from "./semantic-batch-runner.js";
import {
  ARCHITECTURE_REPAIR_BATCH_SIZE,
  type ComponentPatch,
  type SemanticBatchContext,
  type SemanticResult,
  type SemanticWorkerRun,
  componentLanguageError,
} from "./semantic-contracts.js";
import { applyValueDiscoveryResult, discoverValues } from "./value-discovery.js";
import type { InitialWebResearch } from "./initial-web-research.js";
import { trackAnalysisStage } from "./progress.js";

interface ArchitectureOutcome {
  snapshot: BuiltSnapshot;
  stopReason: string;
  workerRuns: SemanticWorkerRun[];
}

interface ComponentOutcome {
  patches: Map<string, ComponentPatch>;
  workerRuns: SemanticWorkerRun[];
  componentAssignments: boolean;
  failureReason: string | null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  abort: (error: unknown) => void,
): Promise<R[]> {
  if (!values.length) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), values.length);
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index] as T, index);
    }
  };
  const tasks = Array.from({ length: workerCount }, () => worker());
  try { await Promise.all(tasks); }
  catch (error) {
    failed = true;
    abort(error);
    await Promise.allSettled(tasks);
    throw error;
  }
  return results;
}

async function explainArchitectureComponents(
  snapshot: BuiltSnapshot,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  displayLanguage = DEFAULT_DISPLAY_LANGUAGE,
  batchContext?: SemanticBatchContext,
): Promise<ComponentOutcome> {
  const patches = new Map<string, ComponentPatch>();
  const workerRuns: SemanticWorkerRun[] = [];
  const componentController = new AbortController();
  const componentSignal = signal ? AbortSignal.any([signal, componentController.signal]) : componentController.signal;

  // Choose before paid component work so small-context/large repositories retain
  // the existing batched planner, including its preliminary layer explanations.
  const units = componentLayerCandidates(snapshot);
  const preflight = units.length && !signal?.aborted
    ? await globalLayerInputBudget(snapshot, units, displayLanguage, modelRuntime, true, true)
    : null;
  const componentAssignments = preflight?.fits === true;

  const componentBatches = architectureComponentBatches(snapshot);
  const componentResults = await trackAnalysisStage("explaining_components", batchContext, scoped => mapWithConcurrency(
    componentBatches,
    modelRuntime.analysisBatchConcurrency ?? 3,
    (batch, batchIndex) => runComponentBatch({
      snapshot,
      componentIds: batch,
      batchId: `component-batch-${batchIndex + 1}`,
      ordinal: batchIndex,
      repair: false,
      deferLayerPlanning: componentAssignments,
      displayLanguage,
      modelRuntime,
      signal: componentSignal,
      batchContext: scoped,
    }),
    (error) => componentController.abort(error),
  ), { batches: true, totalBatches: componentBatches.length, signal: componentSignal,
    status: results => results.some(result => result.trace.covered_component_count !== result.trace.requested_component_count) ? "degraded" : "completed" });
  for (const result of componentResults) {
    result.patches.forEach((patch) => patches.set(patch.component_id, patch));
    workerRuns.push(result.trace);
  }

  const totalComponents = snapshot.graph.nodes
    .filter((node) => (node.entity_kind ?? "component") === "component")
    .length;
  const repairComponentIds = selectRepairComponentIds(componentResults, totalComponents);
  const repairBatches = signal?.aborted
    ? []
    : chunks(repairComponentIds, ARCHITECTURE_REPAIR_BATCH_SIZE);
  const repairResults = repairBatches.length ? await trackAnalysisStage("repairing_components", batchContext, scoped => mapWithConcurrency(
    repairBatches,
    modelRuntime.analysisBatchConcurrency ?? 3,
    (batch, repairIndex) => runComponentBatch({
      snapshot,
      componentIds: batch,
      batchId: `component-repair-${repairIndex + 1}`,
      ordinal: 5_000 + repairIndex,
      repair: true,
      deferLayerPlanning: componentAssignments,
      displayLanguage,
      modelRuntime,
      signal: componentSignal,
      batchContext: scoped,
    }),
    (error) => componentController.abort(error),
  ), { batches: true, totalBatches: repairBatches.length, signal: componentSignal,
    status: results => results.some(result => result.trace.covered_component_count !== result.trace.requested_component_count) ? "degraded" : "completed" }) : [];
  for (const result of repairResults) {
    result.patches.forEach((patch) => {
      patches.set(patch.component_id, patch);
    });
    workerRuns.push(result.trace);
  }

  // Let parallel batches finish and persist first. Missing explanations must not
  // become static placeholders in an otherwise "successful" published snapshot.
  const unresolved = [...componentResults, ...repairResults]
    .filter(result => result.missing.some(id => !patches.has(id)));
  const failureReason = patches.size >= totalComponents ? null
    : unresolved.find(result => result.trace.stop_reason.startsWith("provider_request_failed"))?.trace.stop_reason
      ?? unresolved.find(result => result.trace.stop_reason.startsWith("provider_transient_error"))?.trace.stop_reason
      ?? "component_semantics_incomplete";
  return { patches, workerRuns, componentAssignments, failureReason };
}

async function finishArchitecture(
  snapshot: BuiltSnapshot,
  components: ComponentOutcome,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  displayLanguage = DEFAULT_DISPLAY_LANGUAGE,
  batchContext?: SemanticBatchContext,
): Promise<ArchitectureOutcome> {
  const { patches, componentAssignments } = components;
  const workerRuns = [...components.workerRuns];
  if (components.failureReason && !signal?.aborted) {
    return {
      snapshot,
      stopReason: components.failureReason,
      workerRuns,
    };
  }

  const layers = patches.size
    ? await trackAnalysisStage("planning_architecture", batchContext,
      scoped => consolidateLayers({ snapshot, patches, componentAssignments, displayLanguage, modelRuntime, signal, batchContext: scoped }),
      { batches: true, signal, status: result => result.degraded ? "degraded" : "completed" })
    : { patches, scopes: [], directComponentIds: [], workerRuns: [], degraded: false };
  workerRuns.push(...layers.workerRuns);
  const failedLayer = layers.workerRuns.find(run => /^provider_(request_failed|transient_error)/u.test(run.stop_reason));
  if (failedLayer && !signal?.aborted) return { snapshot, stopReason: failedLayer.stop_reason, workerRuns };
  const supportedIds = new Set([...layers.patches]
    .filter(([, patch]) => !componentLanguageError(patch, displayLanguage))
    .map(([componentId]) => componentId));
  const degradedIds = snapshot.graph.nodes
    .filter((node) => (node.entity_kind ?? "component") === "component")
    .map((node) => node.id)
    .filter((componentId) => !supportedIds.has(componentId));
  const enriched = await trackAnalysisStage("assembling_architecture", batchContext, () => applyArchitectureResult(snapshot, {
    components: [...layers.patches.values()],
    scopes: layers.scopes.map(({ layerGroupId: _layerGroupId, ...scope }) => scope),
    direct_component_ids: layers.directComponentIds,
  }, {
    supportedIds,
    degradedIds,
  }), { signal, status: () => degradedIds.length || layers.degraded ? "degraded" : "completed" });
  const layerTrace = layers.workerRuns.at(-1);
  if (layerTrace) {
    const scopes = enriched.graph.nodes.filter((node) => node.entity_kind === "domain");
    const signature = (ids: string[]) => [...ids].sort().join("\0");
    const retained = new Set(scopes.filter((node) => node.certainty === "provider_supported")
      .map((node) => signature(node.attributes?.component_ids as string[] ?? [])));
    const accepted = layers.scopes.filter((scope) => retained.has(signature(scope.component_ids))).length;
    const layerIds = new Set(enriched.graph.nodes.filter((node) => node.entity_kind === "system").map((node) => node.id));
    layerTrace.scope_postprocessing = {
      proposed: layers.scopes.length, accepted, rejected: layers.scopes.length - accepted,
      fallback: scopes.filter((node) => node.certainty !== "provider_supported").length,
      direct: enriched.graph.nodes.filter((node) => node.entity_kind === "component" && layerIds.has(node.parent_entity_id ?? "")).length,
    };
  }
  const complete = degradedIds.length === 0 && !layers.degraded && !signal?.aborted;
  return {
    snapshot: enriched,
    stopReason: complete
      ? "completed"
      : signal?.aborted
        ? "cancelled"
        : `partial:${supportedIds.size}/${snapshot.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component").length}`,
    workerRuns,
  };
}

/** Public architecture-only entry remains useful for bounded local comparisons. */
export async function enrichArchitecture(
  snapshot: BuiltSnapshot,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  displayLanguage = DEFAULT_DISPLAY_LANGUAGE,
  batchContext?: SemanticBatchContext,
): Promise<ArchitectureOutcome> {
  const components = await explainArchitectureComponents(snapshot, modelRuntime, signal, displayLanguage, batchContext);
  return finishArchitecture(snapshot, components, modelRuntime, signal, displayLanguage, batchContext);
}

/** Value evidence uses stable components; provisional/display grouping is not an input dependency. */
function valueComponentView(snapshot: BuiltSnapshot, patches: Map<string, ComponentPatch>, language: string): BuiltSnapshot {
  const view = layerSemanticView(snapshot, patches, language);
  const nodes = view.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component")
    .map((node) => ({ ...node, parent_entity_id: null, depth: 0,
      architecture_layer_id: null, architecture_layer_name: null,
      architecture_layer_candidates: [], architecture_layer_rationale: null }));
  const ids = new Set(nodes.map((node) => node.id));
  return { ...view, graph: { ...view.graph, nodes,
    edges: view.graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    layers: [], hierarchy: { root_entity_ids: [...ids], max_depth: 0 } } };
}

export async function enrichSnapshotWithPi(
  snapshot: BuiltSnapshot,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  displayLanguage = DEFAULT_DISPLAY_LANGUAGE,
  batchContext?: SemanticBatchContext,
  webResearch?: WebResearchClient,
  initialWebResearch?: Promise<InitialWebResearch>,
): Promise<{ snapshot: BuiltSnapshot; stopReason: string; workerRuns: SemanticWorkerRun[] }> {
  const components = await explainArchitectureComponents(snapshot, modelRuntime, signal, displayLanguage, batchContext);
  if (signal?.aborted || components.failureReason || components.patches.size === 0) {
    const architecture = await finishArchitecture(snapshot, components, modelRuntime, signal, displayLanguage, batchContext);
    return {
      snapshot: architecture.snapshot,
      stopReason: signal?.aborted ? "cancelled" : `architecture:${architecture.stopReason};values:skipped`,
      workerRuns: architecture.workerRuns,
    };
  }

  const siblingController = new AbortController();
  const branchSignal = signal ? AbortSignal.any([signal, siblingController.signal]) : siblingController.signal;
  const architectureTask = finishArchitecture(snapshot, components, modelRuntime, branchSignal, displayLanguage, batchContext);
  const valueTask = trackAnalysisStage("discovering_values", batchContext, scoped => discoverValues({
    snapshot: valueComponentView(snapshot, components.patches, displayLanguage),
    modelRuntime,
    signal: branchSignal,
    displayLanguage,
    batchContext: scoped,
    webResearch,
    initialWebResearch,
  }), { batches: true, totalBatches: 1, signal: branchSignal,
    status: result => result.stopReason === "completed" ? "completed" : "degraded" });
  let architecture: ArchitectureOutcome;
  let values: Awaited<ReturnType<typeof discoverValues>>;
  try {
    [architecture, values] = await Promise.all([architectureTask, valueTask]);
  } catch (error) {
    siblingController.abort();
    await Promise.allSettled([architectureTask, valueTask]);
    throw error;
  }
  return trackAnalysisStage("merging_analysis", batchContext, () => ({
    stopReason: signal?.aborted ? "cancelled" : architecture.stopReason === "completed" && values.stopReason === "completed"
      ? "completed"
      : `architecture:${architecture.stopReason};values:${values.stopReason}`,
    snapshot: { ...architecture.snapshot,
      value_points: values.snapshot.value_points, learning_plan: values.snapshot.learning_plan,
      ...(values.snapshot.research ? { research: values.snapshot.research } : {}) },
    workerRuns: [...architecture.workerRuns, values.workerRun],
  }), { signal });
}

export function applySemanticResult(
  snapshot: BuiltSnapshot,
  result: SemanticResult,
): BuiltSnapshot {
  return applyValueDiscoveryResult(
    applyArchitectureResult(snapshot, { components: result.components }),
    { value_points: result.value_points },
  );
}

export { applyArchitectureResult } from "./architecture-assembly.js";
export { architectureComponentBatches, selectRepairComponentIds } from "./architecture-components.js";
export {
  consolidateLayers,
  initialLayerCandidates,
  layerBatchInput,
  layerRelationSummary,
  layerSemanticView,
  prepareLayerBatchInput,
  runLayerBatch
} from "./architecture-layers.js";
export { runRecordedSemanticBatch, semanticBatchInputIdentity } from "./semantic-batch-runner.js";
export {
  componentLanguageError,
  type ArchitectureSemanticResult,
  type ComponentPatch,
  type LayerCandidate,
  type LayerWorkerResult,
  type ResponsibilityScopePatch,
  type SemanticBatchContext,
  type SemanticResult,
  type SemanticWorkerRun,
  type ValueDiscoveryResult
} from "./semantic-contracts.js";
export { applyValueDiscoveryResult } from "./value-discovery.js";

export { validateLayerSubmission } from "./architecture-layer-plan.js";
