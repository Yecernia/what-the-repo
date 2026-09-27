import { loadEvidencePackets } from './evidence-packets.js';
import type { TeachingQuestion } from './teaching-question.js';
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
import type { PiMemoryRecord, PiModelRuntime, PiUsageSummary } from "./types.js";
import { routeConversation } from '../services/learner-context.js';

const ASSESSMENT_RESULT = Type.Object({
  answer_relevant: Type.Boolean(),
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
    learning_targets: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 6 }),
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
    ...step.learning_targets.map((target, index) => ["learning_targets[" + index + "]", target]),
  ].filter(([, value]) => !languageHasNaturalText(value, language))
    .map(([field]) => field);
  return fields.length
    ? "Fields " + fields.join(", ") + " are not written in " + displayLanguageLabel(language)
      + ". Keep code identifiers, but rewrite the learning text in the learner's language."
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

export async function runUnderstandingAssessment(input: {
  answer: string;
  question: TeachingQuestion;
  /** Earlier answers to this registered question only. */
  earlierAnswers?: string[];
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
  const packetResult = await loadEvidencePackets({ evidence: input.evidence.map(row => ({ ...row, snapshot_id: input.snapshot.snapshot_id })), projectId: input.project.project_id, snapshotId: input.snapshot.snapshot_id, store: input.store, signal: input.signal });
  const packets = packetResult.packets;
  const allowedIds = new Set(packets.filter(packet => !packet.incomplete).map((packet) => packet.evidence_id));
  const result = await runStructuredWorker({
    skillId: "understanding-assessment",
    inputSchemaId: "understanding-assessment-input-v2",
    outputSchemaId: "understanding-assessment-output-v2",
    contextBuilderId: "understanding-assessment-context-v5",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: ASSESSMENT_RESULT,
    systemPrompt: [
      "Judge ONLY current_question.prompt and current_question.target_items. Other step goals are not missing answers. A mastered verdict means this question is correct, not that the whole step is complete. Set answer_relevant=false for topic changes or ordinary chat; those are unclear, never new misconception or mastery.",
      "Do not read other repository content or replace the original answer. Evidence IDs must come from the input. Finish by calling submit_result.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      current_question: { prompt: input.question.prompt, target_items: input.question.target_items, question_id: input.question.question_id },
      evidence: packets,
      original_user_answer: input.answer,
      earlier_answers_to_this_question: input.earlierAnswers ?? [],
    }),
  });
  const acceptedEvidenceIds = result.value
    ? [...new Set(result.value.evidence_ids.filter((id) => allowedIds.has(id)))]
    : [];
  const verdict = result.value?.answer_relevant === false ? "unclear" : result.value?.verdict ?? null;
  const evidenceRequired = verdict !== "unclear";
  const valid = Boolean(
    result.value
    && step
    && (!packetResult.incomplete || verdict === "unclear")
    && input.question.step_id === step.step_id
    && input.question.snapshot_id === input.snapshot.snapshot_id
    && input.question.route_revision === (input.project.study.route_revision ?? 0)
    && (!evidenceRequired || acceptedEvidenceIds.length),
  );
  return {
    completed: valid,
    feedback: result.value?.feedback ?? null,
    verdict,
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
  memories?: PiMemoryRecord[];
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
    readStaticFile: path => input.store.readStaticFile(input.project.project_id, input.snapshot.snapshot_id, path),
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
    inputSchemaId: "learning-route-input-v4",
    outputSchemaId: "learning-route-output-v4",
    contextBuilderId: "learning-route-context-v6",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: LEARNING_ROUTE_RESULT,
    tools: exploration.tools,
    systemPrompt: [
      displayLanguageInstruction(displayLanguage),
      "The learner approved building a route for this target through a confirmation card.",
      "Honor recent user requirements and current study progress. These project-specific requirements outrank older inferred preferences. An edited memory summary is the learner's explicit override.",
      "The program binds the current snapshot and target and validates the final component and evidence IDs; the route itself writes no state.",
    ].join("\n"),
    userPrompt: JSON.stringify({
      repository: input.project.source.display_name,
      repository_summary: input.snapshot.summary,
      architecture_layers: input.snapshot.graph.layers.map((layer) => ({
        layer_id: layer.id,
        name: layer.name,
        responsibility: layer.responsibility,
        component_count: layer.component_ids.length,
      })),
      display_language: displayLanguage,
      display_language_label: displayLanguageLabel(displayLanguage),
      original_learning_request: input.request,
      confirmed_target: input.target,
      target_value_point: valuePoint,
      learner: input.profile.enabled ? { ...input.profile, memory_fact_versions: undefined } : null,
      memories: input.profile.enabled ? (input.memories ?? []).map(({ key, value }) => ({ key, value })) : [],
      recent_conversation: routeConversation(input.project),
      current_study: studySummary(input.project.study),
    }),
    validateSubmitted: (value) => [...new Set(value.steps.flatMap((step, index) => {
      const errors: string[] = [];
      const languageError = learningRouteLanguageError(step, displayLanguage);
      if (languageError) errors.push(languageError);
      for (const id of step.component_ids) if (!componentIds.has(id)) errors.push('Step ' + (index + 1) + ': unknown component ' + id + '. Correct the binding and resubmit the complete route.');
      for (const id of step.evidence_ids) if (!exploration.state.exposedEvidence.has(id)) errors.push('Step ' + (index + 1) + ': evidence ' + id + ' has not been read. Retrieve valid evidence and resubmit the complete route.');
      return errors;
    }))],
  });
  const routeValid = Boolean(result.value && result.stopReason === "completed" && result.validationErrors.length === 0);
  const steps: SnapshotLearningStep[] = (routeValid ? result.value?.steps : undefined)?.map((step, index) => ({
    step_id: 'learning:' + randomUUID().replaceAll('-', '').slice(0, 20),
    order: index + 1,
    title: step.title,
    objective: step.objective,
    evidence_refs: [...new Set(step.evidence_ids)],
    component_ids: [...new Set(step.component_ids)],
    completion_check: step.completion_check,
    learning_targets: [...new Set(step.learning_targets)],
  })) ?? [];

  return {
    // An explicit learning request can legitimately produce no route when the
    // snapshot does not contain enough evidence. Keep that as a completed,
    // honest result so the caller can explain the gap without mutating study.
    completed: routeValid,
    steps,
    trace: {
      worker_run_id: workerRunId,
      skill_id: "learning-route",
      skill_version: result.skillVersion,
      model: result.model, provider: result.provider,
      stop_reason: result.validationErrors.length
        ? `${result.stopReason}:route_validation_failed_after_retry`
        : result.stopReason,
      completed: routeValid,
      usage: result.usage,
      evidence_ids: [...new Set(steps.flatMap((step) => step.evidence_refs))],
      state_candidate: Boolean(steps.length),
    },
  };
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
