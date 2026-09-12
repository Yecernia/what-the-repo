import { Type, type Static, type TSchema } from "typebox";
import type { AgentTool, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotNode,
} from "../domain/snapshot.js";
import { readSourcePage, type SourceLineReader } from "./source-read.js";

const PAGE_INPUT = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  layer_id: Type.Optional(Type.String({ maxLength: 256 })),
  entity_kind: Type.Optional(Type.String({ maxLength: 40 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});
const COMPONENT_INPUT = Type.Object({
  component_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  entity_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  member_offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  member_path_prefix: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  relation_offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  include_relations: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
});
const RELATION_INPUT = Type.Object({
  component_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 20 })),
  entity_ids: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 80, default: 30 })),
});
const EVIDENCE_INPUT = Type.Object({
  evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 20 }),
});
const SOURCE_INPUT = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 400 }),
  component_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  offset: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 120 })),
});
const FILE_OUTLINE_INPUT = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 400 }),
  component_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 30 })),
});

export const REPOSITORY_EXPLORATION_TOOL_NAMES = [
  "list_repository_components",
  "get_repository_component",
  "query_repository_relations",
  "get_repository_evidence",
  "read_repository_source",
  "get_repository_file_outline",
] as const;

type ToolDetails = {
  tool_name: string;
  evidence_ids: string[];
  paths: string[];
};

export interface RepositoryExplorationState {
  exposedEvidence: Map<string, SnapshotEvidence>;
  exposedPaths: Set<string>;
  toolsUsed: string[];
}

export interface RepositoryExplorationOptions {
  snapshot: EvidenceSnapshot;
  readLines: SourceLineReader;
  allowedComponentIds?: ReadonlySet<string>;
  allowedEntityIds?: ReadonlySet<string>;
  seedEvidenceIds?: Iterable<string>;
  seedPaths?: Iterable<string>;
  componentRelationsDefault?: boolean;
  state?: RepositoryExplorationState;
}

function result(
  name: string,
  payload: unknown,
  details: Partial<ToolDetails> = {},
): AgentToolResult<ToolDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: {
      tool_name: name,
      evidence_ids: details.evidence_ids ?? [],
      paths: details.paths ?? [],
    },
  };
}

function makeTool<T extends TSchema>(input: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  executionMode?: ToolExecutionMode;
  execute: (params: Static<T>, signal?: AbortSignal) => Promise<AgentToolResult<ToolDetails>>;
  state: RepositoryExplorationState;
}): AgentTool<T, ToolDetails> {
  return {
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.parameters,
    executionMode: input.executionMode,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) throw new Error("repository_tool_cancelled");
      if (!input.state.toolsUsed.includes(input.name)) input.state.toolsUsed.push(input.name);
      return input.execute(params, signal);
    },
  };
}

function evidenceIndex(snapshot: EvidenceSnapshot): Map<string, SnapshotEvidence> {
  const rows = [
    ...snapshot.graph.nodes.flatMap((node) => [...node.evidence, ...node.members]),
    ...snapshot.graph.edges.flatMap((edge) => edge.evidence),
    ...snapshot.graph.layers.flatMap((layer) => layer.evidence),
    ...snapshot.value_points.flatMap((point) => point.evidence),
    ...(snapshot.fact_graph?.nodes.flatMap((node) => [...node.evidence, ...node.members]) ?? []),
    ...(snapshot.fact_graph?.edges.flatMap((edge) => edge.evidence) ?? []),
  ];
  return new Map(rows.filter((row) => row?.stable_id).map((row) => [row.stable_id, row]));
}

function uniqueEvidence(rows: SnapshotEvidence[]): SnapshotEvidence[] {
  return rows.filter((row, index, all) =>
    Boolean(row?.stable_id)
    && all.findIndex((candidate) => candidate.stable_id === row.stable_id) === index);
}

function page<T>(rows: T[], offset = 0, limit = 20): { items: T[]; total: number; next_offset: number | null } {
  const start = Math.max(0, Math.floor(offset));
  const size = Math.max(1, Math.floor(limit));
  const items = rows.slice(start, start + size);
  return {
    items,
    total: rows.length,
    next_offset: start + items.length < rows.length ? start + items.length : null,
  };
}

function componentSummary(node: SnapshotNode): Record<string, unknown> {
  return {
    component_id: node.id,
    entity_id: node.id,
    entity_kind: node.entity_kind ?? "component",
    parent_entity_id: node.parent_entity_id ?? null,
    depth: node.depth ?? 0,
    name: node.name,
    responsibility: node.responsibility,
    layer_id: node.architecture_layer_id,
    layer_name: node.architecture_layer_name,
    member_count: node.member_count,
    fan_in: node.fan_in,
    fan_out: node.fan_out,
    certainty: node.certainty,
  };
}

const RELATION_EVIDENCE_LIMIT = 12;

function relationEvidence(edge: SnapshotEdge): SnapshotEvidence[] {
  return edge.evidence.slice(0, RELATION_EVIDENCE_LIMIT);
}

function relationSummary(edge: SnapshotEdge): Record<string, unknown> {
  return {
    relation_id: edge.id,
    source_component_id: edge.source,
    target_component_id: edge.target,
    kind: edge.relation_kind,
    weight: edge.weight,
    description: edge.description,
    evidence_ids: relationEvidence(edge).map((row) => row.stable_id),
    evidence_total: edge.evidence.length,
  };
}

export function createRepositoryExplorationTools(
  options: RepositoryExplorationOptions,
): { tools: AgentTool[]; state: RepositoryExplorationState } {
  const state = options.state ?? {
    exposedEvidence: new Map<string, SnapshotEvidence>(),
    exposedPaths: new Set<string>(),
    toolsUsed: [],
  };
  const evidence = evidenceIndex(options.snapshot);
  for (const evidenceId of options.seedEvidenceIds ?? []) {
    const row = evidence.get(evidenceId);
    if (row) {
      state.exposedEvidence.set(row.stable_id, row);
      state.exposedPaths.add(row.path);
    }
  }
  for (const path of options.seedPaths ?? []) state.exposedPaths.add(path.replaceAll("\\", "/"));

  const allowed = options.allowedEntityIds ?? options.allowedComponentIds;
  const components = options.snapshot.graph.nodes
    .filter((node) => !allowed || allowed.has(node.id))
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const componentById = new Map(options.snapshot.graph.nodes.map((node) => [node.id, node]));

  const expose = (rows: SnapshotEvidence[]): SnapshotEvidence[] => {
    const unique = uniqueEvidence(rows);
    for (const row of unique) {
      state.exposedEvidence.set(row.stable_id, row);
      state.exposedPaths.add(row.path);
    }
    return unique;
  };

  const authorizeSourcePath = (path: string, componentId?: string): SnapshotEvidence | undefined => {
    let member: SnapshotEvidence | undefined;
    if (componentId) {
      if (allowed && !allowed.has(componentId)) throw new Error("entity_outside_worker_scope");
      const component = componentById.get(componentId);
      if (!component) throw new Error("component_not_found");
      member = component.members.find(row => row.path === path);
      if (!member) throw new Error("source_path_outside_component: Use get_repository_component with member_path_prefix to verify the file and its component_id.");
      expose([member]);
    }
    if (!state.exposedPaths.has(path)) throw new Error("source_path_not_exposed: Provide component_id with the known member path, or use get_repository_component to locate the file first.");
    return member;
  };

  const fileOutline = makeTool({
    name: "get_repository_file_outline",
    label: "正在定位文件中的函数和类",
    description: "查询已知文件中静态扫描识别的函数、类等符号名与准确行号，不读取源码正文。已知文件但不知道实现位置时先用它；可用query按符号名作不区分大小写的字面包含筛选（不是自然语言搜索或正则）。用返回start_line/end_line再read_repository_source读取目标及相关上下文。首次访问成员文件时同时提供component_id和path，无须先翻成员页；省略component_id时路径须已由组件或证据工具暴露。offset为0-based结果分页。仅覆盖静态分析已识别符号，空结果不证明没有相应实现；文档、配置或未识别代码仍按需读正文。",
    parameters: FILE_OUTLINE_INPUT,
    state,
    execute: async params => {
      const path = params.path.replaceAll("\\", "/");
      authorizeSourcePath(path, params.component_id);
      const query = params.query?.trim().toLowerCase();
      const symbols: SnapshotEvidence[] = [];
      for (const row of evidence.values()) {
        if (row.path === path && row.kind === "symbol" && row.start_line != null
          && (!query || row.label.toLowerCase().includes(query))) symbols.push(row);
      }
      symbols.sort((left, right) => left.start_line! - right.start_line! || left.stable_id.localeCompare(right.stable_id));
      const selected = page(symbols, params.offset, params.limit ?? 30);
      const exposed = expose(selected.items);
      return result("get_repository_file_outline", {
        path, coverage: "static_symbols_only", ...selected,
        items: selected.items.map(row => ({ evidence_id: row.stable_id, label: row.label, start_line: row.start_line, end_line: row.end_line })),
      }, { paths: [path], evidence_ids: exposed.map(row => row.stable_id) });
    },
  });

  const list = makeTool({
    name: "list_repository_components",
    label: "正在浏览仓库组件",
    description: "分页列出当前任务可访问的全部组件摘要。结果有 next_offset 时继续读取，不要把一页当成完整仓库。",
    parameters: PAGE_INPUT,
    state,
    execute: async (params) => {
      const filtered = components.filter((node) =>
        (!params.layer_id || node.architecture_layer_id === params.layer_id)
        && (!params.entity_kind || (node.entity_kind ?? "component") === params.entity_kind)
        && (params.depth === undefined || (node.depth ?? 0) <= params.depth));
      const rows = page(filtered, params.offset, params.limit);
      return result("list_repository_components", {
        ...rows,
        items: rows.items.map(componentSummary),
      });
    },
  });

  const getComponent = makeTool({
    name: "get_repository_component",
    label: "正在检查组件成员与关系",
    description: "读取一个组件的分页成员与证据。已知目录或文件前缀时用member_path_prefix筛选成员，member_offset相对于筛选结果；成员和关系各用自己的 next_offset，include_relations 可选择是否附带关系与邻居摘要。"
      + (options.componentRelationsDefault === false
        ? "当前默认不附带关系；需要时设置 include_relations=true，或用 query_repository_relations 独立查询，避免翻成员页时重复读取关系。"
        : "当前默认附带关系；只翻成员页时可设 include_relations=false。"),
    parameters: COMPONENT_INPUT,
    state,
    execute: async (params) => {
      const entityId = params.entity_id ?? params.component_id;
      if (!entityId) throw new Error("entity_id_required");
      if (allowed && !allowed.has(entityId)) throw new Error("entity_outside_worker_scope");
      const component = componentById.get(entityId);
      if (!component) throw new Error("component_not_found");
      const limit = params.limit ?? 20;
      const prefix = params.member_path_prefix?.replaceAll("\\", "/");
      const members = page(prefix ? component.members.filter((row) => row.path.startsWith(prefix)) : component.members, params.member_offset, limit);
      const includeRelations = params.include_relations ?? options.componentRelationsDefault ?? true;
      const relations = includeRelations ? page(
        options.snapshot.graph.edges.filter((edge) => edge.source === component.id || edge.target === component.id),
        params.relation_offset,
        limit,
      ) : null;
      const exposed = expose([
        ...members.items,
        ...component.evidence.slice(0, limit),
        ...(relations?.items.flatMap(relationEvidence) ?? []),
      ]);
      const neighborIds = [...new Set(relations?.items.flatMap((edge) => [edge.source, edge.target]) ?? [])]
        .filter((id) => id !== component.id);
      return result("get_repository_component", {
        component: componentSummary(component),
        grouping_rationale: component.grouping_rationale ?? null,
        layer_rationale: component.architecture_layer_rationale ?? null,
        members: {
          ...members,
          ...(prefix ? { path_prefix: prefix, component_total: component.members.length } : {}),
          items: members.items.map((row) => ({
            evidence_id: row.stable_id,
            label: row.label,
            path: row.path,
            start_line: row.start_line,
            end_line: row.end_line,
            kind: row.kind,
          })),
        },
        relations_included: includeRelations,
        ...(relations ? { relations: {
          ...relations,
          items: relations.items.map(relationSummary),
        },
        neighbors: neighborIds
          .map((id) => componentById.get(id))
          .filter((node): node is SnapshotNode => Boolean(node))
          .map(componentSummary) } : {}),
        evidence_ids: exposed.map((row) => row.stable_id),
      }, {
        evidence_ids: exposed.map((row) => row.stable_id),
        paths: [...new Set(exposed.map((row) => row.path))],
      });
    },
  });

  const relations = makeTool({
    name: "query_repository_relations",
    label: "正在查询组件关系",
    description: "分页查询与指定组件相连的真实关系。跨批邻居会以组件 ID 出现，但当前任务只能修改其允许范围内的组件。",
    parameters: RELATION_INPUT,
    state,
    execute: async (params) => {
      const requested = new Set([...(params.entity_ids ?? []), ...(params.component_ids ?? [])]);
      if (!requested.size) throw new Error("entity_ids_required");
      if (allowed && [...requested].some((id) => !allowed.has(id))) throw new Error("component_outside_worker_scope");
      const rows = options.snapshot.graph.edges
        .filter((edge) => requested.has(edge.source) || requested.has(edge.target))
        .slice()
        .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
      const selected = page(rows, params.offset, params.limit ?? 30);
      const exposed = expose(selected.items.flatMap(relationEvidence));
      return result("query_repository_relations", {
        ...selected,
        items: selected.items.map(relationSummary),
      }, {
        evidence_ids: exposed.map((row) => row.stable_id),
        paths: [...new Set(exposed.map((row) => row.path))],
      });
    },
  });

  const getEvidence = makeTool({
    name: "get_repository_evidence",
    label: "正在解析证据位置",
    description: "把当前快照中真实存在的 Evidence ID 解析为路径、符号和行号。使用任务输入或工具给出的 ID，不猜测编号；不存在的 ID 会列在 missing_ids 中。",
    parameters: EVIDENCE_INPUT,
    state,
    execute: async (params) => {
      const rows = params.evidence_ids
        .map((id) => state.exposedEvidence.get(id) ?? evidence.get(id))
        .filter((row): row is SnapshotEvidence => Boolean(row));
      const exposed = expose(rows);
      return result("get_repository_evidence", {
        items: exposed.map((row) => ({
          evidence_id: row.stable_id,
          label: row.label,
          path: row.path,
          start_line: row.start_line,
          end_line: row.end_line,
          kind: row.kind,
          source_id: row.source_id ?? null,
          target_id: row.target_id ?? null,
        })),
        missing_ids: params.evidence_ids.filter((id) => !evidence.has(id)),
      }, {
        evidence_ids: exposed.map((row) => row.stable_id),
        paths: [...new Set(exposed.map((row) => row.path))],
      });
    },
  });

  const readSource = makeTool({
    name: "read_repository_source",
    label: "正在读取安全源码片段",
    description: "按1-based offset/limit读取安全源码（limit最多200行）。已知文件但不知道目标位置时先get_repository_file_outline定位函数，再读相关行。提供component_id可直接核对成员路径并返回证据ID，无须先翻成员页；省略时路径须已由组件或证据工具暴露。truncated/next_offset只表示文件还有后文，仅当前机制或边界跨页时续读，不要求通读文件。first_line_too_large表示该行超限，重复同页无效，应记录缺口并查其他证据。",
    parameters: SOURCE_INPUT,
    executionMode: "sequential",
    state,
    execute: async (params) => {
      const normalized = params.path.replaceAll("\\", "/");
      const member = authorizeSourcePath(normalized, params.component_id);
      const source = await readSourcePage({
        path: normalized,
        offset: params.offset,
        limit: params.limit,
        readLines: options.readLines,
      });
      const evidenceIds = member ? [member.stable_id] : [];
      return result("read_repository_source", { ...source, ...(member ? { evidence_ids: evidenceIds } : {}) }, { paths: [normalized], evidence_ids: evidenceIds });
    },
  });

  return { tools: [list, getComponent, relations, getEvidence, readSource, fileOutline], state };
}
