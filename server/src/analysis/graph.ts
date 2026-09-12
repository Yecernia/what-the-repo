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
  if (["src", "app", "packages", "lib", "server", "backend", "web"].includes(parts[0] as string)) {
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
    return { name: "认证与权限层", responsibility: "处理身份、登录和访问控制相关职责。", layer: "入口与安全层" };
  }
  if (/api|route|controller|handler|http|server/.test(lower)) {
    return { name: "接口与入口层", responsibility: "接收外部请求并把请求交给应用服务。", layer: "入口与安全层" };
  }
  if (/service|usecase|application|workflow/.test(lower)) {
    return { name: "应用服务层", responsibility: "编排具体业务流程和跨模块协作。", layer: "业务编排层" };
  }
  if (/domain|model|entity|core/.test(lower)) {
    return { name: "核心领域层", responsibility: "表达项目的核心对象、规则和稳定契约。", layer: "核心领域层" };
  }
  if (/component|ui|view|page|screen|widget/.test(lower)) {
    return { name: "界面组件层", responsibility: "组织用户界面组件和交互展示。", layer: "表现层" };
  }
  if (/test|spec|fixture/.test(lower)) {
    return { name: "测试与验证层", responsibility: "验证代码行为和产品契约。", layer: "质量保障层" };
  }
  if (/doc|readme|skill|guide/.test(lower)) {
    return { name: "文档与规范层", responsibility: "保存项目说明、操作规范和可迁移知识。", layer: "知识与规范层" };
  }
  if (/config|infra|deploy|docker|script|tool/.test(lower)) {
    return { name: "基础设施与配置层", responsibility: "提供运行配置、部署和开发辅助能力。", layer: "基础设施层" };
  }
  const last = key.split("/").at(-1) ?? key;
  return {
    name: key === "root" ? "项目入口与配置" : `${last} 模块`,
    responsibility: "组织该目录下的相关文件和实现。",
    layer: "共享基础层",
  };
}

function mergeSymbols(files: ParsedFile[], lspResults: LspRunResult[]): StaticSymbolFact[] {
  const symbols = files.flatMap((file) => file.symbols.map((symbol) => ({
    ...symbol,
    bases: [...symbol.bases],
    sources: [...symbol.sources],
  })));
  for (const result of lspResults) {
    for (const candidate of result.symbols) {
      const existing = symbols.find((symbol) =>
        symbol.path === candidate.path
        && (symbol.qualifiedName === candidate.qualifiedName || symbol.name === candidate.name)
        && Math.abs(symbol.startLine - candidate.startLine) <= 2);
      if (existing) {
        if (!existing.sources.includes("lsp")) existing.sources.push("lsp");
        continue;
      }
      symbols.push({
        stableId: symbolStableId(candidate.path, candidate.qualifiedName, candidate.kind),
        name: candidate.name,
        qualifiedName: candidate.qualifiedName,
        kind: candidate.kind,
        path: candidate.path,
        language: result.language,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        startColumn: candidate.startColumn,
        endColumn: candidate.endColumn,
        parameterCount: null,
        implicitReceiverCount: 0,
        bases: [],
        sources: ["lsp"],
      });
    }
  }
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    if (seen.has(symbol.stableId)) return false;
    seen.add(symbol.stableId); return true;
  });
}

function resolveImportPath(
  sourcePath: string,
  rawImport: string,
  language: string,
  files: Set<string>,
): string | null {
  const raw = rawImport.trim();
  let base: string;
  if (raw.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(sourcePath), raw));
  } else if (language === "cpp") {
    base = raw.replaceAll("\\", "/");
  } else if (["csharp", "java", "php", "go"].includes(language)) {
    base = raw.replaceAll("\\", "/").replaceAll(".", "/");
  } else {
    base = raw.replaceAll("::", "/").replaceAll(".", "/");
  }
  base = base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  const candidates = [...files].filter((path) => {
    const stem = path.replace(/\.[^.\/]+$/, "");
    const parent = posix.dirname(path) === "." ? "" : posix.dirname(path);
    return path === base
      || path.endsWith(`/${base}`)
      || stem === base
      || stem.endsWith(`/${base}`)
      || parent === base
      || parent.endsWith(`/${base}`)
      || (posix.basename(stem) === posix.basename(base) && path.startsWith(base));
  });
  const exact = candidates.filter((path) => path === base || path.replace(/\.[^./]+$/, "") === base);
  const unambiguous = exact.length ? exact : candidates;
  return unambiguous.length === 1 ? unambiguous[0]! : null;
}

function chooseSymbol(
  rawName: string,
  symbols: StaticSymbolFact[],
  currentPath: string,
  argumentCount: number | null = null,
): StaticSymbolFact | null {
  const name = rawName.trim();
  // A short name is not a cross-file binding. Receiver calls require a compiler/LSP result.
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  let candidates = symbols.filter((symbol) => symbol.path === currentPath && symbol.name === name
    && !symbol.qualifiedName.includes("."));
  if (argumentCount !== null) {
    const arity = candidates.filter((symbol) =>
      symbol.parameterCount !== null
      && Math.max(0, symbol.parameterCount - symbol.implicitReceiverCount) === argumentCount);
    if (arity.length) candidates = arity;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function symbolAt(
  symbols: StaticSymbolFact[],
  path: string,
  name: string,
  line: number,
): StaticSymbolFact | null {
  return symbols
    .filter((symbol) => symbol.path === path && (
      symbol.qualifiedName === name
      || symbol.name === name
      || symbol.name === name.split(".").at(-1)
    ))
    .sort((left, right) => Math.abs(left.startLine - line) - Math.abs(right.startLine - line))[0] ?? null;
}

function buildRelations(
  files: ParsedFile[],
  symbols: StaticSymbolFact[],
  lspResults: LspRunResult[],
  fileIdByPath: Map<string, string>,
): { relations: FactRelation[]; unresolvedCalls: number; unresolvedImports: number } {
  const knownFiles = new Set(files.map((file) => file.path));
  const byPath = new Map<string, StaticSymbolFact[]>();
  for (const symbol of symbols) {
    const group = byPath.get(symbol.path) ?? [];
    group.push(symbol); byPath.set(symbol.path, group);
  }
  let unresolvedCalls = 0;
  let unresolvedImports = 0;
  const rows = new Map<string, FactRelation>();
  const add = (relation: FactRelation): void => {
    const key = [
      relation.kind,
      relation.sourceId,
      relation.targetId,
      relation.line,
      relation.column,
    ].join("|");
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, relation);
      return;
    }
    existing.sources = [...new Set([...existing.sources, ...relation.sources])];
    if (relation.certainty === "verified") existing.certainty = "verified";
  };

  for (const file of files) {
    const fileId = fileIdByPath.get(file.path);
    if (!fileId) continue;
    const localSymbols = byPath.get(file.path) ?? [];
    for (const symbol of localSymbols) {
      add({
        sourceId: fileId,
        targetId: symbol.stableId,
        sourcePath: file.path,
        targetPath: symbol.path,
        kind: "contains",
        line: symbol.startLine,
        column: symbol.startColumn,
        certainty: "verified",
        sources: symbol.sources,
      });
      for (const base of symbol.bases) {
        const target = chooseSymbol(base, localSymbols, file.path);
        if (!target) continue;
        add({
          sourceId: symbol.stableId,
          targetId: target.stableId,
          sourcePath: symbol.path,
          targetPath: target.path,
          kind: "inherits",
          line: symbol.startLine,
          column: symbol.startColumn,
          certainty: "degraded",
          sources: ["tree_sitter"],
        });
      }
    }
    // Old cached documentation can contain regex calls; do not turn them into executable relations.
    if (file.language === "unknown") continue;
    for (const imported of file.imports) {
      const targetPath = file.relationBinding === "typescript" ? imported.resolvedPath
        : resolveImportPath(file.path, imported.source, file.language, knownFiles);
      const targetId = targetPath ? fileIdByPath.get(targetPath) : null;
      if (!targetPath || !targetId) { unresolvedImports++; continue; }
      add({
        sourceId: fileId,
        targetId,
        sourcePath: file.path,
        targetPath,
        kind: "imports",
        line: imported.line,
        column: 0,
        certainty: file.relationBinding === "typescript" ? "verified" : "degraded",
        sources: [file.relationBinding === "typescript" ? imported.typeOnly ? "typescript_type_import" : "typescript" : "syntax_import_candidate"],
      });
    }
    for (const call of file.calls) {
      const bound = call.target;
      const target = bound
        ? (byPath.get(bound.path) ?? []).find((symbol) => bound.symbolId ? symbol.stableId === bound.symbolId
          : symbol.startLine === bound.line && symbol.startColumn === bound.column)
        : file.relationBinding === "typescript" ? null : chooseSymbol(call.callee, localSymbols, file.path, call.argumentCount);
      const targetPath = bound?.path ?? target?.path;
      const targetId = target?.stableId ?? (targetPath ? fileIdByPath.get(targetPath) : null);
      if (!targetPath || !targetId) { unresolvedCalls++; continue; }
      add({
        sourceId: call.callerStableId ?? fileId,
        targetId,
        sourcePath: file.path,
        targetPath,
        kind: "calls",
        line: call.line,
        column: call.column,
        certainty: bound ? "verified" : "degraded",
        sources: [bound ? "typescript" : "local_name_candidate"],
      });
    }
  }

  for (const result of lspResults) {
    for (const relation of result.relations) {
      const source = symbolAt(symbols, relation.sourcePath, relation.sourceName, relation.sourceLine);
      const target = symbolAt(symbols, relation.targetPath, relation.targetName, relation.targetLine);
      if (!source || !target) continue;
      add({
        sourceId: source.stableId,
        targetId: target.stableId,
        sourcePath: relation.sourcePath,
        targetPath: relation.targetPath,
        kind: relation.kind,
        line: relation.sourceLine,
        column: relation.sourceColumn,
        certainty: result.truthVerified ? "verified" : "degraded",
        sources: ["lsp"],
      });
    }
  }
  return { relations: [...rows.values()], unresolvedCalls, unresolvedImports };
}

function relationLabel(kind: FactEdgeKind): string {
  if (kind === "contains") return "包含";
  if (kind === "imports") return "依赖";
  if (kind === "inherits") return "继承";
  if (kind === "implements") return "实现";
  return "调用";
}

function factEdge(row: FactRelation): SnapshotEdge {
  const edgeId = `fact:edge:${id([
    row.sourceId,
    row.targetId,
    row.kind,
    String(row.line),
    String(row.column),
  ].join(":"))}`;
  return {
    id: edgeId,
    source: row.sourceId,
    target: row.targetId,
    relation_kind: row.kind,
    label: relationLabel(row.kind),
    description: row.kind === "contains"
      ? "文件定义或包含该符号。"
      : row.certainty === "verified" ? `${row.sources.join(" + ")} 静态分析确认这条${relationLabel(row.kind)}绑定。`
        : `${row.sources.join(" + ")} 提供这条${relationLabel(row.kind)}候选，实际目标仍需核实。`,
    certainty: row.certainty,
    evidence: [evidence(
      edgeId,
      `${row.sourcePath}:${row.line}`,
      row.sourcePath,
      row.line,
      row.line,
      row.kind,
      { sourceId: row.sourceId, targetId: row.targetId },
    )],
    weight: 1,
    source_observations: row.sources.map((source) => ({
      extractor: source,
      certainty: row.certainty === "verified" ? "direct" : "inferred",
      reason_code: `${source}_${row.kind}`,
    })),
  };
}

function aggregateComponentEdges(
  relations: FactRelation[],
  componentByFile: Map<string, string>,
): SnapshotEdge[] {
  const groups = new Map<string, {
    rows: FactRelation[];
    source: string;
    target: string;
    kind: FactEdgeKind;
  }>();
  for (const row of relations) {
    if (row.kind === "contains") continue;
    const source = componentByFile.get(row.sourcePath);
    const target = componentByFile.get(row.targetPath);
    if (!source || !target || source === target) continue;
    const key = [source, target, row.kind].join("|");
    const current = groups.get(key) ?? { rows: [], source, target, kind: row.kind };
    current.rows.push(row);
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => {
    const edgeId = `component:edge:${id([group.source, group.target, group.kind].join(":"))}`;
    return {
      id: edgeId,
      source: group.source,
      target: group.target,
      relation_kind: group.kind,
      label: relationLabel(group.kind),
      description: `${group.rows.length} 处静态分析记录支持此关系，其中${group.rows.filter((row) => row.certainty === "verified").length}处已确认绑定；其余为待核实候选。`,
      certainty: group.rows.some((row) => row.certainty === "verified") ? "verified" : "degraded",
      evidence: group.rows.slice(0, 12).map((row, index) => evidence(
        `${edgeId}:evidence:${index}`,
        `${row.sourcePath}:${row.line}`,
        row.sourcePath,
        row.line,
        row.line,
        row.kind,
        { sourceId: row.sourceId, targetId: row.targetId },
      )),
      weight: group.rows.length,
      source_observations: group.rows.flatMap((row) => row.sources.map((source) => ({
        extractor: source,
        certainty: row.certainty,
        reason_code: `${source}_${row.kind}`,
      }))).slice(0, 24),
    };
  });
}

function languageReports(files: ParsedFile[], lspResults: LspRunResult[]): EvidenceSnapshot["languages"] {
  const lspByLanguage = new Map(lspResults.map((result) => [result.language, result]));
  const languages = [...new Set(files.map((file) => file.language).filter((language) => language !== "unknown"))];
  return languages.map((language) => {
    const rows = files.filter((file) => file.language === language);
    const parsed = rows.filter((file) => file.parseError === null).length;
    const grammarUnavailable = rows.every((file) => file.parseError === "tree_sitter_grammar_unavailable");
    const lsp = lspByLanguage.get(language);
    const quality = lsp?.truthVerified && parsed === rows.length
      ? "verified"
      : parsed > 0 || lsp?.completed
        ? "degraded"
        : "unavailable";
    const reasonCodes = [
      ...rows.flatMap((file) => file.parseError ? [file.parseError] : []),
      ...(lsp?.reasonCodes ?? (grammarUnavailable ? ["lsp_unavailable"] : ["tree_sitter_only", "lsp_unavailable"])),
    ];
    if (lsp?.completed && !lsp.truthVerified) reasonCodes.push("lsp_not_truth_verified");
    return {
      language,
      quality_tier: quality,
      files_seen: rows.length,
      files_analyzed: parsed,
      files_failed: rows.length - parsed,
      reason_codes: [...new Set(reasonCodes)],
      adapter_name: "typescript-lsp-tree-sitter-adapter",
      adapter_version: "0.2.0",
      lsp_name: lsp?.serverName ?? null,
      lsp_version: lsp?.serverVersion ?? null,
      parser_name: `tree-sitter-${language}`,
      parser_version: "node-wasm-0.26",
      capabilities: [
        "symbols",
        "imports",
        "locations",
        ...(lsp?.capabilities ?? []),
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
}): BuiltSnapshot {
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
      },
      observations: [{ extractor: "safe_manifest", certainty: "direct", reason_code: "file_scan" }],
    });
  });
  const symbols = mergeSymbols(input.files, lspResults);
  const verifiedLanguages = new Set(lspResults.filter((result) => result.truthVerified).map((result) => result.language));
  const symbolNodes = symbols.map((symbol) => graphNode({
    id: symbol.stableId,
    entityKind: "fact",
    name: symbol.name,
    evidence: [evidence(
      symbol.stableId,
      `${symbol.qualifiedName} (${symbol.kind})`,
      symbol.path,
      symbol.startLine,
      symbol.endLine,
      "symbol",
    )],
    certainty: symbol.sources.includes("tree_sitter") || verifiedLanguages.has(symbol.language) ? "verified" : "degraded",
    attributes: {
      path: symbol.path,
      qualified_name: symbol.qualifiedName,
      kind: symbol.kind,
      language: symbol.language,
      start_line: symbol.startLine,
      end_line: symbol.endLine,
      start_column: symbol.startColumn,
      end_column: symbol.endColumn,
    },
    observations: symbol.sources.map((source) => ({
      extractor: source,
      certainty: source === "lsp" && verifiedLanguages.has(symbol.language) ? "direct" : "inferred",
      reason_code: source === "lsp" ? "lsp_document_symbol" : "tree_sitter_declaration",
    })),
  }));
  const { relations, unresolvedCalls, unresolvedImports } = buildRelations(input.files, symbols, lspResults, fileIdByPath);
  const factEdges = relations.map(factEdge);

  const filesByGroup = new Map<string, ParsedFile[]>();
  for (const file of input.files) {
    const key = groupKey(file.path);
    filesByGroup.set(key, [...(filesByGroup.get(key) ?? []), file]);
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
    components.push(graphNode({
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
    }));
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
  const componentById = new Map(components.map((component) => [component.id, component]));
  for (const edge of componentEdges) {
    const source = componentById.get(edge.source);
    const target = componentById.get(edge.target);
    if (source) source.fan_out += 1;
    if (target) target.fan_in += 1;
  }

  const languages = languageReports(input.files, lspResults);
  const sourceReports = languages.flatMap((report) => {
    const lsp = lspResults.find((result) => result.language === report.language);
    return [{
      source_id: `source:tree_sitter:${report.language}`,
      source_kind: "tree_sitter",
      implementation_name: `tree-sitter-${report.language}`,
      implementation_version: "node-wasm-0.26",
      status: report.files_analyzed > 0 ? (report.files_failed ? "degraded" : "available") : "failed",
      reason_codes: report.reason_codes.filter((code) => code.startsWith("tree_")),
    }, {
      source_id: `source:lsp:${report.language}`,
      source_kind: "lsp",
      implementation_name: lsp?.serverName ?? "unavailable",
      implementation_version: lsp?.serverVersion ?? null,
      status: lsp?.truthVerified ? "available" : lsp?.completed ? "degraded" : "failed",
      reason_codes: lsp?.reasonCodes ?? ["lsp_unavailable"],
    }];
  });

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
      typescript_binding_file_count: input.files.filter((file) => file.relationBinding === "typescript").length,
      import_count: relations.filter((row) => row.kind === "imports").length,
      inherit_count: relations.filter((row) => row.kind === "inherits" || row.kind === "implements").length,
      component_count: components.length,
      lsp_languages_completed: lspResults.filter((result) => result.completed).length,
      lsp_languages_verified: lspResults.filter((result) => result.truthVerified).length,
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
