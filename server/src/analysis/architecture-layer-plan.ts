/** Validate a complete layer assignment before any model plan is applied. */
import { languageHasNaturalText } from "../domain/display-language.js";
import type { BuiltSnapshot } from "./graph.js";
import {
  type LayerCandidate,
  type LayerWorkerResult,
  type GlobalLayerResult,
  MAX_COMPONENTS_PER_SCOPE,
  MAX_COMPONENT_REASSIGNMENTS,
  MAX_SCOPE_MODEL_COMPONENTS,
  MAX_SECOND_LEVEL_ITEMS,
  layerLanguageError,
  scopeLanguageError,
  scopeNameIsPlaceholder,
} from "./semantic-contracts.js";
import { componentById, componentEvidence } from "./semantic-snapshot.js";

/** Preserve every explicit membership, including invalid duplicates for the validator. */
export function normalizeGlobalLayerResult(value: GlobalLayerResult): LayerWorkerResult {
  const result: LayerWorkerResult = { mode: "layers", groups: [], mappings: [], component_reassignments: [], scopes: [], direct_component_ids: [] };
  value.layers.forEach((layer, layerIndex) => {
    const groupId = `layer-${layerIndex + 1}`;
    result.groups.push({ group_id: groupId, name: layer.name, responsibility: layer.responsibility, rationale: layer.rationale });
    layer.scopes.forEach((scope, scopeIndex) => {
      result.scopes.push({ ...scope, scope_id: `${groupId}-scope-${scopeIndex + 1}`, layer_group_id: groupId });
      for (const componentId of scope.component_ids) result.mappings.push({ candidate_id: componentId, group_id: groupId });
    });
    for (const componentId of layer.direct_component_ids) {
      result.mappings.push({ candidate_id: componentId, group_id: groupId });
      result.direct_component_ids.push(componentId);
    }
  });
  return result;
}

/** One assignment map for validation and assembly; corrections replace a default, never duplicate it. */
export function layerAssignments(value: LayerWorkerResult, candidates: LayerCandidate[]): Map<string, string> {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const groups = new Set(value.groups.map((group) => group.group_id));
  const assignments = new Map<string, string>();
  for (const mapping of value.mappings) {
    if (!groups.has(mapping.group_id)) continue;
    for (const componentId of candidateById.get(mapping.candidate_id)?.componentIds ?? []) assignments.set(componentId, mapping.group_id);
  }
  for (const correction of value.component_reassignments) {
    if (assignments.has(correction.component_id) && groups.has(correction.group_id)) assignments.set(correction.component_id, correction.group_id);
  }
  return assignments;
}

/** Check proposals before fallback grouping can hide missing or conflicting IDs. */
export function validateLayerSubmission(
  value: LayerWorkerResult, snapshot: BuiltSnapshot, candidates: LayerCandidate[], includeScopes: boolean, language: string,
): string[] {
  const errors = new Set<string>();
  const reject = (code: string, detail: string): void => { errors.add(`${code}: ${detail}`); };
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const groups = new Set<string>();
  const groupNames = new Set<string>();
  for (const group of value.groups) {
    if (groups.has(group.group_id)) reject("duplicate_group", group.group_id);
    groups.add(group.group_id);
    const name = group.name.trim().toLocaleLowerCase();
    if (groupNames.has(name)) reject("duplicate_group_name", group.group_id);
    groupNames.add(name);
    const error = layerLanguageError(group, language);
    if (error) reject("language", `${group.group_id}：${error}`);
    if (scopeNameIsPlaceholder(group.name)) reject("placeholder", group.group_id);
  }
  const mapped = new Set<string>();
  const layerByComponent = layerAssignments({ ...value, component_reassignments: [] }, candidates);
  for (const mapping of value.mappings) {
    const candidate = candidateById.get(mapping.candidate_id);
    if (!candidate || !groups.has(mapping.group_id)) { reject("unknown_mapping", mapping.candidate_id); continue; }
    if (mapped.has(candidate.id)) reject("duplicate_mapping", candidate.id);
    mapped.add(candidate.id);
  }
  const missing = candidates.filter((candidate) => !mapped.has(candidate.id));
  if (missing.length) reject("missing_mapping", missing.map((candidate) => candidate.id).join(","));
  const expected = new Set(candidates.flatMap((candidate) => candidate.componentIds).slice(0, MAX_SCOPE_MODEL_COMPONENTS));
  const nodes = componentById(snapshot);
  const corrected = new Set<string>();
  if (value.component_reassignments.length > (includeScopes ? MAX_COMPONENT_REASSIGNMENTS : 0)) reject("reassignment_limit", String(value.component_reassignments.length));
  for (const correction of value.component_reassignments) {
    const componentId = correction.component_id;
    if (!expected.has(componentId) || !groups.has(correction.group_id)) { reject("unknown_reassignment", componentId); continue; }
    if (corrected.has(componentId)) reject("duplicate_reassignment", componentId);
    corrected.add(componentId);
    if (layerByComponent.get(componentId) === correction.group_id) reject("unchanged_reassignment", componentId);
    if (!languageHasNaturalText(correction.rationale, language)) reject("language", `reassignment:${componentId}`);
    const node = nodes.get(componentId);
    const evidence = new Set(node ? componentEvidence(node).map((row) => row.stable_id) : []);
    for (const edge of snapshot.graph.edges) {
      if (edge.source === componentId || edge.target === componentId) for (const row of edge.evidence) evidence.add(row.stable_id);
    }
    if (!correction.evidence_ids.length || correction.evidence_ids.some((evidenceId) => !evidence.has(evidenceId))) reject("reassignment_evidence", componentId);
    layerByComponent.set(componentId, correction.group_id);
  }
  const occupied = new Set(layerByComponent.values());
  for (const group of groups) if (!occupied.has(group)) reject("empty_group", group);
  if (!includeScopes) {
    if (value.scopes.length || value.direct_component_ids.length) reject("unexpected_scopes", "中间归并仅返回分层，scopes/direct_component_ids须为空");
    return [...errors];
  }
  const claimed = new Set<string>();
  const scopeIds = new Set<string>();
  const itemsPerLayer = new Map<string, number>();
  const claim = (componentId: string): void => {
    if (!expected.has(componentId)) reject("unknown_component", componentId);
    if (claimed.has(componentId)) reject("duplicate_component", componentId);
    claimed.add(componentId);
  };
  for (const scope of value.scopes) {
    if (scopeIds.has(scope.scope_id)) reject("duplicate_scope", scope.scope_id);
    scopeIds.add(scope.scope_id);
    const error = scopeLanguageError(scope, language);
    if (error) reject("language", `${scope.scope_id}：${error}`);
    if (scopeNameIsPlaceholder(scope.name)) reject("placeholder", scope.scope_id);
    if (scope.component_ids.length < 2 || scope.component_ids.length > MAX_COMPONENTS_PER_SCOPE) reject("scope_size", scope.scope_id);
    const members = new Set(scope.component_ids);
    const evidence = new Set<string>();
    for (const componentId of scope.component_ids) {
      claim(componentId);
      if (layerByComponent.get(componentId) !== scope.layer_group_id) reject("scope_layer", scope.scope_id);
      const node = nodes.get(componentId);
      if (node) for (const row of componentEvidence(node)) evidence.add(row.stable_id);
    }
    for (const edge of snapshot.graph.edges) {
      if (members.has(edge.source) && members.has(edge.target)) for (const row of edge.evidence) evidence.add(row.stable_id);
    }
    if (!scope.evidence_ids.length || scope.evidence_ids.some((evidenceId) => !evidence.has(evidenceId))) reject("scope_evidence", scope.scope_id);
    itemsPerLayer.set(scope.layer_group_id, (itemsPerLayer.get(scope.layer_group_id) ?? 0) + 1);
  }
  for (const componentId of value.direct_component_ids) {
    claim(componentId);
    const layer = layerByComponent.get(componentId);
    if (layer) itemsPerLayer.set(layer, (itemsPerLayer.get(layer) ?? 0) + 1);
  }
  const missingComponents = [...expected].filter((componentId) => !claimed.has(componentId));
  if (missingComponents.length) reject("missing_component", missingComponents.join(","));
  for (const [layer, count] of itemsPerLayer) if (count > MAX_SECOND_LEVEL_ITEMS) reject("layer_items", layer);
  return [...errors];
}
