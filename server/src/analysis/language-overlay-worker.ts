import { Type, type Static } from "typebox";
import { runStructuredWorker } from "../agent/structured-worker.js";
import { loadProductSkill } from "../agent/skill-registry.js";
import { chunks, cachedStructuredResult, runRecordedSemanticBatch, semanticBatchInputIdentity, semanticRunContract } from "./semantic-batch-runner.js";
import { VALUE_BODY_MAX_LENGTH, type SemanticBatchContext } from "./semantic-contracts.js";
import type { PiModelRuntime } from "../agent/types.js";
import { trackAnalysisStage } from "./progress.js";
import { nowIso } from "../domain/conversation.js";
import {
  displayLanguageInstruction,
  languageHasNaturalText,
  normalizeDisplayLanguage,
} from "../domain/display-language.js";
import {
  SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
  type ComponentLanguageText,
  type LayerLanguageText,
  type RelationLanguageText,
  type SnapshotLanguageOverlayPayload,
  type ValuePointLanguageText,
} from "../domain/snapshot-language.js";

const MODE = Type.Unsafe<"components" | "layers" | "relations" | "value_points">({
  type: "string",
  enum: ["components", "layers", "relations", "value_points"],
});

const RESULT = Type.Object({
  mode: MODE,
  components: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ maxLength: 256 }),
    name: Type.String({ maxLength: 120 }),
    responsibility: Type.String({ maxLength: 600 }),
    grouping_rationale: Type.String({ maxLength: 700 }),
    architecture_layer_rationale: Type.String({ maxLength: 700 }),
  }), { maxItems: 32 })),
  layers: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ maxLength: 256 }),
    name: Type.String({ maxLength: 120 }),
    responsibility: Type.String({ maxLength: 600 }),
  }), { maxItems: 24 })),
  relations: Type.Optional(Type.Array(Type.Object({
    kind: Type.String({ maxLength: 100 }),
    label: Type.String({ maxLength: 120 }),
    description: Type.String({ maxLength: 500 }),
  }), { maxItems: 24 })),
  value_points: Type.Optional(Type.Array(Type.Object({
    stable_id: Type.String({ maxLength: 256 }),
    title: Type.String({ maxLength: 160 }),
    claim: Type.String({ maxLength: VALUE_BODY_MAX_LENGTH }),
    problem: Type.String({ maxLength: VALUE_BODY_MAX_LENGTH }),
    implementation: Type.String({ maxLength: VALUE_BODY_MAX_LENGTH }),
    tradeoffs: Type.String({ maxLength: VALUE_BODY_MAX_LENGTH }),
    transfer_conditions: Type.String({ maxLength: VALUE_BODY_MAX_LENGTH }),
  }), { maxItems: 12 })),
});

type OverlayResult = Static<typeof RESULT>;
type OverlayMode = OverlayResult["mode"];

export interface GeneratedLanguageOverlay {
  payload: SnapshotLanguageOverlayPayload;
  degraded: boolean;
  errors: string[];
  stopReasons: string[];
}

export async function generateSnapshotLanguageOverlay(input: {
  source: SnapshotLanguageOverlayPayload;
  targetLanguage: string;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
  batchContext?: SemanticBatchContext & { snapshotId: string };
}): Promise<GeneratedLanguageOverlay> {
  input.signal?.throwIfAborted();
  const skill = input.modelRuntime.skills?.["snapshot-language-overlay"] ?? await loadProductSkill("snapshot-language-overlay");
  const runtime: PiModelRuntime = { ...input.modelRuntime, skills: { ...input.modelRuntime.skills, [skill.id]: skill } };
  const targetLanguage = normalizeDisplayLanguage(input.targetLanguage);
  let ordinal = 0;
  const translate = (mode: OverlayMode, items: unknown[], context?: SemanticBatchContext) => translateBatch(mode, items, targetLanguage, runtime, input.signal,
    context && input.batchContext ? { ...context, snapshotId: input.batchContext.snapshotId } : undefined, ordinal++);
  const errors: string[] = [];
  const stopReasons: string[] = [];
  const components: ComponentLanguageText[] = [];
  const layers: LayerLanguageText[] = [];
  const relations: RelationLanguageText[] = [];
  const valuePoints: ValuePointLanguageText[] = [];

  if (input.source.components.length) {
    const errorsBefore = errors.length;
    await trackAnalysisStage("translating_components", input.batchContext, async scoped => {
      for (const batch of chunks(input.source.components, 32)) {
        const result = await translate("components", batch, scoped);
        stopReasons.push(result.stopReason);
        errors.push(...result.errors);
        const translated = new Map((result.value?.components ?? []).map((item) => [item.id, item]));
        for (const source of batch) {
          const item = translated.get(source.id);
          if (!item) errors.push(`组件 ${source.id} 缺少目标语言结果`);
          components.push(item ? {
            id: source.id,
            name: item.name,
            responsibility: item.responsibility,
            grouping_rationale: item.grouping_rationale,
            architecture_layer_rationale: item.architecture_layer_rationale || null,
          } : source);
        }
      }
    }, { batches: true, totalBatches: Math.ceil(input.source.components.length / 32), signal: input.signal,
      status: () => errors.length > errorsBefore ? "degraded" : "completed" });
  }
  if (input.source.layers.length) {
    const errorsBefore = errors.length;
    await trackAnalysisStage("translating_layers", input.batchContext, async scoped => {
      for (const batch of chunks(input.source.layers, 24)) {
        const result = await translate("layers", batch, scoped);
        stopReasons.push(result.stopReason);
        errors.push(...result.errors);
        const translated = new Map((result.value?.layers ?? []).map((item) => [item.id, item]));
        for (const source of batch) {
          const item = translated.get(source.id);
          if (!item) errors.push(`架构层 ${source.id} 缺少目标语言结果`);
          layers.push(item ? { id: source.id, name: item.name, responsibility: item.responsibility } : source);
        }
      }
    }, { batches: true, totalBatches: Math.ceil(input.source.layers.length / 24), signal: input.signal,
      status: () => errors.length > errorsBefore ? "degraded" : "completed" });
  }
  if (input.source.relations.length) {
    const errorsBefore = errors.length;
    await trackAnalysisStage("translating_relations", input.batchContext, async scoped => {
      for (const batch of chunks(input.source.relations, 24)) {
        const result = await translate("relations", batch, scoped);
        stopReasons.push(result.stopReason);
        errors.push(...result.errors);
        const translated = new Map((result.value?.relations ?? []).map((item) => [item.kind, item]));
        for (const source of batch) {
          const item = translated.get(source.kind);
          if (!item) errors.push(`关系类型 ${source.kind} 缺少目标语言结果`);
          relations.push(item ? { kind: source.kind, label: item.label, description: item.description } : source);
        }
      }
    }, { batches: true, totalBatches: Math.ceil(input.source.relations.length / 24), signal: input.signal,
      status: () => errors.length > errorsBefore ? "degraded" : "completed" });
  }
  if (input.source.value_points.length) {
    const errorsBefore = errors.length;
    await trackAnalysisStage("translating_values", input.batchContext, async scoped => {
      for (const batch of chunks(input.source.value_points, 12)) {
        const result = await translate("value_points", batch, scoped);
        stopReasons.push(result.stopReason);
        errors.push(...result.errors);
        const translated = new Map((result.value?.value_points ?? []).map((item) => [item.stable_id, item]));
        for (const source of batch) {
          const item = translated.get(source.stable_id);
          if (!item) errors.push(`价值点 ${source.stable_id} 缺少目标语言结果`);
          valuePoints.push(item ? {
            stable_id: source.stable_id,
            title: item.title,
            claim: item.claim,
            problem: item.problem || null,
            implementation: item.implementation || null,
            tradeoffs: item.tradeoffs || null,
            transfer_conditions: item.transfer_conditions || null,
          } : source);
        }
      }
    }, { batches: true, totalBatches: Math.ceil(input.source.value_points.length / 12), signal: input.signal,
      status: () => errors.length > errorsBefore ? "degraded" : "completed" });
  }

  return {
    payload: {
      schema_version: SNAPSHOT_LANGUAGE_OVERLAY_VERSION,
      language: targetLanguage,
      generated_at: nowIso(),
      components,
      layers,
      relations,
      value_points: valuePoints,
    },
    degraded: errors.length > 0,
    errors: [...new Set(errors)],
    stopReasons,
  };
}

async function translateBatch(
  mode: OverlayMode,
  items: unknown[],
  targetLanguage: string,
  modelRuntime: PiModelRuntime,
  signal?: AbortSignal,
  batchContext?: SemanticBatchContext & { snapshotId: string },
  ordinal = 0,
): Promise<{ value: OverlayResult | null; errors: string[]; stopReason: string }> {
  signal?.throwIfAborted();
  const expected = expectedKeys(mode, items);
  const skill = modelRuntime.skills!["snapshot-language-overlay"]!;
  const workerInput = { mode, target_language: targetLanguage, items };
  const batchId = `language-${mode}-${ordinal + 1}`;
  const result = await runRecordedSemanticBatch({
    context: batchContext,
    descriptor: { batch_id: batchId, job_id: batchContext?.jobId ?? "language-untracked",
      snapshot_id: batchContext?.snapshotId ?? "language-untracked", phase: "language_overlay", ordinal,
      input: semanticBatchInputIdentity(workerInput, modelRuntime, "snapshot-language-overlay", skill, "low") },
    decode: cachedStructuredResult<OverlayResult>,
    run: () => runStructuredWorker({
      skillId: "snapshot-language-overlay",
      ...semanticRunContract("snapshot-language-overlay"),
      productSkill: skill,
      diagnosticIdentity: { jobId: batchContext?.jobId ?? "language-untracked", jobAttempt: batchContext?.jobAttempt ?? 0, batchId },
      modelRuntime,
      thinkingLevel: "low",
      signal,
      schema: RESULT,
      systemPrompt: [
        displayLanguageInstruction(targetLanguage),
        "程序锁定全部对象、结构和 ID；本轮只生成指定语言的显示文字覆盖。",
        "输出中的 mode 必须与输入一致，当前批次每个固定键恰好出现一次。",
      ].join("\n"),
      userPrompt: JSON.stringify(workerInput),
      validateSubmitted: (value) => validateOverlayBatch(value, mode, expected, targetLanguage, items),
    }),
  });
  signal?.throwIfAborted();
  if (!result.value) throw new Error(result.stopReason === "provider_request_failed"
    ? "language_overlay_provider_unavailable" : "language_overlay_output_missing");
  return { value: result.value, errors: result.validationErrors, stopReason: result.stopReason };
}

function validateOverlayBatch(
  value: OverlayResult,
  mode: OverlayMode,
  expected: string[],
  language: string,
  sourceItems: unknown[],
): string[] {
  const errors: string[] = [];
  if (value.mode !== mode) errors.push(`overlay_structure_mode: mode 应为 ${mode}`);
  const rows = mode === "components" ? value.components ?? []
    : mode === "layers" ? value.layers ?? []
      : mode === "relations" ? value.relations ?? []
        : value.value_points ?? [];
  const actual = rows.map((row) => rowKey(mode, row));
  if (new Set(actual).size !== actual.length) errors.push("overlay_structure_duplicate: 存在重复固定 ID");
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length) errors.push(`overlay_structure_missing: 缺少固定 ID: ${missing.join(", ")}`);
  if (extra.length) errors.push(`overlay_structure_unknown: 包含未知 ID: ${extra.join(", ")}`);
  const sourceByKey = new Map(sourceItems.map((item) => [rowKey(mode, item as Record<string, unknown>), item as Record<string, unknown>]));
  for (const row of rows as Array<Record<string, unknown>>) {
    const key = rowKey(mode, row);
    const source = sourceByKey.get(key) ?? {};
    for (const field of textFields(mode)) {
      const sourceText = typeof source[field] === "string" ? String(source[field]) : "";
      const targetText = typeof row[field] === "string" ? String(row[field]) : "";
      if (!sourceText.trim()) continue;
      if (!languageHasNaturalText(targetText, language)) errors.push(`${key}.${field} 没有使用目标语言`);
      if (sourceText.includes("{count}") && !targetText.includes("{count}")) errors.push(`overlay_structure_placeholder: ${key}.${field} 丢失 {count}`);
    }
  }
  return [...new Set(errors)];
}

function expectedKeys(mode: OverlayMode, items: unknown[]): string[] {
  return items.map((item) => rowKey(mode, item as Record<string, unknown>));
}

function rowKey(mode: OverlayMode, item: Record<string, unknown>): string {
  if (mode === "relations") return String(item.kind ?? "");
  if (mode === "value_points") return String(item.stable_id ?? "");
  return String(item.id ?? "");
}

function textFields(mode: OverlayMode): string[] {
  if (mode === "components") return ["name", "responsibility", "grouping_rationale", "architecture_layer_rationale"];
  if (mode === "layers") return ["name", "responsibility"];
  if (mode === "relations") return ["label", "description"];
  return ["title", "claim", "problem", "implementation", "tradeoffs", "transfer_conditions"];
}
