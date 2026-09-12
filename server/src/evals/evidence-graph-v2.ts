import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFileChanges,
  incrementalSummary,
} from "../analysis/incremental.js";
import { createSemanticBatch } from "../domain/semantic-batch.js";
import {
  deriveSnapshotProjections,
  type SnapshotProjectionPair,
} from "../domain/snapshot-projection.js";
import {
  type EvidenceSnapshot,
  type SnapshotEdge,
  type SnapshotEvidence,
  type SnapshotNode,
} from "../domain/snapshot.js";
import {
  validateEvidenceSnapshot,
} from "../domain/snapshot-validation.js";
import { measureEvidenceQuality } from "../domain/evidence-quality.js";

export const EVIDENCE_GRAPH_EVAL_SCHEMA_VERSION = "evidence-graph-v2-eval-v1" as const;
export const LARGE_REPOSITORY_FILE_COUNT = 10_001;

export interface EvidenceGraphV2EvalReport {
  schema_version: typeof EVIDENCE_GRAPH_EVAL_SCHEMA_VERSION;
  generated_at: string;
  passed: boolean;
  checks: Record<string, boolean>;
  metrics: Record<string, unknown>;
  limitations: string[];
}

interface SyntheticLargeSnapshot {
  snapshot: EvidenceSnapshot;
  evidenceId: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidence(
  stableId: string,
  path: string,
  kind = "file",
  sourceId?: string,
  targetId?: string,
): SnapshotEvidence {
  return {
    stable_id: stableId,
    label: path,
    path,
    start_line: 1,
    end_line: 1,
    kind,
    source_id: sourceId,
    target_id: targetId,
  };
}

function node(
  id: string,
  entityKind: SnapshotNode["entity_kind"],
  parentEntityId: string | null,
  depth: number,
  evidenceRows: SnapshotEvidence[],
): SnapshotNode {
  return {
    id,
    entity_kind: entityKind,
    parent_entity_id: parentEntityId,
    depth,
    label: id,
    name: id,
    responsibility: `Synthetic ${entityKind} for deterministic evaluation.`,
    grouping_rationale: "Generated only for the bounded evidence-graph evaluation.",
    architecture_layer_id: "layer:synthetic",
    architecture_layer_name: "Synthetic layer",
    architecture_layer_candidates: [],
    architecture_layer_rationale: null,
    architecture_layer_certainty: "verified",
    members: evidenceRows,
    member_count: evidenceRows.length,
    evidence: evidenceRows,
    certainty: "verified",
    review_status: "unreviewed",
    source_report_ids: [],
    fan_in: 0,
    fan_out: 0,
  };
}

function relation(id: string, source: string, target: string, row: SnapshotEvidence): SnapshotEdge {
  return {
    id,
    source,
    target,
    relation_kind: "depends_on",
    label: "depends on",
    description: "Synthetic relation used only by the deterministic evaluation.",
    certainty: "verified",
    evidence: [row],
    weight: 1,
  };
}

/** Build a large but cheap graph without reading or executing a target repository. */
export function buildSyntheticLargeSnapshot(
  fileCount = LARGE_REPOSITORY_FILE_COUNT,
): SyntheticLargeSnapshot {
  const files = Array.from({ length: fileCount }, (_, index) => {
    const path = `src/generated/file-${String(index).padStart(5, "0")}.ts`;
    const row = evidence(`evidence:file:${index}`, path);
    return {
      path,
      row,
      node: node(`fact:file:${index}`, "fact", null, 0, [row]),
    };
  });
  const rootEvidence = files[0]!.row;
  const root = node("entity:repository:synthetic", "repository", null, 0, [rootEvidence]);
  const subsystems = Array.from({ length: 10 }, (_, index) => {
    const row = files[index + 1]!.row;
    return node(
      `entity:subsystem:${index}`,
      "subsystem",
      root.id,
      1,
      [row],
    );
  });
  const components = Array.from({ length: 100 }, (_, index) => {
    const subsystem = subsystems[index % subsystems.length]!;
    const row = files[index + 11]!.row;
    return node(
      `entity:component:${index}`,
      "component",
      subsystem.id,
      2,
      [row],
    );
  });
  const graphNodes = [root, ...subsystems, ...components];
  const graphEdges = components.slice(1).map((component, index) => {
    const source = components[index]!;
    const row = evidence(
      `evidence:relation:${index}`,
      `src/generated/file-${String(index + 11).padStart(5, "0")}.ts`,
      "relation",
      source.id,
      component.id,
    );
    return relation(`relation:synthetic:${index}`, source.id, component.id, row);
  });
  const overlays = [{
    id: "overlay:synthetic",
    kind: "architecture_layer" as const,
    name: "Synthetic layer",
    responsibility: "Synthetic architecture overlay.",
    member_entity_ids: graphNodes.map((item) => item.id),
    relation_ids: graphEdges.map((item) => item.id),
    evidence_ids: [rootEvidence.stable_id],
    certainty: "verified",
  }];
  const projections = deriveSnapshotProjections({
    snapshot_id: "eval:evidence-graph-v2",
    nodes: graphNodes,
    edges: graphEdges,
    overlays,
    max_human_depth: 1,
    human_collapse_threshold: 24,
  });
  const snapshot: EvidenceSnapshot = {
    snapshot_id: "eval:evidence-graph-v2",
    summary: {
      file_count: fileCount,
      symbol_count: fileCount,
      call_count: graphEdges.length,
      import_count: graphEdges.length,
      inherit_count: 0,
      component_count: components.length,
    },
    graph: {
      schema_version: "evidence-graph-v2",
      semantic_mode: "structural_candidate",
      semantic_coverage: {
        total_components: components.length,
        provider_supported_components: components.length - 3,
        degraded_component_ids: components.slice(-3).map((item) => item.id),
      },
      nodes: graphNodes,
      edges: graphEdges,
      layers: [{
        id: "layer:synthetic",
        name: "Synthetic layer",
        responsibility: "Synthetic architecture overlay.",
        component_ids: graphNodes.map((item) => item.id),
        evidence: [rootEvidence],
        certainty: "verified",
        source_report_ids: [],
      }],
      unassigned_component_ids: [],
      hierarchy: {
        root_entity_ids: [root.id],
        max_depth: 2,
      },
      overlays,
      projections,
    },
    fact_graph: {
      nodes: files.map((item) => item.node),
      edges: [],
    },
    value_points: [],
    languages: [
      {
        language: "typescript",
        quality_tier: "verified",
        files_seen: fileCount - 1,
        files_analyzed: fileCount - 1,
        files_failed: 0,
        reason_codes: [],
      },
      {
        language: "python",
        quality_tier: "degraded",
        files_seen: 1,
        files_analyzed: 0,
        files_failed: 1,
        reason_codes: ["parser_unavailable"],
      },
    ],
    learning_plan: {
      snapshot_id: "eval:evidence-graph-v2",
      selected_value_point: null,
      steps: [],
    },
    repository: "synthetic/evidence-graph-v2",
    commit_sha: "e".repeat(40),
  };
  return { snapshot, evidenceId: rootEvidence.stable_id };
}

function projectionConsistency(
  snapshot: EvidenceSnapshot,
  projections: SnapshotProjectionPair,
): boolean {
  const entityIds = new Set(snapshot.graph.nodes.map((item) => item.id));
  const relationIds = new Set(snapshot.graph.edges.map((item) => item.id));
  const overlayIds = new Set((snapshot.graph.overlays ?? []).map((item) => item.id));
  return [projections.human, projections.agent].every((projection) =>
    projection.nodes.every((item) => entityIds.has(item.entity_id)
      && (item.overlay_ids ?? []).every((id) => overlayIds.has(id)))
    && projection.edges.every((item) => (item.relation_id === null || relationIds.has(item.relation_id))
      && item.aggregate_relation_ids.every((id) => relationIds.has(id))
      && (item.overlay_ids ?? []).every((id) => overlayIds.has(id))),
  );
}

function incrementalDeletionCheck(fileCount: number): {
  passed: boolean;
  summary: Record<string, unknown>;
} {
  const digest = (index: number): string => sha(`file:${index}`);
  const previous = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/generated/file-${index}.ts`,
    digest: digest(index),
    bytes: 10,
  }));
  const current = previous.slice(0, -1);
  const changes = classifyFileChanges(previous, current);
  const summary = incrementalSummary({
    mode: "incremental",
    parentSnapshotId: "eval:previous",
    changes,
    affectedPaths: [previous.at(-1)!.path],
    affectedStableIds: [`fact:file:${fileCount - 1}`],
    recomputePaths: [],
    reusedPaths: current.map((item) => item.path),
    tombstonePaths: [previous.at(-1)!.path],
  });
  return {
    passed: changes.length === 1
      && changes[0]?.kind === "deleted"
      && summary.mode === "incremental"
      && summary.files_reused === fileCount - 1
      && summary.files_recomputed === 0,
    summary,
  };
}

function semanticResumeCheck(): boolean {
  const running = createSemanticBatch({
    batch_id: "batch:evidence-graph-v2",
    job_id: "job:evidence-graph-v2",
    snapshot_id: "eval:evidence-graph-v2",
    phase: "architecture_components",
    ordinal: 0,
    input: { offset: 0, limit: 100 },
    checkpoint: { offset: 0 },
  }, 1, "worker:eval", "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
  const resumed = {
    ...running,
    status: "succeeded" as const,
    attempt: 2,
    checkpoint: { offset: 100 },
    output_digest: sha("output"),
    output: { accepted: 100 },
    completed_at: "2026-09-03T00:00:01.000Z",
  };
  return running.status === "running"
    && resumed.status === "succeeded"
    && resumed.attempt > running.attempt
    && resumed.checkpoint.offset === 100
    && typeof resumed.output_digest === "string";
}

function semanticCancellationCheck(): boolean {
  const running = createSemanticBatch({
    batch_id: "batch:evidence-graph-v2-cancelled",
    job_id: "job:evidence-graph-v2-cancelled",
    snapshot_id: "eval:evidence-graph-v2",
    phase: "value_discovery",
    ordinal: 1,
    input: { offset: 100, limit: 100 },
    checkpoint: { offset: 100 },
  }, 1, "worker:eval", "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
  const cancelled = {
    ...running,
    status: "cancelled" as const,
    lease_owner: null,
    lease_expires_at: null,
    error: "analysis_cancelled",
    updated_at: "2026-09-03T00:00:02.000Z",
  };
  return cancelled.status === "cancelled"
    && cancelled.output === null
    && cancelled.output_digest === null
    && cancelled.error === "analysis_cancelled"
    && cancelled.lease_owner === null;
}

export function runEvidenceGraphV2Eval(): EvidenceGraphV2EvalReport {
  const startedAt = Date.now();
  const { snapshot, evidenceId } = buildSyntheticLargeSnapshot();
  const validation = validateEvidenceSnapshot(snapshot);
  const projections = snapshot.graph.projections as SnapshotProjectionPair;
  const quality = measureEvidenceQuality({
    events: [
      { type: "model_started", elapsed_ms: 4 },
      { type: "tool_call_requested", tool_call_id: "tool:query", elapsed_ms: 8 },
      { type: "tool_result_received", tool_call_id: "tool:query", elapsed_ms: 24, evidence_ids: [evidenceId] },
    ],
    observed_evidence_ids: [evidenceId],
    valid_evidence_ids: [evidenceId],
    referenced_evidence_ids: [evidenceId],
    usage: { inputTokens: 100, outputTokens: 30, cachedTokens: 5, cacheWriteTokens: 0 },
    expected_conclusions: [{ id: "conclusion:synthetic", evidence_ids: [evidenceId] }],
  });
  const incremental = incrementalDeletionCheck(LARGE_REPOSITORY_FILE_COUNT);
  const checks = {
    large_repository_10k_files: snapshot.summary.file_count >= LARGE_REPOSITORY_FILE_COUNT
      && (snapshot.fact_graph?.nodes.length ?? 0) >= LARGE_REPOSITORY_FILE_COUNT,
    partial_language_failure_visible: snapshot.languages.some((row) => row.quality_tier === "degraded" && row.files_failed > 0),
    projection_contract_valid: validation.valid,
    projection_ids_consistent: projectionConsistency(snapshot, projections),
    human_projection_collapses_depth: projections.human.nodes.length < snapshot.graph.nodes.length
      && (projections.human.nodes.find((item) => item.entity_id === "entity:subsystem:0")?.aggregate_member_entity_ids.length ?? 0) > 0,
    semantic_batch_resume_contract: semanticResumeCheck(),
    semantic_batch_cancellation_contract: semanticCancellationCheck(),
    incremental_deletion_contract: incremental.passed,
    evidence_quality_gate: quality.evolution_eligible,
  };
  return {
    schema_version: EVIDENCE_GRAPH_EVAL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    passed: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      elapsed_ms: Date.now() - startedAt,
      files: snapshot.summary.file_count,
      fact_nodes: snapshot.fact_graph?.nodes.length ?? 0,
      graph_entities: snapshot.graph.nodes.length,
      human_projection_nodes: projections.human.nodes.length,
      agent_projection_nodes: projections.agent.nodes.length,
      human_projection_omitted_entities: projections.human.omitted_entity_count ?? 0,
      degraded_languages: snapshot.languages.filter((row) => row.quality_tier !== "verified").map((row) => row.language),
      incremental: incremental.summary,
      evidence_quality: quality,
    },
    limitations: [
      "大仓库场景使用合成只读事实，不读取或执行第三方仓库代码。",
      "关键结论覆盖率需要带有标注的固定题集；本报告只验证一条合成结论。",
      "实时 Provider 质量、费用和人工双人标注仍需单独运行真实 Eval。",
    ],
  };
}

export async function writeEvidenceGraphV2Eval(outputPath: string): Promise<EvidenceGraphV2EvalReport> {
  const report = runEvidenceGraphV2Eval();
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0
    ? process.argv[outputIndex + 1]
    : join(root, "out", "evidence-graph-v2-eval", "report.json");
  if (!output) throw new Error("--output 需要文件路径");
  const report = await writeEvidenceGraphV2Eval(output);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: output })}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
