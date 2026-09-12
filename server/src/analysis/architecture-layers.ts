import { skillPrompt, loadProductSkill } from "../agent/skill-registry.js";
import { semanticInputBudget } from "./semantic-input-budget.js";
import { layerAssignments, normalizeGlobalLayerResult, validateLayerSubmission } from "./architecture-layer-plan.js";
/** Prepare, validate and execute evidence-backed layer plans. */
import { createRepositoryExplorationTools } from "../agent/repository-exploration-tools.js";
import { runStructuredWorker } from "../agent/structured-worker.js";
import { runtimeForSkill } from "../agent/role-models.js";
import { TEXT_REPAIR_DEFINITION } from "../agent/text-submission-repair.js";
import { type PiModelRuntime } from "../agent/types.js";
import { displayLanguageInstruction, displayLanguageLabel } from "../domain/display-language.js";
import { componentAffinity } from "./architecture-assembly.js";
import { type BuiltSnapshot } from "./graph.js";
import {
  architectureTrace,
  cachedStructuredResult,
  chunks,
  runRecordedSemanticBatch,
  semanticBatchInputIdentity,
  semanticRunContract,
} from "./semantic-batch-runner.js";
import {
  type ComponentPatch,
  LAYER_BATCH_SIZE,
  LAYER_WORKER_RESULT,
  GLOBAL_LAYER_RESULT,
  type LayerCandidate,
  type LayerWorkerResult,
  MAX_ARCHITECTURE_LAYERS,
  MAX_COMPONENTS_PER_SCOPE,
  MAX_COMPONENT_REASSIGNMENTS,
  MAX_LAYER_ROUNDS,
  MAX_SCOPE_MODEL_COMPONENTS,
  MAX_SECOND_LEVEL_ITEMS,
  type SemanticBatchContext,
  type SemanticWorkerRun,
  type WorkerScopeProposal,
  componentLanguageError
} from "./semantic-contracts.js";
import { componentById, componentOverviews, componentSections, id, prepareOverviewExcerpts, seedEvidence, sourceReader } from "./semantic-snapshot.js";

export function initialLayerCandidates(snapshot: BuiltSnapshot, patches: Map<string, ComponentPatch>): LayerCandidate[] {
  const groups = new Map<string, LayerCandidate>();
  for (const component of snapshot.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component")) {
    const patch = patches.get(component.id);
    const name = patch?.layer_name?.trim() || component.architecture_layer_name?.trim() || "共享基础层";
    const key = name.toLocaleLowerCase();
    const existing = groups.get(key) ?? {
      id: `layer-candidate:${id(key)}`,
      name,
      responsibility: patch?.layer_responsibility ?? `组织“${name}”中的相关组件。`,
      rationale: patch?.layer_rationale?.trim() || component.architecture_layer_rationale?.trim() || "当前仅保留批次内的分层依据。",
      componentIds: [],
    };
    existing.componentIds.push(component.id);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** A small semantic view; members, relations and the full fact graph stay shared. */
export function layerSemanticView(snapshot: BuiltSnapshot, patches: ReadonlyMap<string, ComponentPatch>, language: string): BuiltSnapshot {
  return {
    ...snapshot, graph: {
      ...snapshot.graph, nodes: snapshot.graph.nodes.map((node) => {
        const patch = patches.get(node.id);
        if (!patch || componentLanguageError(patch, language)) return node;
        return {
          ...node, name: patch.name, responsibility: patch.responsibility,
          grouping_rationale: patch.grouping_rationale ?? node.grouping_rationale,
          architecture_layer_name: patch.layer_name ?? node.architecture_layer_name,
          architecture_layer_rationale: patch.layer_rationale ?? node.architecture_layer_rationale,
          certainty: "provider_supported",
        };
      })
    }
  };
}

/** Component IDs are the assignment units, without preliminary layer guesses. */
export function componentLayerCandidates(snapshot: BuiltSnapshot): LayerCandidate[] {
  return snapshot.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component")
    .map((node) => ({ id: node.id, name: node.name, responsibility: node.responsibility,
      rationale: node.grouping_rationale ?? "", componentIds: [node.id] }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function layerRelationSummary(snapshot: BuiltSnapshot, candidates: LayerCandidate[]) {
  const components = new Set(snapshot.graph.nodes.filter((node) => (node.entity_kind ?? "component") === "component").map((node) => node.id));
  const candidateByComponent = new Map(candidates.flatMap((candidate) => candidate.componentIds.map((componentId) => [componentId, candidate.id] as const)));
  const rows = new Map<string, { source: string; target: string; kind: string; relation_count: number; weight: number; relation_ids: string[]; evidence_ids: string[];
    component_edge_certainty_counts: Record<string, number>; extractors: string[];
    evidence_samples: Array<{ evidence_id: string; path: string; start_line: number | null; source_component_id: string; target_component_id: string; edge_certainty: string }> }>();
  let externalRelations = 0;
  for (const edge of snapshot.graph.edges) {
    if (!components.has(edge.source) || !components.has(edge.target)) continue;
    const source = candidateByComponent.get(edge.source);
    const target = candidateByComponent.get(edge.target);
    if (!source || !target) { if (source || target) externalRelations++; continue; }
    const kind = edge.relation_kind;
    const key = JSON.stringify([source, target, kind]);
    const row = rows.get(key) ?? { source, target, kind, relation_count: 0, weight: 0, relation_ids: [], evidence_ids: [],
      component_edge_certainty_counts: {}, extractors: [], evidence_samples: [] };
    row.relation_count++;
    row.weight += edge.weight;
    row.component_edge_certainty_counts[edge.certainty] = (row.component_edge_certainty_counts[edge.certainty] ?? 0) + 1;
    for (const observation of edge.source_observations ?? []) {
      if (typeof observation.extractor === "string" && !row.extractors.includes(observation.extractor) && row.extractors.length < 8) row.extractors.push(observation.extractor);
    }
    if (row.relation_ids.length < 2) row.relation_ids.push(edge.id);
    for (const evidence of edge.evidence) {
      if (row.evidence_ids.length >= 2) break;
      if (!row.evidence_ids.includes(evidence.stable_id)) {
        row.evidence_ids.push(evidence.stable_id);
        row.evidence_samples.push({ evidence_id: evidence.stable_id, path: evidence.path, start_line: evidence.start_line,
          source_component_id: edge.source, target_component_id: edge.target, edge_certainty: edge.certainty });
      }
    }
    rows.set(key, row);
  }
  return {
    relations: [...rows.values()].sort((a, b) => JSON.stringify([a.source, a.target, a.kind]).localeCompare(JSON.stringify([b.source, b.target, b.kind]))),
    external_relation_count: externalRelations,
    evidence_sampling: "方向/计数完整，ID/位置仅是样本。可信程度按组件边统计；verified表示至少一项绑定已确认，不表示所有支持记录都已确认或一定在运行时执行。degraded为待核实候选，不可单独据此断言职责。类型导入、测试和文档须区分；自环为原候选内部关系。缺边不证明没有调用，未解析数量见relation_resolution。",
    relation_resolution: { unresolved_syntax_calls: snapshot.summary.unresolved_syntax_call_count ?? null, unresolved_imports: snapshot.summary.unresolved_import_count ?? null },
  };
}

/** Sample IDs are already in evidence_ids; null endpoints inherit the row's endpoints. */
export function compactLayerRelations(summary: ReturnType<typeof layerRelationSummary>) {
  const { relations, ...metadata } = summary;
  const columns = ["source", "target", "kind", "relation_count", "weight", "relation_ids", "evidence_ids", "component_edge_certainty_counts", "extractors", "evidence_samples"] as const;
  const evidenceColumns = ["path", "start_line", "source_component_id", "target_component_id", "edge_certainty"] as const;
  return {
    ...metadata,
    relation_columns: columns,
    relation_evidence_columns: evidenceColumns,
    relation_encoding: "每行按relation_columns读取；第i个evidence_samples的位置对应第i个evidence_ids。样本source_component_id/target_component_id为null时继承本行source/target，否则使用样本中的原组件ID。所有ID均为原始ID，可直接查询和提交。",
    relations: relations.map((row) => columns.map((column) => column === "evidence_samples"
      ? row.evidence_samples.map((sample) => [sample.path, sample.start_line,
        sample.source_component_id === row.source ? null : sample.source_component_id,
        sample.target_component_id === row.target ? null : sample.target_component_id, sample.edge_certainty]) : row[column])),
  };
}

export function layerBatchInput(
  snapshot: BuiltSnapshot,
  candidates: LayerCandidate[],
  batchId: string,
  displayLanguage: string,
  includeScopes: boolean,
  componentAssignments = false,
): Record<string, unknown> {
  const nodes = componentById(snapshot);
  const allComponentIds = candidates.flatMap((candidate) => candidate.componentIds);
  const componentRows = candidates.flatMap((candidate) => candidate.componentIds.flatMap((componentId) => {
    const node = nodes.get(componentId);
    if (!node) return [];
    return [{
      component_id: node.id,
      layer_candidate_id: candidate.id,
      name: node.name,
      responsibility: node.responsibility,
      grouping_rationale: node.grouping_rationale,
      layer_rationale: node.architecture_layer_rationale,
      semantics_status: node.certainty,
      member_count: node.members.length,
      structural_group: typeof node.attributes?.structural_group === "string"
        ? node.attributes.structural_group
        : null,
      evidence_ids: [...new Set([...node.evidence, ...node.members].map((row) => row.stable_id))].slice(0, 8),
      overview_evidence: componentOverviews(node),
      member_sections: componentSections(node),
    }];
  })).slice(0, MAX_SCOPE_MODEL_COMPONENTS);
  if (componentAssignments) {
    if (!includeScopes || allComponentIds.length > MAX_SCOPE_MODEL_COMPONENTS
      || candidates.some((candidate) => candidate.componentIds.length !== 1 || candidate.componentIds[0] !== candidate.id)) {
      throw new Error("global_layer_assignment_scope_invalid");
    }
    return {
      mode: "layers", assignment_mode: "components", batch_id: batchId,
      display_language: displayLanguage, display_language_label: displayLanguageLabel(displayLanguage),
      repository: snapshot.repository, required_component_ids: allComponentIds,
      scope_component_limit: MAX_COMPONENTS_PER_SCOPE, max_second_level_items_per_layer: MAX_SECOND_LEVEL_ITEMS,
      ...compactLayerRelations(layerRelationSummary(snapshot, candidates)),
      components: componentRows.map(({ layer_candidate_id: _candidate, layer_rationale: _rationale, ...row }) => row),
    };
  }
  return {
    mode: "layers",
    batch_id: batchId,
    display_language: displayLanguage,
    display_language_label: displayLanguageLabel(displayLanguage),
    repository: snapshot.repository,
    required_candidate_ids: candidates.map((candidate) => candidate.id),
    component_manifest: candidates.map((candidate) => ({ candidate_id: candidate.id, component_ids: candidate.componentIds })),
    component_reassignment_limit: includeScopes ? MAX_COMPONENT_REASSIGNMENTS : 0,
    ...compactLayerRelations(layerRelationSummary(snapshot, candidates)),
    ...(includeScopes ? {
      scope_component_limit: MAX_COMPONENTS_PER_SCOPE,
      max_second_level_items_per_layer: MAX_SECOND_LEVEL_ITEMS,
      scope_components: componentRows,
      omitted_scope_component_ids: allComponentIds.slice(MAX_SCOPE_MODEL_COMPONENTS),
    } : { component_summaries: componentRows }),
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.id,
      current_name: candidate.name,
      current_responsibility: candidate.responsibility,
      grouping_basis: "按组件候选层名归集；各组件的层理由只适用于自身，整层共性需重新核对全部成员职责。",
      component_count: candidate.componentIds.length,
      sample_component_ids: candidate.componentIds.slice(0, 8),
    })),
  };
}

/** Read one bounded overview per component, retaining its exact evidence location. */
export async function prepareLayerBatchInput(
  snapshot: BuiltSnapshot, candidates: LayerCandidate[], batchId: string, language: string, includeScopes: boolean,
  componentAssignments = false,
) {
  const input = layerBatchInput(snapshot, candidates, batchId, language, includeScopes, componentAssignments);
  const rows = (componentAssignments ? input.components : includeScopes ? input.scope_components : input.component_summaries) as Array<Record<string, unknown>>;
  const diagnostics = await prepareOverviewExcerpts(snapshot, rows);
  return { input, diagnostics };
}

export function layerSystemPrompt(displayLanguage: string, includeScopes: boolean, componentAssignments = false): string {
  if (componentAssignments) return [
    displayLanguageInstruction(displayLanguage),
    "assignment_mode=components：完整组件语义已经提供，直接统一决定最终架构层和层内职责；没有候选层需要映射或纠正。程序锁定组件、成员和事实关系。",
    "只返回layers，每层包含name、responsibility、rationale、scopes和direct_component_ids。职责组嵌在所属层内，无须编造组ID、父层ID或重复提交归属映射。",
    "全部required_component_ids必须恰好出现一次：或在某层的某个scope.component_ids内，或在该层的direct_component_ids内；不能遗漏、重复或引用其他组件，也不能生成空层。",
    `每个scope含同层2-${MAX_COMPONENTS_PER_SCOPE}个具有共同职责的组件，保留name、responsibility、rationale及相关evidence_ids；独立职责放direct_component_ids，不生成单组件scope。每层scopes加direct组件不得超过${MAX_SECOND_LEVEL_ITEMS}项。`,
    "scope证据必须属于其成员或内部关系；先按职责、实现边界与可信关系决定归属，再写能容纳全部成员的说明。发现矛盾才按需查证，不能把部分成员的生命周期或用途推广到整层。",
    "必须调用submit_result，mode必须为layers。不要使用Cluster、Other或编号占位名称。",
  ].join("\n");
  return [
        displayLanguageInstruction(displayLanguage),
        "程序锁定组件、成员和事实关系。候选层是前批建议，先映射语义相近的候选层，再根据证据纠正个别组件的层归属。",
        "每个 required_candidate_id 必须映射到一个已定义 group_id；不同候选可以映射到同一组。",
        ...(includeScopes ? [
          `component_reassignments最多${MAX_COMPONENT_REASSIGNMENTS}项，每项指定component_id、目标group_id、纠正理由和相关evidence_ids。无须纠正则返回空数组；整组调整使用mappings。可以定义有明确职责的新group，但不能输出空层。`,
          "只有当前scope_components中的组件可以纠正；引用该组件成员或相邻关系的证据，说明原分层矛盾及目标层职责。需要核实行为时读取必要实现，不能为了维护旧分组否定已有运行时角色。",
          "同时返回 scopes 和 direct_component_ids，二者必须完整且不重复地覆盖 scope_components 中每个组件。",
          "scopes按纠正后的归属生成；层与职责说明必须容纳实际保留的全部成员，不能沿用与纠正相矛盾的旧说明。",
          `每个 scope 只能包含同一架构层内的 2-${MAX_COMPONENTS_PER_SCOPE} 个 component_id，并给出职责、归组理由和本输入中的 Evidence ID；确实没有同职责伙伴的组件放入 direct_component_ids，不要包成单组件 scope。`,
          `每个架构层的 scopes 数量加 direct component 数量不得超过 ${MAX_SECOND_LEVEL_ITEMS}。scopes 不是事实实体，不能新增或改写组件、文件、符号和关系。不要使用 Cluster、Other、未分层或编号占位名称。`,
        ] : ["中间归并component_reassignments、scopes和direct_component_ids均返回空数组；最终归并再纠正个别组件。"]),
        "必须调用 submit_result，mode 必须是 layers。",
      ].join("\n");
}

/** Consider one complete final pass only when all members and the reserved conversation fit. */
export async function globalLayerInputBudget(snapshot: BuiltSnapshot, candidates: LayerCandidate[], language: string, runtime: PiModelRuntime, componentAssignments = false, reserveSemantics = false) {
  runtime = runtimeForSkill(runtime, "architecture-planning");
  if (candidates.length > MAX_SCOPE_MODEL_COMPONENTS
    || candidates.reduce((sum, candidate) => sum + candidate.componentIds.length, 0) > MAX_SCOPE_MODEL_COMPONENTS) return null;
  const scope = new Set(candidates.flatMap((candidate) => candidate.componentIds));
  const seed = seedEvidence(snapshot, scope);
  const repository = createRepositoryExplorationTools({ snapshot, readLines: sourceReader(snapshot), allowedComponentIds: scope,
    componentRelationsDefault: false, seedEvidenceIds: seed.evidenceIds, seedPaths: seed.paths });
  const prepared = await prepareLayerBatchInput(snapshot, candidates, "layer-global-final", language, true, componentAssignments);
  const { prompt } = await skillPrompt("architecture-planning", layerSystemPrompt(language, true, componentAssignments), runtime.skills?.["architecture-planning"]);
  // Include the actual method, dynamic instructions and every tool schema, including submission.
  const context = JSON.stringify({ systemPrompt: prompt, userPrompt: JSON.stringify(prepared.input),
    tools: [...repository.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      { name: "submit_result", description: "提交最终结构化结果。必须调用这个工具。", parameters: componentAssignments ? GLOBAL_LAYER_RESULT : LAYER_WORKER_RESULT },
      TEXT_REPAIR_DEFINITION] });
  // Allow natural-language fields at their length limits (3 UTF-8 bytes per
  // code unit). This is a planning allowance, not a worst-case escaping bound;
  // the complete actual material is rechecked before the final request.
  const semanticReserveBytes = reserveSemantics ? candidates.length * (80 + 400 + 500) * 3 : 0;
  return semanticInputBudget(context, runtime.model, semanticReserveBytes);
}

export async function runLayerBatch(input: {
  snapshot: BuiltSnapshot;
  patches?: ReadonlyMap<string, ComponentPatch>;
  candidates: LayerCandidate[];
  batchId: string;
  ordinal: number;
  includeScopes?: boolean;
  componentAssignments?: boolean;
  displayLanguage: string;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
  batchContext?: SemanticBatchContext;
}): Promise<{ candidates: LayerCandidate[]; scopes: WorkerScopeProposal[]; directComponentIds: string[]; reassignments: LayerWorkerResult["component_reassignments"]; trace: SemanticWorkerRun }> {
  input = { ...input, modelRuntime: runtimeForSkill(input.modelRuntime, "architecture-planning") };
  const snapshot = layerSemanticView(input.snapshot, input.patches ?? new Map(), input.displayLanguage);
  const scope = new Set(input.candidates.flatMap((candidate) => candidate.componentIds));
  const seed = seedEvidence(snapshot, scope);
  const repository = createRepositoryExplorationTools({
    snapshot,
    readLines: sourceReader(snapshot),
    allowedComponentIds: scope,
    componentRelationsDefault: false,
    seedEvidenceIds: seed.evidenceIds,
    seedPaths: seed.paths,
  });
  const prepared = await prepareLayerBatchInput(
    snapshot,
    input.candidates,
    input.batchId,
    input.displayLanguage,
    input.includeScopes === true,
    input.componentAssignments === true,
  );
  const batchInput = prepared.input;
  const productSkill = input.modelRuntime.skills?.["architecture-planning"] ?? await loadProductSkill("architecture-planning");
  const result = await runRecordedSemanticBatch({
    descriptor: {
      batch_id: input.batchId,
      job_id: input.batchContext?.jobId ?? "semantic-untracked",
      snapshot_id: input.snapshot.snapshot_id,
      phase: "architecture_layers",
      ordinal: input.ordinal,
      input: semanticBatchInputIdentity(batchInput, input.modelRuntime, "architecture-planning", productSkill),
    },
    context: input.batchContext,
    run: async () => {
      const common = {
      productSkill,
      diagnosticIdentity: { jobId: input.batchContext?.jobId ?? "semantic-untracked", jobAttempt: input.batchContext?.jobAttempt ?? 0, batchId: input.batchId },
      skillId: "architecture-planning",
      ...semanticRunContract("architecture-planning"),
      modelRuntime: input.modelRuntime,
      signal: input.signal,
      thinkingLevel: "medium",
      repairTextFields: ["name", "responsibility", "rationale"],
      tools: repository.tools,
      systemPrompt: layerSystemPrompt(input.displayLanguage, input.includeScopes === true, input.componentAssignments === true),
      userPrompt: JSON.stringify(batchInput),
      } as const;
      const validate = (value: LayerWorkerResult) => validateLayerSubmission(value, snapshot, input.candidates, input.includeScopes === true, input.displayLanguage);
      if (input.componentAssignments) {
        const result = await runStructuredWorker({ ...common, schema: GLOBAL_LAYER_RESULT,
          validateSubmitted: (value) => validate(normalizeGlobalLayerResult(value)) });
        return { ...result, value: result.value ? normalizeGlobalLayerResult(result.value) : null };
      }
      return runStructuredWorker({ ...common, schema: LAYER_WORKER_RESULT, validateSubmitted: validate });
    },
    decode: (value) => cachedStructuredResult<LayerWorkerResult>(value),
  });
  const output: LayerCandidate[] = [];
  const scopes: WorkerScopeProposal[] = [];
  let covered = 0;
  const accepted = result.value?.mode === "layers" && !result.validationErrors.length ? result.value : null;
  if (accepted) {
    const assignments = layerAssignments(accepted, input.candidates);
    for (const group of accepted.groups) {
      const componentIds = [...assignments].filter(([, groupId]) => groupId === group.group_id).map(([componentId]) => componentId).sort();
      if (!componentIds.length) continue;
      output.push({
        id: `layer-candidate:${id(JSON.stringify({ batch: input.batchId, group: group.name, componentIds }))}`,
        name: group.name,
        responsibility: group.responsibility,
        rationale: group.rationale,
        componentIds,
      });
    }
    covered = input.candidates.length;
    const candidateLayerByComponent = new Map<string, string>();
    for (const candidate of output) {
      for (const componentId of candidate.componentIds) candidateLayerByComponent.set(componentId, candidate.id);
    }
    for (const scope of input.includeScopes ? accepted.scopes : []) {
      const componentIds = [...new Set(scope.component_ids)]
        .filter((componentId) => candidateLayerByComponent.has(componentId));
      if (componentIds.length < 2 || componentIds.length > MAX_COMPONENTS_PER_SCOPE) continue;
      const layerIds = [...new Set(componentIds.map((componentId) => candidateLayerByComponent.get(componentId)))];
      if (layerIds.length !== 1) continue;
      scopes.push({
        name: scope.name,
        responsibility: scope.responsibility,
        grouping_rationale: scope.rationale,
        component_ids: componentIds,
        evidence_ids: [...new Set(scope.evidence_ids)],
        layerGroupId: layerIds[0] as string,
      });
    }
  } else {
    output.push(...input.candidates);
  }
  const trace = architectureTrace(result, {
    mode: "layers",
    batchId: input.batchId,
    requested: input.candidates.length,
    covered,
    toolsUsed: repository.state.toolsUsed,
    displayLanguage: input.displayLanguage,
  });
  const omitted = input.includeScopes ? Math.max(0, scope.size - MAX_SCOPE_MODEL_COMPONENTS) : 0;
  trace.evidence_preparation = prepared.diagnostics;
  trace.layer_assignment_mode = input.componentAssignments ? "components" : "candidates";
  trace.component_reassignment_count = accepted?.component_reassignments.length ?? 0;
  trace.scope_input_omitted_count = omitted;
  if (omitted) trace.stop_reason += `:scope_input_omitted:${omitted}`;
  return {
    candidates: output,
    scopes,
    directComponentIds: accepted?.direct_component_ids ?? [],
    reassignments: accepted?.component_reassignments ?? [],
    trace,
  };
}

export function mergeLayerCandidatesDeterministically(
  snapshot: BuiltSnapshot,
  candidates: LayerCandidate[],
): LayerCandidate[] {
  const nodes = componentById(snapshot);
  const relationWeights = new Map<string, number>();
  for (const edge of snapshot.graph.edges) {
    const key = [edge.source, edge.target].sort().join("\0");
    relationWeights.set(key, (relationWeights.get(key) ?? 0) + Math.max(1, edge.weight));
  }
  let current = candidates.map((candidate) => ({ ...candidate, componentIds: [...new Set(candidate.componentIds)] }));
  const target = Math.min(MAX_SECOND_LEVEL_ITEMS, Math.max(1, Math.min(MAX_ARCHITECTURE_LAYERS, current.length)));
  while (current.length > target) {
    let best: { left: number; right: number; score: number; key: string } | null = null;
    for (let leftIndex = 0;leftIndex < current.length;leftIndex += 1) {
      for (let rightIndex = leftIndex + 1;rightIndex < current.length;rightIndex += 1) {
        const left = current[leftIndex] as LayerCandidate;
        const right = current[rightIndex] as LayerCandidate;
        let score = 0;
        for (const leftId of left.componentIds) {
          for (const rightId of right.componentIds) {
            const leftNode = nodes.get(leftId);
            const rightNode = nodes.get(rightId);
            if (leftNode && rightNode) score = Math.max(score, componentAffinity(leftNode, rightNode, relationWeights));
          }
        }
        const key = `${left.id}|${right.id}`;
        if (!best || score > best.score || (score === best.score && key < best.key)) {
          best = { left: leftIndex, right: rightIndex, score, key };
        }
      }
    }
    if (!best) break;
    const left = current[best.left] as LayerCandidate;
    const right = current[best.right] as LayerCandidate;
    const primary = left.componentIds.length >= right.componentIds.length ? left : right;
    const secondary = primary === left ? right : left;
    const merged: LayerCandidate = {
      id: `layer-candidate:${id(JSON.stringify({ merged: [left.id, right.id].sort() }))}`,
      name: primary.name,
      responsibility: primary.responsibility || secondary.responsibility,
      rationale: `${primary.rationale}；并吸收与其关系最接近的 ${secondary.name}。`,
      componentIds: [...new Set([...left.componentIds, ...right.componentIds])].sort(),
    };
    current = current.filter((_candidate, index) => index !== best?.left && index !== best?.right);
    current.push(merged);
  }
  return current;
}

export async function consolidateLayers(input: {
  snapshot: BuiltSnapshot;
  patches: Map<string, ComponentPatch>;
  componentAssignments?: boolean;
  displayLanguage: string;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
  batchContext?: SemanticBatchContext;
}): Promise<{ patches: Map<string, ComponentPatch>; scopes: WorkerScopeProposal[]; directComponentIds: string[]; workerRuns: SemanticWorkerRun[]; degraded: boolean }> {
  let current = input.componentAssignments ? componentLayerCandidates(input.snapshot) : initialLayerCandidates(input.snapshot, input.patches);
  const workerRuns: SemanticWorkerRun[] = [];
  let scopeProposals: WorkerScopeProposal[] = [];
  let directComponentIds: string[] = [];
  let correctionRationales = new Map<string, string>();
  let degraded = false;
  let round = 0;
  const initialCandidateCount = current.length;
  const budget = input.componentAssignments || current.length > LAYER_BATCH_SIZE
    ? await globalLayerInputBudget(layerSemanticView(input.snapshot, input.patches, input.displayLanguage), current, input.displayLanguage, input.modelRuntime, input.componentAssignments)
    : null;
  const directGlobal = budget?.fits === true;
  if (input.componentAssignments && !directGlobal && current.length <= LAYER_BATCH_SIZE) {
    // No useful intermediate reduction remains. Keep completed component batches
    // recoverable and report capacity instead of sending an oversized final call.
    throw new Error("global_layer_assignment_budget_exceeded");
  }
  while (!directGlobal && current.length > LAYER_BATCH_SIZE && round < MAX_LAYER_ROUNDS && !input.signal?.aborted) {
    const next: LayerCandidate[] = [];
    const before = current.length;
    let batchIndex = 0;
    for (const batch of chunks(current, LAYER_BATCH_SIZE)) {
      const result = await runLayerBatch({
        snapshot: input.snapshot,
        patches: input.patches,
        candidates: batch,
        batchId: `layer-round-${round + 1}-${batchIndex + 1}`,
        ordinal: 10_000 + round * 1_000 + batchIndex,
        includeScopes: false,
        displayLanguage: input.displayLanguage,
        modelRuntime: input.modelRuntime,
        signal: input.signal,
        batchContext: input.batchContext,
      });
      next.push(...result.candidates);
      scopeProposals.push(...result.scopes);
      workerRuns.push(result.trace);
      if (result.trace.covered_component_count !== result.trace.requested_component_count || result.trace.validation_errors?.length) degraded = true;
      batchIndex += 1;
    }
    current = next;
    round += 1;
    if (current.length >= before) {
      degraded = true;
      break;
    }
  }
  if (current.length > 0 && (directGlobal || current.length <= LAYER_BATCH_SIZE) && !input.signal?.aborted) {
    const final = await runLayerBatch({
      snapshot: input.snapshot,
      patches: input.patches,
      candidates: current,
      batchId: "layer-global-final",
      ordinal: 20_000,
      includeScopes: true,
      componentAssignments: input.componentAssignments && directGlobal,
      displayLanguage: input.displayLanguage,
      modelRuntime: input.modelRuntime,
      signal: input.signal,
      batchContext: input.batchContext,
    });
    current = final.candidates;
    scopeProposals = final.scopes;
    directComponentIds = final.directComponentIds;
    correctionRationales = new Map(final.reassignments.map((correction) => [correction.component_id, correction.rationale]));
    if (budget) final.trace.layer_input_budget = { ...budget, initialCandidateCount, directGlobal };
    workerRuns.push(final.trace);
    if (final.trace.covered_component_count !== final.trace.requested_component_count || final.trace.validation_errors?.length || final.trace.scope_input_omitted_count) degraded = true;
  } else if (current.length > LAYER_BATCH_SIZE) {
    degraded = true;
  }

  if (current.length > MAX_SECOND_LEVEL_ITEMS && !input.signal?.aborted) {
    current = mergeLayerCandidatesDeterministically(input.snapshot, current);
    degraded = true;
  }

  const nextPatches = new Map(input.patches);
  for (const layer of current) {
    for (const componentId of layer.componentIds) {
      const patch = nextPatches.get(componentId);
      if (!patch) continue;
      nextPatches.set(componentId, {
        ...patch,
        layer_name: layer.name,
        layer_responsibility: layer.responsibility,
        layer_group_rationale: layer.rationale,
        layer_rationale: correctionRationales.get(componentId) ?? layer.rationale,
      });
    }
  }
  return { patches: nextPatches, scopes: scopeProposals, directComponentIds, workerRuns, degraded };
}
