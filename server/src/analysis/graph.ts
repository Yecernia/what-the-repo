import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  EvidenceSnapshot,
  SnapshotEdge,
  SnapshotEvidence,
  SnapshotLayer,
  SnapshotNode,
  SnapshotEntityKind,
  RepositoryResearch,
} from "../domain/snapshot.js";
import { buildCandidateHierarchy } from "./hierarchy.js";
import { deriveSnapshotProjections } from "../domain/snapshot-projection.js";
import {
  type LspRunResult,
  type ParsedFile,
  type StaticRelationKind,
  type StaticSymbolFact,
  symbolStableId,
} from "./facts.js";

type FactEdgeKind = "contains" | StaticRelationKind;

interface FactRelation {
  sourceId: string;
  targetId: string;
  sourcePath: string;
  targetPath: string;
  kind: FactEdgeKind;
  line: number;
  column: number;
  certainty: "verified" | "degraded";
  sources: string[];
  meaning?: string;
  range?: import("./facts.js").SourceRange;
  toolVersions?: Record<string, string | null>;
  inputDigest?: string;
  configDigest?: string;
}

export interface BuiltSnapshot extends EvidenceSnapshot {
  fact_graph: {
    nodes: SnapshotNode[];
    edges: SnapshotEdge[];
  };
  source_root: string;
  repository: string;
  commit_sha: string;
  research?: RepositoryResearch;
}

function id(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function evidence(
  stableId: string,
  label: string,
  path: string,
  startLine: number | null,
  endLine: number | null,
  kind: string,
  relation?: { sourceId: string; targetId: string },
): SnapshotEvidence {
  return {
    stable_id: stableId,
    label,
    path,
    start_line: startLine,
    end_line: endLine,
    kind,
    source_id: relation?.sourceId,
    target_id: relation?.targetId,
  };
}

function graphNode(input: {
  id: string;
  entityKind?: SnapshotEntityKind;
  name: string;
  responsibility?: string;
  groupingRationale?: string;
  layerId?: string | null;
  layerName?: string | null;
  layerRationale?: string | null;
  layerCertainty?: string;
  members?: SnapshotEvidence[];
  evidence?: SnapshotEvidence[];
  certainty: string;
  reviewStatus?: string;
  attributes?: Record<string, unknown>;
  observations?: Array<Record<string, unknown>>;
}): SnapshotNode {
  const members = input.members ?? [];
  return {
    id: input.id,
    entity_kind: input.entityKind ?? "component",
    parent_entity_id: null,
    depth: 0,
    label: input.name,
    name: input.name,
    responsibility: input.responsibility ?? "",
    grouping_rationale: input.groupingRationale ?? "",
    architecture_layer_id: input.layerId ?? null,
    architecture_layer_name: input.layerName ?? null,
    architecture_layer_candidates: [],
    architecture_layer_rationale: input.layerRationale ?? null,
    architecture_layer_certainty: input.layerCertainty ?? input.certainty,
    members,
    member_count: members.length,
    evidence: input.evidence ?? [],
    certainty: input.certainty,
    review_status: input.reviewStatus ?? "unreviewed",
    source_report_ids: [],
    fan_in: 0,
    fan_out: 0,
    attributes: input.attributes,
    source_observations: input.observations,
  };
}

function groupKey(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 1) return "root";
  if (
    ["src", "app", "packages", "lib", "server", "backend", "web"].includes(
      parts[0] as string,
    )
  ) {
    return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
  }
  return parts[0] as string;
}

function structuralName(key: string): {
  name: string;
  responsibility: string;
  layer: string;
} {
  const lower = key.toLowerCase();
  if (/auth|login|security|permission|identity/.test(lower)) {
    return {
      name: "认证与权限层",
      responsibility: "处理身份、登录和访问控制相关职责。",
      layer: "入口与安全层",
    };
  }
  if (/api|route|controller|handler|http|server/.test(lower)) {
    return {
      name: "接口与入口层",
      responsibility: "接收外部请求并把请求交给应用服务。",
      layer: "入口与安全层",
    };
  }
  if (/service|usecase|application|workflow/.test(lower)) {
    return {
      name: "应用服务层",
      responsibility: "编排具体业务流程和跨模块协作。",
      layer: "业务编排层",
    };
  }
  if (/domain|model|entity|core/.test(lower)) {
    return {
      name: "核心领域层",
      responsibility: "表达项目的核心对象、规则和稳定契约。",
      layer: "核心领域层",
    };
  }
  if (/component|ui|view|page|screen|widget/.test(lower)) {
    return {
      name: "界面组件层",
      responsibility: "组织用户界面组件和交互展示。",
      layer: "表现层",
    };
  }
  if (/test|spec|fixture/.test(lower)) {
    return {
      name: "测试与验证层",
      responsibility: "验证代码行为和产品契约。",
      layer: "质量保障层",
    };
  }
  if (/doc|readme|skill|guide/.test(lower)) {
    return {
      name: "文档与规范层",
      responsibility: "保存项目说明、操作规范和可迁移知识。",
      layer: "知识与规范层",
    };
  }
  if (/config|infra|deploy|docker|script|tool/.test(lower)) {
    return {
      name: "基础设施与配置层",
      responsibility: "提供运行配置、部署和开发辅助能力。",
      layer: "基础设施层",
    };
  }
  const last = key.split("/").at(-1) ?? key;
  return {
    name: key === "root" ? "项目入口与配置" : `${last} 模块`,
    responsibility: "组织该目录下的相关文件和实现。",
    layer: "共享基础层",
  };
}

function mergeSymbols(
  files: ParsedFile[],
  results: LspRunResult[],
): StaticSymbolFact[] {
  const symbols = files.flatMap((f) => f.symbols);
  const paths = new Set(files.map((file) => file.path));
  const sites = new Set(
    symbols.flatMap((s) =>
      (s.declarations ?? []).map((d) =>
        [d.path, d.selection.startLine, d.selection.startColumn, s.kind].join(
          ":",
        ),
      ),
    ),
  );
  for (const result of results)
    for (const candidate of result.symbols) {
      if (!paths.has(candidate.path)) continue;
      const selection = candidate.selection ?? candidate;
      const key = [
        candidate.path,
        selection.startLine,
        selection.startColumn,
        candidate.kind,
      ].join(":");
      if (sites.has(key)) continue;
      sites.add(key);
      symbols.push({
        ...candidate,
        stableId: symbolStableId(
          candidate.path,
          candidate.qualifiedName,
          candidate.kind,
          key,
        ),
        language: result.language,
        parameterCount: null,
        implicitReceiverCount: 0,
        bases: [],
        sources: ["lsp"],
        valid: true,
        declarations: [
          {
            id: "declaration:lsp:" + id(key),
            path: candidate.path,
            range: candidate,
            selection,
            role: "declaration",
            valid: true,
          },
        ],
      });
    }
  return [...new Map(symbols.map((s) => [s.stableId, s])).values()].sort(
    (a, b) => a.stableId.localeCompare(b.stableId),
  );
}
function buildRelations(
  files: ParsedFile[],
  symbols: StaticSymbolFact[],
  results: LspRunResult[],
  fileIds: Map<string, string>,
): {
  relations: FactRelation[];
  unresolvedCalls: number;
  unresolvedImports: number;
} {
  const byId = new Map(symbols.map((s) => [s.stableId, s]));
  const at = new Map<string, StaticSymbolFact[]>();
  for (const symbol of symbols)
    for (const declaration of symbol.declarations ?? []) {
      const key = [
        declaration.path,
        declaration.selection.startLine,
        declaration.selection.startColumn,
      ].join(":");
      const rows = at.get(key) ?? [];
      rows.push(symbol);
      at.set(key, rows);
    }
  const exact = (path: string, line: number, column: number) => {
    const rows = at.get([path, line, column].join(":")) ?? [];
    return rows.length === 1 ? rows[0] : undefined;
  };
  const rows = new Map<string, FactRelation>();
  let unresolvedCalls = 0,
    unresolvedImports = 0;
  const add = (row: FactRelation) => {
    const key = [
      row.kind,
      row.sourceId,
      row.targetId,
      row.line,
      row.column,
      row.certainty,
    ].join("|");
    const previous = rows.get(key);
    if (previous)
      previous.sources = [
        ...new Set([...previous.sources, ...row.sources]),
      ].sort();
    else rows.set(key, row);
  };
  for (const file of files) {
    const fileId = fileIds.get(file.path)!;
    for (const symbol of file.symbols)
      add({
        sourceId:
          symbol.scopeId && byId.has(symbol.scopeId) ? symbol.scopeId : fileId,
        targetId: symbol.stableId,
        sourcePath: file.path,
        targetPath: symbol.path,
        kind: "contains",
        line: symbol.startLine,
        column: symbol.startColumn,
        certainty: symbol.valid === false ? "degraded" : "verified",
        sources: symbol.sources,
      });
    for (const imported of file.imports) {
      const targetId =
        imported.resolvedPath && fileIds.get(imported.resolvedPath);
      if (!targetId || !imported.resolvedPath) {
        unresolvedImports++;
        continue;
      }
      add({
        sourceId: fileId,
        targetId,
        sourcePath: file.path,
        targetPath: imported.resolvedPath,
        kind: imported.kind ?? "imports",
        line: imported.line,
        column: imported.column ?? 0,
        certainty: imported.status === "static" ? "verified" : "degraded",
        sources: [file.parser?.name ?? "syntax"],
      });
    }
    for (const call of file.calls) {
      const target = call.target?.symbolId
        ? byId.get(call.target.symbolId)
        : undefined;
      if (!target) {
        if (
          !call.status ||
          ["unresolved", "missing_dependency"].includes(call.status)
        )
          unresolvedCalls++;
        continue;
      }
      add({
        sourceId: call.callerStableId ?? fileId,
        targetId: target.stableId,
        sourcePath: file.path,
        targetPath: target.path,
        kind: "calls",
        line: call.line,
        column: call.column,
        certainty:
          call.status === "static" && call.meaning === "implementation"
            ? "verified"
            : "degraded",
        sources: [file.parser?.name ?? "syntax"],
        meaning: call.meaning,
        range: call.range,
      });
    }
    for (const base of file.heritage ?? []) {
      const target = byId.get(base.targetId);
      if (!target) continue;
      add({
        sourceId: base.sourceId,
        targetId: base.targetId,
        sourcePath: file.path,
        targetPath: target.path,
        kind: base.kind,
        line: base.range.startLine,
        column: base.range.startColumn,
        certainty: base.status === "candidate" ? "degraded" : "verified",
        sources: [file.parser?.name ?? "syntax"],
        range: base.range,
      });
    }
  }
  for (const result of results)
    for (const relation of result.relations) {
      const source = exact(
        relation.sourcePath,
        relation.sourceSelection?.startLine ?? relation.sourceLine,
        relation.sourceSelection?.startColumn ?? relation.sourceColumn,
      );
      const target = exact(
        relation.targetPath,
        relation.targetLine,
        relation.targetColumn,
      );
      if (!source || !target) continue;
      add({
        sourceId: source.stableId,
        targetId: target.stableId,
        sourcePath: source.path,
        targetPath: target.path,
        kind: relation.kind,
        line: relation.sourceLine,
        column: relation.sourceColumn,
        certainty: "degraded",
        sources: ["lsp"],
        meaning: "server_reported_binding",
        range: relation.range,
      });
    }
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const lspByProject = new Map(
    results.map((result) => [result.projectId ?? result.language, result]),
  );
  for (const row of rows.values()) {
    const file = filesByPath.get(row.sourcePath);
    row.inputDigest = file?.digest;
    row.configDigest = file?.project?.configDigest;
    row.toolVersions = Object.fromEntries(
      row.sources.map((source) => [
        source,
        source === "lsp"
          ? (lspByProject.get(file?.project?.id ?? file?.language ?? "")
              ?.serverVersion ?? null)
          : (file?.parser?.version ?? null),
      ]),
    );
  }
  return {
    relations: [...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, row]) => row),
    unresolvedCalls,
    unresolvedImports,
  };
}

function relationLabel(kind: FactEdgeKind): string {
  if (kind === "contains") return "包含";
  if (
    ["imports", "type_imports", "reexports", "dynamic_imports"].includes(kind)
  )
    return "依赖";
  if (kind === "inherits") return "继承";
  if (kind === "implements") return "实现";
  return "调用";
}

function factEdge(row: FactRelation): SnapshotEdge {
  const edgeId = `fact:edge:${id(
    [
      row.sourceId,
      row.targetId,
      row.kind,
      String(row.line),
      String(row.column),
      row.certainty,
    ].join(":"),
  )}`;
  return {
    id: edgeId,
    source: row.sourceId,
    target: row.targetId,
    relation_kind: row.kind,
    label: relationLabel(row.kind),
    description:
      row.kind === "contains"
        ? "文件定义或包含该符号。"
        : row.certainty === "verified"
          ? `${row.sources.join(" + ")} 静态分析确认这条${relationLabel(row.kind)}绑定。`
          : `${row.sources.join(" + ")} 提供这条${relationLabel(row.kind)}候选，实际目标仍需核实。`,
    certainty: row.certainty,
    evidence: [
      evidence(
        edgeId,
        `${row.sourcePath}:${row.line}`,
        row.sourcePath,
        row.line,
        row.line,
        row.kind,
        { sourceId: row.sourceId, targetId: row.targetId },
      ),
    ],
    weight: 1,
    source_observations: row.sources.map((source) => ({
      extractor: source,
      implementation_version: row.toolVersions?.[source] ?? null,
      input_digest: row.inputDigest,
      config_digest: row.configDigest,
      certainty: row.certainty === "verified" ? "direct" : "inferred",
      reason_code: `${source}_${row.kind}`,
      meaning: row.meaning ?? row.kind,
      range: row.range,
    })),
  };
}

function aggregateComponentEdges(
  relations: FactRelation[],
  componentByFile: Map<string, string>,
): SnapshotEdge[] {
  const groups = new Map<
    string,
    {
      rows: FactRelation[];
      source: string;
      target: string;
      kind: FactEdgeKind;
    }
  >();
  for (const row of relations) {
    if (row.kind === "contains") continue;
    const source = componentByFile.get(row.sourcePath);
    const target = componentByFile.get(row.targetPath);
    if (!source || !target || source === target) continue;
    const key = [source, target, row.kind, row.certainty].join("|");
    const current = groups.get(key) ?? {
      rows: [],
      source,
      target,
      kind: row.kind,
    };
    current.rows.push(row);
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => {
    const edgeId = `component:edge:${id([group.source, group.target, group.kind, group.rows[0]?.certainty].join(":"))}`;
    return {
      id: edgeId,
      source: group.source,
      target: group.target,
      relation_kind: group.kind,
      label: relationLabel(group.kind),
      description: `${group.rows.length} 处静态分析记录支持此关系，其中${group.rows.filter((row) => row.certainty === "verified").length}处已确认绑定；其余为待核实候选。`,
      certainty: group.rows.some((row) => row.certainty === "verified")
        ? "verified"
        : "degraded",
      evidence: group.rows.map((row, index) =>
        evidence(
          `${edgeId}:evidence:${index}`,
          `${row.sourcePath}:${row.line}`,
          row.sourcePath,
          row.line,
          row.line,
          row.kind,
          { sourceId: row.sourceId, targetId: row.targetId },
        ),
      ),
      weight: group.rows.length,
      source_observations: group.rows.flatMap((row) =>
        row.sources.map((source) => ({
          extractor: source,
          implementation_version: row.toolVersions?.[source] ?? null,
          input_digest: row.inputDigest,
          config_digest: row.configDigest,
          certainty: row.certainty,
          reason_code: `${source}_${row.kind}`,
        })),
      ),
    };
  });
}

function languageReports(
  files: ParsedFile[],
  lspResults: LspRunResult[],
): EvidenceSnapshot["languages"] {
  return [
    ...new Set(files.map((f) => f.language).filter((l) => l !== "unknown")),
  ]
    .sort()
    .map((language) => {
      const rows = files.filter((f) => f.language === language),
        completed = rows.filter((f) => !f.parseError).length;
      const runs = lspResults.filter((r) => r.language === language),
        compiler = rows.some((f) => f.relationBinding === "typescript");
      const lsp = runs[0];
      return {
        language,
        quality_tier: completed ? "degraded" : "unavailable",
        files_seen: rows.length,
        files_analyzed: completed,
        files_failed: rows.length - completed,
        reason_codes: [
          ...new Set([
            ...rows.flatMap((f) => (f.diagnostics ?? []).map((d) => d.code)),
            ...runs.flatMap((r) => r.reasonCodes),
            ...(compiler
              ? ["static_binding_not_runtime_call_graph"]
              : ["syntax_only_bindings_unresolved"]),
          ]),
        ],
        adapter_name: compiler ? "typescript-compiler" : "language-syntax",
        adapter_version: "project-facts-v1",
        parser_name: rows[0]?.parser?.name ?? null,
        parser_version: rows[0]?.parser?.version ?? null,
        lsp_name: lsp?.serverName ?? null,
        lsp_version: lsp?.serverVersion ?? null,
        capabilities: [
          "declarations",
          "lexical_scopes",
          "syntax_calls",
          ...(compiler ? ["project_configuration", "static_binding"] : []),
          ...new Set(runs.flatMap((r) => r.capabilities)),
        ],
      };
    });
}

export function buildSnapshot(input: {
  snapshotId: string;
  repository: string;
  commitSha: string;
  files: ParsedFile[];
  sourceRoot: string;
  lspResults?: LspRunResult[];
  research?: RepositoryResearch;
  completeness?: import("./facts.js").SourceCompleteness;
}): BuiltSnapshot {
  input = {
    ...input,
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const lspResults = input.lspResults ?? [];
  const fileIdByPath = new Map<string, string>();
  const fileNodes = input.files.map((file) => {
    const fileId = `fact:file:${id(file.path)}`;
    fileIdByPath.set(file.path, fileId);
    return graphNode({
      id: fileId,
      entityKind: "fact",
      name: file.path,
      evidence: [evidence(fileId, file.path, file.path, 1, null, "file")],
      certainty: "verified",
      attributes: {
        path: file.path,
        language: file.language,
        content_digest: file.digest,
        size_bytes: file.bytes,
        role: file.role,
        project_id: file.project?.id,
        config_digest: file.project?.configDigest,
        encoding: file.encoding,
        diagnostics: file.diagnostics,
      },
      observations: [
        {
          extractor: "safe_manifest",
          certainty: "direct",
          reason_code: "file_scan",
        },
      ],
    });
  });
  const symbols = mergeSymbols(input.files, lspResults);

  const symbolNodes = symbols.map((symbol) =>
    graphNode({
      id: symbol.stableId,
      entityKind: "fact",
      name: symbol.name,
      evidence: [
        evidence(
          symbol.stableId,
          `${symbol.qualifiedName} (${symbol.kind})`,
          symbol.path,
          symbol.startLine,
          symbol.endLine,
          "symbol",
        ),
      ],
      certainty:
        symbol.valid === false || symbol.sources.every((s) => s === "lsp")
          ? "degraded"
          : "verified",
      attributes: {
        path: symbol.path,
        qualified_name: symbol.qualifiedName,
        kind: symbol.kind,
        language: symbol.language,
        declarations: symbol.declarations,
        scope_id: symbol.scopeId,
        tracking_key: symbol.trackingKey,
        start_line: symbol.startLine,
        end_line: symbol.endLine,
        start_column: symbol.startColumn,
        end_column: symbol.endColumn,
      },
      observations: symbol.sources.map((source) => ({
        extractor: source,
        certainty: source === "lsp" ? "inferred" : "direct",
        reason_code: `${source}_declaration`,
      })),
    }),
  );
  const { relations, unresolvedCalls, unresolvedImports } = buildRelations(
    input.files,
    symbols,
    lspResults,
    fileIdByPath,
  );
  const factEdges = relations.map(factEdge);

  const filesByGroup = new Map<string, ParsedFile[]>();
  for (const file of input.files) {
    const key = groupKey(file.path);
    const group = filesByGroup.get(key) ?? [];
    group.push(file);
    filesByGroup.set(key, group);
  }
  const components: SnapshotNode[] = [];
  const layerGroups = new Map<string, SnapshotLayer>();
  const componentByFile = new Map<string, string>();
  for (const [key, files] of filesByGroup) {
    const semantic = structuralName(key);
    const componentId = `component:${id(`${input.repository.toLowerCase()}:${key}`)}`;
    const layerId = `layer:${id(semantic.layer)}`;
    const memberEvidence = files.map((file) => {
      const stableId = fileIdByPath.get(file.path) as string;
      componentByFile.set(file.path, componentId);
      return evidence(stableId, file.path, file.path, 1, null, "file");
    });
    components.push(
      graphNode({
        id: componentId,
        entityKind: "component",
        name: semantic.name,
        responsibility: semantic.responsibility,
        groupingRationale: `程序根据成员所在的结构目录“${key}”将它们聚合；语义 Worker 可在分析完成后补充更具体的职责关系。`,
        layerId,
        layerName: semantic.layer,
        layerRationale: `成员都来自“${key}”这一结构分组，当前层级是基于目录和静态关系的候选归类。`,
        layerCertainty: "degraded",
        members: memberEvidence,
        evidence: memberEvidence.slice(0, 24),
        certainty: "unverified",
        attributes: { structural_group: key },
      }),
    );
    const layer = layerGroups.get(semantic.layer) ?? {
      id: layerId,
      name: semantic.layer,
      responsibility: `${semantic.layer}中的公共职责。`,
      component_ids: [],
      evidence: [],
      certainty: "unverified",
    };
    layer.component_ids.push(componentId);
    layerGroups.set(semantic.layer, layer);
  }
  const componentEdges = aggregateComponentEdges(relations, componentByFile);
  const componentById = new Map(
    components.map((component) => [component.id, component]),
  );
  for (const edge of componentEdges) {
    const source = componentById.get(edge.source);
    const target = componentById.get(edge.target);
    if (source) source.fan_out += 1;
    if (target) target.fan_in += 1;
  }

  const languages = languageReports(input.files, lspResults);
  const sourceReports = [
    ...languages.map((report) => ({
      source_id: `source:${report.parser_name}:${report.language}`,
      source_kind: report.parser_name,
      implementation_name: report.parser_name,
      implementation_version: report.parser_version,
      status:
        report.files_analyzed > 0
          ? report.files_failed
            ? "degraded"
            : "available"
          : "failed",
      reason_codes: report.reason_codes,
    })),
    ...lspResults.map((run) => ({
      source_id: `source:lsp:${run.projectId ?? run.language}`,
      source_kind: "lsp",
      project_id: run.projectId,
      implementation_name: run.serverName ?? "unavailable",
      implementation_version: run.serverVersion,
      status: run.completed ? "completed" : "incomplete",
      toolchain_verified: run.toolchainVerified,
      coverage: run.coverage,
      reason_codes: run.reasonCodes,
      workspace_diagnostics: run.workspaceDiagnostics,
    })),
  ];
  const projects = new Map<string, import("./facts.js").ProjectContext>();
  const statuses: Record<string, number> = {};
  for (const file of input.files) {
    if (file.project) {
      const project = projects.get(file.project.id) ?? {
        ...file.project,
        files: [],
      };
      project.files.push(file.path);
      projects.set(project.id, project);
    }
    for (const call of file.calls)
      statuses[call.status ?? "unresolved"] =
        (statuses[call.status ?? "unresolved"] ?? 0) + 1;
  }

  const hierarchy = buildCandidateHierarchy({
    repository: input.repository,
    components,
    edges: componentEdges,
  });
  const overlays = [...layerGroups.values()].map((layer) => ({
    id: layer.id,
    kind: "architecture_layer" as const,
    name: layer.name,
    responsibility: layer.responsibility,
    member_entity_ids: [...layer.component_ids],
    relation_ids: [],
    evidence_ids: [...new Set(layer.evidence.map((row) => row.stable_id))],
    certainty: layer.certainty,
  }));
  const projections = deriveSnapshotProjections({
    snapshot_id: input.snapshotId,
    nodes: hierarchy.nodes,
    edges: hierarchy.edges,
    overlays,
  });

  return {
    snapshot_id: input.snapshotId,
    summary: {
      file_count: input.files.length,
      symbol_count: symbols.length,
      call_count: relations.filter((row) => row.kind === "calls").length,
      unresolved_syntax_call_count: unresolvedCalls,
      unresolved_import_count: unresolvedImports,
      typescript_binding_file_count: input.files.filter(
        (file) => file.relationBinding === "typescript",
      ).length,
      import_count: relations.filter((row) => row.kind === "imports").length,
      inherit_count: relations.filter(
        (row) => row.kind === "inherits" || row.kind === "implements",
      ).length,
      component_count: components.length,
      lsp_projects_completed: lspResults.filter((result) => result.completed)
        .length,
      lsp_toolchains_verified: lspResults.filter(
        (result) => result.toolchainVerified,
      ).length,
    },
    graph: {
      schema_version: "evidence-graph-v2",
      semantic_mode: "structural_candidate",
      nodes: hierarchy.nodes,
      edges: hierarchy.edges,
      layers: [...layerGroups.values()],
      unassigned_component_ids: [],
      hierarchy: hierarchy.hierarchy,
      overlays,
      projections,
    },
    fact_graph: {
      nodes: [...fileNodes, ...symbolNodes],
      edges: factEdges,
    },
    value_points: [],
    languages,
    source_reports: sourceReports,
    static_analysis: {
      schema_version: "project-facts-v1",
      position_encoding: "utf-16",
      range_end: "exclusive",
      completeness: input.completeness ?? {
        inventoryComplete: false,
        knownSourceFiles: input.files.filter((f) => f.language !== "unknown")
          .length,
        omitted: [],
        reasons: ["inventory_completeness_unknown"],
      },
      projects: [...projects.values()],
      files: input.files.map((f) => ({
        path: f.path,
        language: f.language,
        syntax_completed: f.language !== "unknown" && !f.parseError,
        semantic_completed: f.semanticComplete === true,
        diagnostics: f.diagnostics ?? [],
        calls: f.calls,
        imports: f.imports,
        exports: f.exports ?? [],
        unresolvedHeritage: f.unresolvedHeritage ?? [],
      })),
      coverage: {
        discovered_call_sites: input.files.reduce(
          (n, f) => n + f.calls.length,
          0,
        ),
        call_statuses: statuses,
        syntax_files_completed: input.files.filter(
          (f) => f.language !== "unknown" && !f.parseError,
        ).length,
        semantic_files_completed: input.files.filter((f) => f.semanticComplete)
          .length,
      },
      limitations: [
        "Static bindings do not prove unique runtime dispatch.",
        "Missing facts are not evidence of absence; consult file diagnostics and source inventory.",
      ],
    },
    learning_plan: {
      snapshot_id: input.snapshotId,
      selected_value_point: null,
      steps: [],
    },
    source_root: input.sourceRoot,
    repository: input.repository,
    commit_sha: input.commitSha,
    research: input.research,
  };
}
