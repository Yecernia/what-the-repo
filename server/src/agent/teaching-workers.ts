import { loadEvidencePackets } from './evidence-packets.js';
import type { TeachingFeedbackScope, TeachingQuestion, TeachingQuestionResult, TeachingTargetAssessmentRecord, TeachingTargetResult } from './teaching-question.js';
import { normalizeQuestionTargets, priorTargetCoverageForAssessment,
  qualifiedQuestionSupportsForAssessment, boundedQuestionSupportContext, targetsForStep, type TargetCoverageResult } from './target-coverage.js';
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
import type { WorkerDiagnostics } from './worker-diagnostics.js';
import { runAssessmentStages, type AssessmentStageTrace } from './assessment-stages.js';
import type { AssessmentReviewContext } from './assessment-review-context.js';

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
  reply_submission_attempt?: number;
  feedback_repair?: boolean;
  diagnostics?: WorkerDiagnostics;
  assessment_stages?: AssessmentStageTrace[];
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
  answerParts?: string[];
  sourceMessageId?: string;
  originalMessage?: string;
  question: TeachingQuestion;
  evidence: SnapshotEvidence[];
  project: Project;
  snapshot: EvidenceSnapshot;
  store: ProductStore;
  modelRuntime: PiModelRuntime;
  signal?: AbortSignal;
  /** The assessment owner may repair prose once; every non-prose field stays fixed. */
  feedbackRepair?: { feedback: string; offendingSpans: string[]; verdict: string;
    answerRelevant: boolean; masteredItems: string[]; misconceptions: string[]; evidenceIds: string[];
    targetResults: TeachingTargetResult[]; feedbackScope: TeachingFeedbackScope; questionResult?: TeachingQuestionResult;
    evidenceIssues?: Array<{ claim: string; reason: string; kind: string }>; validationErrors?: string[] };
}): Promise<{
  completed: boolean;
  answerRelevant?: boolean;
  feedback: string | null;
  verdict: string | null;
  masteredItems: string[];
  misconceptions: string[];
  acceptedEvidenceIds: string[];
  targetResults: TeachingTargetResult[];
  questionResult?: TeachingQuestionResult;
  feedbackScope: TeachingFeedbackScope | null;
  /** Reuses the exact authorized source selection supplied to the assessment. */
  reviewContext: AssessmentReviewContext | null;
  trace: TeachingWorkerTrace;
}> {
  const workerRunId = `worker:assessment:${randomUUID()}`;
  const step = currentStep(input.snapshot, input.project.study);
  let question: TeachingQuestion;
  let priorCoverage: TargetCoverageResult;
  let priorSupports: TeachingTargetAssessmentRecord[];
  const answerParts = input.answerParts ?? [input.answer];
  const originalMessage = input.originalMessage ?? input.answer;
  try {
    const sourceMessage = input.sourceMessageId
      ? input.project.messages.find(message => message.message_id === input.sourceMessageId && message.role === 'user') : null;
    if (!step || input.question.snapshot_id !== input.snapshot.snapshot_id
      || input.question.route_revision !== (input.project.study.route_revision ?? 0)
      || (input.sourceMessageId && input.question.created_message_id === input.sourceMessageId)
      || (input.sourceMessageId && (!sourceMessage || sourceMessage.content !== originalMessage))
      || input.question.evidence.some(bound => !input.evidence.some(row => bound.stable_id === row.stable_id
        && bound.path === row.path && bound.start_line === row.start_line && bound.end_line === row.end_line))
      || !answerParts.length || answerParts.some(part => !part.trim() || !originalMessage.includes(part)))
      throw new Error('assessment_input_scope_mismatch');
    question = normalizeQuestionTargets(input.question, step);
    priorCoverage = priorTargetCoverageForAssessment(input.project, question, step, input.sourceMessageId);
    priorSupports = qualifiedQuestionSupportsForAssessment(input.project, question, step, input.sourceMessageId);
  } catch {
    return { completed: false, answerRelevant: undefined, feedback: null, verdict: null,
      masteredItems: [], misconceptions: [], acceptedEvidenceIds: [], targetResults: [], feedbackScope: null, reviewContext: null,
      trace: { worker_run_id: workerRunId, skill_id: 'understanding-assessment', skill_version: 'input-rejected',
        completed: false, stop_reason: 'assessment_input_scope_mismatch', usage: {
          inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0,
        }, evidence_ids: [], state_candidate: false } };
  }
  // A caller cannot broaden a question's own evidence by passing globally exposed IDs.
  const evidence = input.evidence.filter(row => question.evidence.some(bound => bound.stable_id === row.stable_id
    && bound.path === row.path && bound.start_line === row.start_line && bound.end_line === row.end_line));
  const packetResult = await loadEvidencePackets({ evidence: evidence.map(row => ({ ...row, snapshot_id: input.snapshot.snapshot_id })), projectId: input.project.project_id, snapshotId: input.snapshot.snapshot_id, store: input.store, signal: input.signal });
  const packets = packetResult.packets;
  const allowedIds = new Set(packets.filter(packet => !packet.incomplete).map((packet) => packet.evidence_id));
  const { context: supportContext, presentedSupports, omittedCount: supportOmittedCount } = boundedQuestionSupportContext(priorSupports);
  const sourceContext = structuredClone({
    registered_question: { question_id: question.question_id, created_message_id: question.created_message_id,
      snapshot_id: question.snapshot_id, route_revision: question.route_revision, step_id: question.step_id,
      prompt: question.prompt, targets: targetsForStep(step!).filter(target => question.target_ids!.includes(target.target_id)) },
    source_message_id: input.sourceMessageId ?? 'current_answer', current_answer_parts: answerParts,
    prior_target_coverage: Object.values(priorCoverage.coverage),
    qualified_prior_question_supports: supportContext, omitted_prior_support_count: supportOmittedCount,
  });
  const result = await runAssessmentStages({ question, targets: targetsForStep(step!), prior: priorCoverage,
    answerParts, priorSupports: presentedSupports, allowedIds,
    modelRuntime: input.modelRuntime, signal: input.signal, feedbackRepair: input.feedbackRepair,
    context: {
      current_question: { prompt: question.prompt, question_id: question.question_id,
        targets: targetsForStep(step!).filter(target => question.target_ids!.includes(target.target_id)).map(target => ({ ...target,
          prior_status: priorCoverage.coverage[target.target_id]?.proven ? 'proven' : 'unproven',
          prior_source_message_ids: presentedSupports.filter(record => record.results.some(result => result.target_id === target.target_id && result.outcome === 'proven'))
            .map(record => record.message_id),
          current_result_duty: 'Assess ONLY this current answer contribution. Unchanged historical proof => not_addressed, empty current answer_spans/evidence_ids. The program retains prior proof. Never copy prior answer text into current spans.',
        })) },
      evidence: packets,
      qualified_prior_question_support: supportContext,
      prior_support_omitted_count: supportOmittedCount,
      current_answer_parts: answerParts,
      source_message_id: input.sourceMessageId ?? null,
      step_targets: Object.values(priorCoverage.coverage).filter(target => !question.target_ids!.includes(target.target_id))
        .map(target => ({ target_id: target.target_id, label: target.label, prior_status: target.proven ? 'proven' : 'unproven' })),
    },
  });
  const value = result.value;
  const acceptedEvidenceIds = value
    ? [...new Set(value.evidence_ids.filter((id) => allowedIds.has(id)))]
    : [];
  const verdict = value?.answer_relevant === false ? "unclear" : value?.verdict ?? null;
  const evidenceRequired = verdict !== "unclear";
  const valid = Boolean(
    result.value
    && result.stopReason === 'completed' && !result.validationErrors.length
    && step
    && (!packetResult.incomplete || verdict === "unclear")
    && input.question.step_id === step.step_id
    && input.question.snapshot_id === input.snapshot.snapshot_id
    && input.question.route_revision === (input.project.study.route_revision ?? 0)
    && (!evidenceRequired || acceptedEvidenceIds.length),
  );
  return {
    completed: valid,
    answerRelevant: value?.answer_relevant,
    feedback: value?.feedback ?? null,
    verdict,
    masteredItems: value?.mastered_items ?? [],
    misconceptions: value?.misconceptions ?? [],
    acceptedEvidenceIds,
    targetResults: value?.target_results as TeachingTargetResult[] ?? [],
    questionResult: value?.question_result,
    feedbackScope: value?.feedback_scope ?? null,
    reviewContext: valid && value ? { ...sourceContext, question_result: structuredClone(value.question_result),
      target_results: structuredClone(value.target_results) } : null,
    trace: {
      worker_run_id: workerRunId,
      skill_id: "understanding-assessment",
      skill_version: result.skillVersion,
      model: result.model, provider: result.provider,
      stop_reason: valid ? result.stopReason : result.value || result.stopReason === 'completed_with_validation_errors'
        ? "assessment_validation_failed" : result.stopReason,
      completed: valid,
      usage: result.usage,
      evidence_ids: acceptedEvidenceIds,
      state_candidate: false,
      diagnostics: result.diagnostics,
      assessment_stages: result.stages,
      feedback_repair: Boolean(input.feedbackRepair),
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
    contextBuilderId: "learning-route-context-v10",
    modelRuntime: input.modelRuntime,
    thinkingLevel: "medium",
    signal: input.signal,
    schema: LEARNING_ROUTE_RESULT,
    tools: exploration.tools,
    explorationEndgame: { submitReserve: 2, convergeReserve: 4 },
    systemPrompt: [
      displayLanguageInstruction(displayLanguage),
      "The learner approved building a route for this target through a confirmation card.",
      "Honor recent user requirements and current study progress. These project-specific requirements outrank older inferred preferences. An edited memory summary is the learner's explicit override.",
      "The program binds the current snapshot and target and validates the final component and evidence IDs; the route itself writes no state.",
      "This route has at most six model requests, including submission and correction. Use at most the first four for focused exploration/convergence; the final two permit only submit_result. Read independent necessary ranges together, and follow next_offset only when the requested mechanism crosses the page. Do not mechanically exhaust source/component pages. Submit the learner's full requested route as soon as its evidence is sufficient; preserve the requested scope. If no reliable route can be formed within the evidence budget, submit empty steps rather than inventing bindings or silently narrowing the request.",
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
      diagnostics: result.diagnostics,
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
