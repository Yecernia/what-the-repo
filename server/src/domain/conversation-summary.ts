/** Bounded conversation context projected from a published snapshot view. */
import type { EvidenceSnapshot, SnapshotNode, SnapshotValuePoint } from "./snapshot.js";
import { asSnapshotLanguageOverlayPayload, type SnapshotLanguageOverlayPayload } from "./snapshot-language.js";

type StaticSummary = NonNullable<EvidenceSnapshot["static_analysis"]>;
type SummaryNode = Pick<SnapshotNode, "id" | "name" | "responsibility" | "architecture_layer_id" | "architecture_layer_name">;

export interface ConversationSummary {
  snapshot_id: string;
  summary: EvidenceSnapshot["summary"];
  languages: EvidenceSnapshot["languages"];
  source_completeness?: StaticSummary["completeness"];
  static_limitations?: string[];
  semantic_mode: string;
  components: Array<{ id: string; name: string; responsibility: string; layer: string | null }>;
  value_points: SnapshotValuePoint[];
}

/** The database may supply this small shape without deserializing its whole view. */
export interface ConversationSummarySource {
  snapshot_id: string;
  summary: EvidenceSnapshot["summary"];
  languages: EvidenceSnapshot["languages"];
  static_analysis?: Pick<StaticSummary, "completeness" | "limitations"> | null;
  graph: { semantic_mode: string; nodes: SummaryNode[] };
  value_points: SnapshotValuePoint[];
}

export function conversationSummaryFromSource(
  raw: unknown,
  overlayValue?: SnapshotLanguageOverlayPayload | null,
): ConversationSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Partial<ConversationSummarySource>;
  if (typeof source.snapshot_id !== "string" || !source.snapshot_id
    || !source.summary || typeof source.summary !== "object" || Array.isArray(source.summary)
    || !Array.isArray(source.languages)
    || !source.graph || typeof source.graph.semantic_mode !== "string" || !Array.isArray(source.graph.nodes)
    || !Array.isArray(source.value_points)) return null;
  const overlay = asSnapshotLanguageOverlayPayload(overlayValue);
  const componentText = new Map(overlay?.components.map(row => [row.id, row]) ?? []);
  const layerText = new Map(overlay?.layers.map(row => [row.id, row]) ?? []);
  const valueText = new Map(overlay?.value_points.map(row => [row.stable_id, row]) ?? []);
  const components = source.graph.nodes
    .filter(node => typeof node?.id === "string" && node.id.startsWith("component:"))
    .slice(0, 20)
    .map(node => {
      const translated = componentText.get(node.id);
      const layer = translated && node.architecture_layer_id
        ? layerText.get(node.architecture_layer_id) : null;
      return {
        id: node.id,
        name: translated?.name ?? node.name,
        responsibility: translated?.responsibility ?? node.responsibility,
        layer: translated ? layer?.name ?? node.architecture_layer_name : node.architecture_layer_name,
      };
    });
  const value_points = source.value_points.slice(0, 8).map(point => ({
    ...point,
    ...(valueText.get(point.stable_id) ?? {}),
    evidence: point.evidence.slice(0, 6),
  }));
  return {
    snapshot_id: source.snapshot_id,
    summary: source.summary,
    languages: source.languages,
    source_completeness: source.static_analysis?.completeness,
    static_limitations: source.static_analysis?.limitations,
    semantic_mode: source.graph.semantic_mode,
    components,
    value_points,
  };
}
