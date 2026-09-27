/** Bounded conversation context projected from a published snapshot view. */
import type { EvidenceSnapshot, SnapshotNode, SnapshotValuePoint } from "./snapshot.js";
import { asSnapshotLanguageOverlayPayload, type SnapshotLanguageOverlayPayload } from "./snapshot-language.js";

type StaticSummary = NonNullable<EvidenceSnapshot["static_analysis"]>;
type SummaryNode = Pick<SnapshotNode, "id" | "name" | "responsibility" | "architecture_layer_id" | "architecture_layer_name">;

/** Includes a conservative allowance for PostgreSQL's spaced JSONB serialization. */
export const MAX_CONVERSATION_SUMMARY_BYTES = 32 * 1024;

function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  let result = "", length = 0;
  for (const character of value) {
    length += Buffer.byteLength(character, "utf8");
    if (length > bytes - 3) break;
    result += character;
  }
  return result + "…";
}

/** Bound nested metadata as well as visible prose; repository input is untrusted. */
const identityField = (key: string): boolean => key === "id" || key.endsWith("_id") || key.endsWith("_ids")
  || key === "path" || key.endsWith("_path") || key === "paths";

function oversizedReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, item]) => identityField(key)
    && (Array.isArray(item) ? item : [item]).some(reference => typeof reference === "string" && Buffer.byteLength(reference) > 1024));
}

function boundedValue(value: unknown, textBytes: number, depth = 0, key = ""): unknown {
  if (typeof value === "string") return identityField(key) ? value : boundedText(value, textBytes);
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.filter(item => !oversizedReference(item)).slice(0, 32)
    .map(item => boundedValue(item, textBytes, depth + 1, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => Buffer.byteLength(key) <= 256).slice(0, 64)
    .map(([key, item]) => [key, boundedValue(item, textBytes, depth + 1, key)]));
  return value;
}

export function conversationSummarySource(raw: unknown): ConversationSummarySource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as ConversationSummarySource;
  if (typeof source.snapshot_id !== "string" || !source.snapshot_id
    || Buffer.byteLength(source.snapshot_id) > 1024
    || !source.summary || typeof source.summary !== "object" || Array.isArray(source.summary)
    || !Array.isArray(source.languages)
    || !source.graph || typeof source.graph.semantic_mode !== "string" || !Array.isArray(source.graph.nodes)
    || !Array.isArray(source.value_points)) return null;
  const projected: ConversationSummarySource = {
    snapshot_id: source.snapshot_id,
    summary: source.summary,
    languages: source.languages,
    ...(source.static_analysis ? { static_analysis: {
      completeness: source.static_analysis.completeness, limitations: source.static_analysis.limitations,
    } } : {}),
    graph: { semantic_mode: source.graph.semantic_mode, nodes: source.graph.nodes
      .filter(node => typeof node?.id === "string" && node.id.startsWith("component:")
        && Buffer.byteLength(node.id) <= 1024).slice(0, 20)
      .map(({ id, name, responsibility, architecture_layer_id, architecture_layer_name }) =>
        ({ id, name, responsibility, architecture_layer_id, architecture_layer_name })) },
    value_points: source.value_points.filter(point => point && typeof point.stable_id === "string"
      && Buffer.byteLength(point.stable_id) <= 1024 && Array.isArray(point.evidence)).slice(0, 8)
      .map(point => ({ ...point, evidence: point.evidence.slice(0, 6) })),
  };
  // The stored projection is disposable context, never the authoritative detail.
  // Limit strings first, then reduce the number of items if the budget is still exceeded.
  const result = boundedValue(projected, 1024) as ConversationSummarySource;
  const size = () => Buffer.byteLength(JSON.stringify(result, null, 1), "utf8");
  while (size() > MAX_CONVERSATION_SUMMARY_BYTES) {
    if (result.value_points.length) result.value_points.pop();
    else if (result.graph.nodes.length) result.graph.nodes.pop();
    else if (result.languages.length) result.languages.pop();
    else if (result.static_analysis) delete result.static_analysis;
    else {
      result.summary = {};
      break;
    }
  }
  return result;
}

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
  const source = conversationSummarySource(raw);
  if (!source) return null;
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
  const result = boundedValue({
    snapshot_id: source.snapshot_id,
    summary: source.summary,
    languages: source.languages,
    source_completeness: source.static_analysis?.completeness,
    static_limitations: source.static_analysis?.limitations,
    semantic_mode: source.graph.semantic_mode,
    components,
    value_points,
  }, 1024) as ConversationSummary;
  while (Buffer.byteLength(JSON.stringify(result, null, 1)) > MAX_CONVERSATION_SUMMARY_BYTES) {
    if (result.value_points.length) result.value_points.pop();
    else if (result.components.length) result.components.pop();
    else break; // The remaining metadata was already bounded by conversationSummarySource.
  }
  return result;
}
