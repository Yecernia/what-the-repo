import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type {
  LearnerProfile,
  LearningActionTarget,
  Project,
  StudyState,
} from "../domain/conversation.js";
import type {
  EvidenceSnapshot,
  SnapshotEvidence,
  SnapshotLearningStep,
} from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import {
  displayLanguageInstruction,
  displayLanguageLabel,
  inferDisplayLanguage,
  languageHasNaturalText,
} from "../domain/display-language.js";
import { createRepositoryExplorationTools } from "./repository-exploration-tools.js";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime, PiUsageSummary } from "./types.js";

const ASSESSMENT_RESULT = Type.Object({
  verdict: Type.Union([
    Type.Literal("mastered"),
    Type.Literal("partial"),
    Type.Literal("misconception"),
    Type.Literal("unclear"),
  ]),
  feedback: Type.String({ minLength: 1, maxLength: 1_200 }),
  mastered_items: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 6 }),
  misconceptions: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 6 }),
  evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 10 }),
});

const LEARNING_ROUTE_RESULT = Type.Object({
  steps: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    objective: Type.String({ minLength: 1, maxLength: 500 }),
    completion_check: Type.String({ minLength: 1, maxLength: 500 }),
    component_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 8 }),
    evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 12 }),
  }), { maxItems: 10 }),
});

type LearningRouteResult = Static<typeof LEARNING_ROUTE_RESULT>;

function learningRouteLanguageError(
  step: LearningRouteResult["steps"][number],
  language: string,
): string | null {
  const fields = [
    ["title", step.title],
    ["objective", step.objective],
    ["completion_check", step.completion_check],
  ].filter(([, value]) => !languageHasNaturalText(value, language))
    .map(([field]) => field);
  return fields.length
    ? "字段 " + fields.join(", ") + " 没有使用" + displayLanguageLabel(language)
      + "；请保留代码标识，但把学习说明改写成用户语言。"
    : null;
}

export interface TeachingWorkerTrace {
  model?: string;
  provider?: string;
  worker_run_id: string;
  skill_id: string;
  skill_version: string;
  stop_reason: string;
  completed: boolean;
  usage: PiUsageSummary;
  evidence_ids: string[];
  state_candidate: boolean;
}

interface EvidencePacket {
  evidence_id: string;
  label: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  kind: string;
  excerpt: string[];
}

export async function runUnderstandingAssessment(input: {
  answer: string;
  evidence: SnapshotEvidence[];
  project: Project;
  snapshot: EvidenceSnapshot;
  store: ProductStore;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
}): Promise<{
  completed: boolean;
  feedback: string | null;
  verdict: string | null;
  masteredItems: string[];
  misconceptions: string[];
  acceptedEvidenceIds: string[];
  trace: TeachingWorkerTrace;
}> {
  const workerRunId = `worker:assessment:${randomUUID()}`;
  const step = currentStep(input.snapshot, input.project.study);
  const packets = await evidencePackets(
    input.evidence,
    input.project,
    input.snapshot,
    input.store,
  );
  const allowedIds = new Set(packets.map((packet) => packet.evidence_id));
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v2",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: ASSESSMENT_RESULT,
    systemPrompt: [
      "程序已经把当前步骤、原始用户消息和有界证据绑定到本次 Worker。",
      "不要读取其他仓库内容或替换原始回答；Evidence ID 只能来自输入，必须调用 submit_result。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      current_step: step,
      current_study: studySummary(input.project.study),
      original_user_answer: input.answer,
      evidence: packets,
    }),
  });
  const acceptedEvidenceIds = result.value
    ? [...new Set(result.value.evidence_ids.filter((id) => allowedIds.has(id)))]
    : [];
  const evidenceRequired = result.value?.verdict !== "unclear";
  const valid = Boolean(
    result.value
    && step
    && (!evidenceRequired || acceptedEvidenceIds.length),
  );
  return {
    completed: valid,
    feedback: result.value?.feedback ?? null,
    verdict: result.value?.verdict ?? null,
    masteredItems: result.value?.mastered_items ?? [],
    misconceptions: result.value?.misconceptions ?? [],
    acceptedEvidenceIds,
    trace: {
      worker_run_id: workerRunId,
      skill_id: "understanding-assessment",
      skill_version: result.skillVersion,
      model: result.model, provider: result.provider,
      stop_reason: valid ? result.stopReason : result.value ? "assessment_validation_failed" : result.stopReason,
      completed: valid,
      usage: result.usage,
      evidence_ids: acceptedEvidenceIds,
      state_candidate: false,
    },
  };
}

export async function generateLearningRoute(input: {
  project: Project;
  snapshot: EvidenceSnapshot;
  target: LearningActionTarget;
  request: string;
  profile: LearnerProfile;
  store: ProductStore;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
}): Promise<{
  completed: boolean;
  steps: SnapshotLearningStep[];
  trace: TeachingWorkerTrace;
}> {
  const workerRunId = `worker:learning-route:${randomUUID()}`;
  const displayLanguage = inferDisplayLanguage(
    [{ role: "user", content: input.request }],
    input.project.display_language,
  );
  const componentIds = new Set(input.snapshot.graph.nodes.map((node) => node.id));
  const valuePoint = input.target.kind === "value_point" && input.target.stable_id
    ? input.snapshot.value_points.find((point) => point.stable_id === input.target.stable_id) ?? null
    : null;
  const component = input.target.kind === "component" && input.target.stable_id
    ? input.snapshot.graph.nodes.find((node) => node.id === input.target.stable_id) ?? null
    : null;
  const layer = input.target.kind === "layer" && input.target.stable_id
    ? input.snapshot.graph.layers.find((item) => item.id === input.target.stable_id) ?? null
    : null;
  const exploration = createRepositoryExplorationTools({
    snapshot: input.snapshot,
    seedEvidenceIds: [
      ...(valuePoint?.evidence ?? []),
      ...(component ? [...component.evidence, ...component.members] : []),
      ...(layer?.evidence ?? []),
    ].map((row) => row.stable_id),
    readLines: async (path, start, end) => (
      await input.store.readSourceLines(
        input.project.project_id,
        input.snapshot.snapshot_id,
        path,
        start,
        end,
      )
    ).lines,
  });
  const result = await runStructuredWorker({
    skillId: "learning-route",
    inputSchemaId: "learning-route-input-v3",
    outputSchemaId: "learning-route-output-v3",
    contextBuilderId: "learning-route-context-v3",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: LEARNING_ROUTE_RESULT,
    tools: exploration.tools,
    systemPrompt: [
      displayLanguageInstruction(displayLanguage),
      "用户已经通过结构化确认卡批准为指定目标制定路线。",
      "程序绑定当前快照和目标，并校验最终 component_id/evidence_id；路线本身不直接写状态。",
    ].join("\n"),
    userPrompt: JSON.stringify({
      repository: input.project.source.display_name,
      display_language: displayLanguage,
      display_language_label: displayLanguageLabel(displayLanguage),
      original_learning_request: input.request,
      confirmed_target: input.target,
      target_value_point: valuePoint,
      learner: input.profile.enabled ? input.profile : null,
      repository_summary: input.snapshot.summary,
      architecture_layers: input.snapshot.graph.layers.map((layer) => ({
        layer_id: layer.id,
        name: layer.name,
        responsibility: layer.responsibility,
        component_count: layer.component_ids.length,
      })),
    }),
    validateSubmitted: (value) => [...new Set(value.steps
      .map((step) => learningRouteLanguageError(step, displayLanguage))
      .filter((error): error is string => Boolean(error)))],
  });
  const allowedEvidence = new Set(exploration.state.exposedEvidence.keys());
  const steps = result.value?.steps.flatMap((step, index) => {
    const validComponents = step.component_ids.filter((id) => componentIds.has(id));
    const evidenceIds = [...new Set(step.evidence_ids.filter((id) => allowedEvidence.has(id)))];
    if (!validComponents.length || !evidenceIds.length) return [];
    return [{
      step_id: `learning:${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      order: index + 1,
      title: step.title,
      objective: step.objective,
      evidence_refs: evidenceIds,
      component_ids: validComponents,
      completion_check: step.completion_check,
    }];
  }) ?? [];
  return {
    // An explicit learning request can legitimately produce no route when the
    // snapshot does not contain enough evidence. Keep that as a completed,
    // honest result so the caller can explain the gap without mutating study.
    completed: Boolean(result.value),
    steps,
    trace: {
      worker_run_id: workerRunId,
      skill_id: "learning-route",
      skill_version: result.skillVersion,
      model: result.model, provider: result.provider,
      stop_reason: result.validationErrors.length
        ? `${result.stopReason}:language_mismatch_after_retry`
        : result.stopReason,
      completed: Boolean(result.value),
      usage: result.usage,
      evidence_ids: [...new Set(steps.flatMap((step) => step.evidence_refs))],
      state_candidate: Boolean(steps.length),
    },
  };
}

async function evidencePackets(
  evidence: SnapshotEvidence[],
  project: Project,
  snapshot: EvidenceSnapshot,
  store: ProductStore,
): Promise<EvidencePacket[]> {
  const packets: EvidencePacket[] = [];
  for (const row of evidence.slice(0, 10)) {
    const line = row.start_line ?? 1;
    let excerpt: string[] = [];
    try {
      excerpt = (await store.readSourceLines(
        project.project_id,
        snapshot.snapshot_id,
        row.path,
        Math.max(1, line - 2),
        Math.min((row.end_line ?? line) + 4, line + 30),
      )).lines;
    } catch {
      // Graph metadata remains useful when a bounded source excerpt is unavailable.
    }
    packets.push({
      evidence_id: row.stable_id,
      label: row.label,
      path: row.path,
      start_line: row.start_line,
      end_line: row.end_line,
      kind: row.kind,
      excerpt,
    });
  }
  return packets;
}

function currentStep(snapshot: EvidenceSnapshot, study: StudyState): SnapshotLearningStep | null {
  return (study.dynamic_learning_plan?.length ? study.dynamic_learning_plan : snapshot.learning_plan.steps)[study.current_step] ?? null;
}

function studySummary(study: StudyState): Record<string, unknown> {
  return {
    phase: study.phase,
    selected_value_point: study.selected_value_point,
    current_step: study.current_step,
    total_steps: study.total_steps,
    mastered: study.mastered.slice(-8),
    misconceptions: study.misconceptions.slice(-8),
    open_questions: study.open_questions.slice(-8),
    dynamic_learning_plan: study.dynamic_learning_plan?.slice(0, 8) ?? [],
  };
}
