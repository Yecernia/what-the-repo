import { nowIso } from "./conversation.js";
import {
  languageHasNaturalText,
  normalizeDisplayLanguage,
} from "./display-language.js";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotLayer,
  SnapshotNode,
  SnapshotValuePoint,
} from "./snapshot.js";

export const SNAPSHOT_LANGUAGE_OVERLAY_VERSION = "snapshot-language-overlay-v1";

export interface ComponentLanguageText {
  id: string;
  name: string;
  responsibility: string;
  grouping_rationale: string;
  architecture_layer_rationale: string | null;
}

export interface LayerLanguageText {
  id: string;
  name: string;
  responsibility: string;
}

export interface ValuePointLanguageText {
  stable_id: string;
  title: string;
  claim: string;
  problem: string | null;
  implementation: string | null;
  tradeoffs: string | null;
  transfer_conditions: string | null;
}

export interface RelationLanguageText {
  kind: string;
  label: string;
  description: string;
}

export interface SnapshotLanguageOverlayPayload {
  schema_version: typeof SNAPSHOT_LANGUAGE_OVERLAY_VERSION;
  language: string;
  generated_at: string;
  components: ComponentLanguageText[];
  layers: LayerLanguageText[];
  relations: RelationLanguageText[];
  value_points: ValuePointLanguageText[];
}

export function extractSnapshotLanguageOverlay(
  snapshot: EvidenceSnapshot,
  language: unknown,
): SnapshotLanguageOverlayPayload {
  const normalizedLanguage = normalizeDisplayLanguage(language);
  const relationKinds = new Set<string>();
  const relationEdges = [
    ...snapshot.graph.edges,
    ...(snapshot.fact_graph?.edges ?? []),
  ].filter((edge) => {
    if (relationKinds.has(edge.relation_kind)) return false;
    relationKinds.add(edge.relation_kind);
    return true;
  });
  return {
    schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
    language: normalizedLanguage,
    generated_at: nowIso(),
    components: snapshot.graph.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      responsibility: node.responsibility,
      grouping_rationale: node.grouping_rationale ?? "",
      architecture_layer_rationale: node.architecture_layer_rationale ?? null,
    })),
    layers: snapshot.graph.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      responsibility: layer.responsibility,
    })),
    relations: relationEdges.map((edge) => relationLanguageText(edge, normalizedLanguage)),
    value_points: snapshot.value_points.map((point) => ({
      stable_id: point.stable_id,
      title: point.title,
      claim: point.claim,
      problem: point.problem,
      implementation: point.implementation,
      tradeoffs: point.tradeoffs,
      transfer_conditions: point.transfer_conditions,
    })),
  };
}

export function snapshotMatchesDisplayLanguage(
  snapshot: EvidenceSnapshot,
  language: unknown,
): boolean {
  const required = [
    // The repository root retains its real owner/name, even in a translated view.
    ...snapshot.graph.nodes.flatMap((node) => node.entity_kind === "repository" && node.name === snapshot.repository
      ? [node.responsibility] : [node.name, node.responsibility]),
    ...snapshot.graph.layers.flatMap((layer) => [layer.name, layer.responsibility]),
    ...snapshot.graph.edges.flatMap((edge) => [edge.label, edge.description]),
    ...snapshot.value_points.flatMap((point) => [
      point.title,
      point.claim,
      point.problem,
      point.implementation,
      point.tradeoffs,
      point.transfer_conditions,
    ]),
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return required.length > 0 && required.every((value) => languageHasNaturalText(value, language));
}

export function stripSnapshotLanguage(snapshot: EvidenceSnapshot): EvidenceSnapshot {
  // Keep large evidence/member arrays shared. Only the user-facing language
  // fields are rewritten, so a deep clone would create a second full graph.
  return {
    ...snapshot,
    graph: {
      ...snapshot.graph,
      nodes: snapshot.graph.nodes.map(stripNodeText),
      layers: snapshot.graph.layers.map(stripLayerText),
      edges: snapshot.graph.edges.map(stripEdgeText),
    },
    fact_graph: snapshot.fact_graph
      ? {
          ...snapshot.fact_graph,
          edges: snapshot.fact_graph.edges.map(stripEdgeText),
        }
      : snapshot.fact_graph,
    value_points: snapshot.value_points.map(stripValuePointText),
  };
}

export function applySnapshotLanguageOverlay(
  snapshot: EvidenceSnapshot,
  overlay: SnapshotLanguageOverlayPayload,
): EvidenceSnapshot {
  const clone = structuredClone(snapshot);
  clone.display_language = overlay.language;
  const components = new Map(overlay.components.map((item) => [item.id, item]));
  const layers = new Map(overlay.layers.map((item) => [item.id, item]));
  const relations = new Map((overlay.relations ?? []).map((item) => [item.kind, item]));
  const values = new Map(overlay.value_points.map((item) => [item.stable_id, item]));
  clone.graph.nodes = clone.graph.nodes.map((node) => {
    const text = components.get(node.id);
    const layer = node.architecture_layer_id
      ? layers.get(node.architecture_layer_id)
      : null;
    return text ? {
      ...node,
      label: text.name,
      name: text.name,
      responsibility: text.responsibility,
      grouping_rationale: text.grouping_rationale,
      architecture_layer_name: layer?.name ?? node.architecture_layer_name,
      architecture_layer_rationale: text.architecture_layer_rationale,
    } : node;
  });
  clone.graph.layers = clone.graph.layers.map((layer) => {
    const text = layers.get(layer.id);
    return text ? { ...layer, name: text.name, responsibility: text.responsibility } : layer;
  });
  clone.graph.edges = clone.graph.edges.map((edge) => applyEdgeText(edge, relations));
  if (clone.fact_graph) clone.fact_graph.edges = clone.fact_graph.edges.map((edge) => applyEdgeText(edge, relations));
  clone.value_points = clone.value_points.map((point) => {
    const text = values.get(point.stable_id);
    return text ? { ...point, ...text } : point;
  });
  return clone;
}

export function asSnapshotLanguageOverlayPayload(
  value: unknown,
): SnapshotLanguageOverlayPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SnapshotLanguageOverlayPayload>;
  if (
    row.schema_version !== SNAPSHOT_LANGUAGE_OVERLAY_VERSION
    || typeof row.language !== "string"
    || !Array.isArray(row.components)
    || !Array.isArray(row.layers)
    || !Array.isArray(row.relations)
    || !Array.isArray(row.value_points)
  ) return null;
  return row as SnapshotLanguageOverlayPayload;
}

function stripNodeText(node: SnapshotNode): SnapshotNode {
  return {
    ...node,
    label: node.id,
    name: node.id,
    responsibility: "",
    grouping_rationale: "",
    architecture_layer_name: null,
    architecture_layer_rationale: null,
  };
}

function stripLayerText(layer: SnapshotLayer): SnapshotLayer {
  return { ...layer, name: layer.id, responsibility: "" };
}

function stripEdgeText(edge: SnapshotEdge): SnapshotEdge {
  return { ...edge, label: edge.relation_kind, description: "" };
}

function applyEdgeText(
  edge: SnapshotEdge,
  relations: Map<string, RelationLanguageText>,
): SnapshotEdge {
  const text = relations.get(edge.relation_kind);
  return text ? {
    ...edge,
    label: text.label,
    description: text.description.replaceAll("{count}", String(edge.weight)),
  } : edge;
}

function relationLanguageText(edge: SnapshotEdge, language: string): RelationLanguageText {
  const templates: Record<string, Record<string, [string, string]>> = {
    "zh-CN": {
      contains: ["包含", "表示文件定义或包含目标符号。"],
      imports: ["依赖", "{count} 处静态事实支持这条依赖关系。"],
      calls: ["调用", "{count} 处静态事实支持这条调用关系。"],
      inherits: ["继承", "{count} 处静态事实支持这条继承关系。"],
      implements: ["实现", "{count} 处静态事实支持这条实现关系。"],
    },
    en: {
      contains: ["contains", "The file defines or contains the target symbol."],
      imports: ["depends on", "{count} static facts support this dependency."],
      calls: ["calls", "{count} static facts support this call relation."],
      inherits: ["inherits", "{count} static facts support this inheritance relation."],
      implements: ["implements", "{count} static facts support this implementation relation."],
    },
    ja: {
      contains: ["含む", "ファイルが対象シンボルを定義または包含しています。"],
      imports: ["依存", "{count} 件の静的事実がこの依存関係を裏付けます。"],
      calls: ["呼び出し", "{count} 件の静的事実がこの呼び出し関係を裏付けます。"],
      inherits: ["継承", "{count} 件の静的事実がこの継承関係を裏付けます。"],
      implements: ["実装", "{count} 件の静的事実がこの実装関係を裏付けます。"],
    },
    ko: {
      contains: ["포함", "파일이 대상 심볼을 정의하거나 포함합니다."],
      imports: ["의존", "정적 사실 {count}개가 이 의존 관계를 뒷받침합니다."],
      calls: ["호출", "정적 사실 {count}개가 이 호출 관계를 뒷받침합니다."],
      inherits: ["상속", "정적 사실 {count}개가 이 상속 관계를 뒷받침합니다."],
      implements: ["구현", "정적 사실 {count}개가 이 구현 관계를 뒷받침합니다."],
    },
  };
  const localized = templates[language]?.[edge.relation_kind];
  if (localized) return { kind: edge.relation_kind, label: localized[0], description: localized[1] };
  const description = edge.description.includes(String(edge.weight))
    ? edge.description.replace(String(edge.weight), "{count}")
    : edge.description;
  return { kind: edge.relation_kind, label: edge.label, description };
}

function stripValuePointText(point: SnapshotValuePoint): SnapshotValuePoint {
  return {
    ...point,
    title: point.stable_id,
    claim: "",
    problem: null,
    implementation: null,
    tradeoffs: null,
    transfer_conditions: null,
  };
}
