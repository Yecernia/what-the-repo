import { randomUUID } from "node:crypto";
import type {
  LearningActionCard,
  LearningActionKind,
  LearningActionProgress,
  LearningActionTarget,
  LearningTargetKind,
  Project,
} from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotLearningStep } from "../domain/snapshot.js";

const ROUTE_TARGET_KINDS = new Set<LearningTargetKind>([
  "repository",
  "value_point",
  "component",
  "layer",
]);

export interface LearningActionProposalInput {
  action: LearningActionKind;
  targetKind?: LearningTargetKind;
  targetId?: string;
  request: string;
  skipUnderstandingCheck?: boolean;
  executionPolicy?: "confirm" | "after_turn";
  progress?: LearningActionProgress | null;
}

export function createLearningActionProposal(
  project: Project,
  snapshot: EvidenceSnapshot,
  input: LearningActionProposalInput,
): LearningActionCard {
  if (project.analysis.snapshot_id !== snapshot.snapshot_id) {
    throw new Error("learning_action_snapshot_mismatch");
  }
  const target = resolveTarget(project, snapshot, input.action, input.targetKind, input.targetId);
  const copy = proposalCopy(input.action, target, project, Boolean(input.skipUnderstandingCheck));
  const executionPolicy = input.executionPolicy ?? "confirm";
  return {
    action_id: `learning-action:${randomUUID().replaceAll("-", "")}`,
    action: input.action,
    execution_policy: executionPolicy,
    target,
    title: copy.title,
    description: executionPolicy === "after_turn"
      ? "本轮成功完成后会记录为主动跳过，不计入已掌握；之后仍可回看本步。"
      : copy.description,
    request: input.request.trim().slice(0, 2_000),
    snapshot_id: snapshot.snapshot_id,
    route_revision: project.study.route_revision ?? 0,
    expected_step_id: currentLearningStep(project)?.step_id ?? null,
    status: "pending",
    skip_understanding_check: Boolean(input.skipUnderstandingCheck),
    progress: input.progress ? {
      mastered_items: unique(input.progress.mastered_items, 12),
      evidence_ids: unique(input.progress.evidence_ids, 20),
    } : null,
    created_at: new Date().toISOString(),
    resolved_at: null,
    executed_at: null,
    error: null,
  };
}

export function currentLearningStep(project: Project): SnapshotLearningStep | null {
  return project.study.dynamic_learning_plan?.[project.study.current_step] ?? null;
}

export function assertLearningActionStillCurrent(
  project: Project,
  snapshot: EvidenceSnapshot,
  action: LearningActionCard,
): void {
  if (action.snapshot_id !== snapshot.snapshot_id || project.analysis.snapshot_id !== action.snapshot_id) {
    throw new Error("learning_action_snapshot_mismatch");
  }
  assertActionState(project, action);
  resolveTarget(
    project,
    snapshot,
    action.action,
    action.target?.kind,
    action.target?.stable_id ?? undefined,
  );
}

export function applyCompletedLearningRoute(
  project: Project,
  action: LearningActionCard,
  steps: SnapshotLearningStep[],
): void {
  assertActionState(project, action);
  project.study.selected_value_point = action.target?.kind === "value_point"
    ? action.target.stable_id
    : null;
  project.study.dynamic_learning_plan = structuredClone(steps);
  project.study.snapshot_id = project.analysis.snapshot_id;
  project.study.migration = null;
  project.study.phase = "explaining";
  project.study.current_step = 0;
  project.study.total_steps = steps.length;
  project.study.mastered = [];
  project.study.skipped_steps = [];
  project.study.step_passed = null;
  project.study.misconceptions = [];
  project.study.open_questions = [];
  project.study.used_evidence = [];
  resetCurrentCheck(project);
}

export function applyConfirmedLearningAction(project: Project, action: LearningActionCard): void {
  assertActionState(project, action);
  if (action.action === "stop_guided_learning") {
    project.study.phase = "orienting";
    project.study.selected_value_point = null;
    project.study.current_step = 0;
    project.study.total_steps = 0;
    project.study.mastered = [];
    project.study.skipped_steps = [];
    project.study.misconceptions = [];
    project.study.open_questions = [];
    project.study.used_evidence = [];
    project.study.dynamic_learning_plan = [];
    project.study.migration = null;
    resetCurrentCheck(project);
    return;
  }
  if (action.action !== "advance_learning_step") {
    throw new Error("learning_route_required");
  }
  const step = currentLearningStep(project);
  if (!step || action.target?.kind !== "learning_step" || action.target.stable_id !== step.step_id) {
    throw new Error("learning_action_no_longer_current");
  }
  if (action.skip_understanding_check) {
    project.study.skipped_steps = unique([
      ...(project.study.skipped_steps ?? []),
      step.step_id,
    ], 100);
  } else {
    const passed = project.study.step_passed;
    const latest = project.study.latest_assessment;
    if (!passed || passed.step_id !== step.step_id
      || passed.snapshot_id !== project.analysis.snapshot_id
      || passed.route_revision !== (project.study.route_revision ?? 0)
      || (latest?.step_id === step.step_id && (!latest.step_completed
        || latest.verdict !== "mastered" || latest.sequence !== passed.assessment_sequence))) {
      throw new Error("learning_step_not_passed");
    }
    project.study.mastered = unique([
      ...project.study.mastered,
      ...(passed.mastered_items.length ? passed.mastered_items : [step.title]),
    ], 100);
  }
  project.study.used_evidence = unique([
    ...project.study.used_evidence,
    ...(action.skip_understanding_check ? [] : project.study.step_passed?.evidence_ids ?? []),
  ], 100);
  project.study.current_step = Math.min(project.study.current_step + 1, project.study.total_steps);
  project.study.phase = project.study.total_steps > 0 && project.study.current_step >= project.study.total_steps
    ? "completed"
    : "explaining";
  resetCurrentCheck(project);
}

function assertActionState(project: Project, action: LearningActionCard): void {
  if (action.snapshot_id !== project.analysis.snapshot_id
    || action.route_revision !== (project.study.route_revision ?? 0)
    || action.expected_step_id !== (currentLearningStep(project)?.step_id ?? null)) {
    throw new Error("learning_action_no_longer_current");
  }
}

function resetCurrentCheck(project: Project): void {
  project.study.route_revision = (project.study.route_revision ?? 0) + 1;
  project.study.step_passed = null;
  project.study.teaching_question = null;
  project.study.latest_assessment = null;
  project.study.mastered_target_items = [];
  project.study.mastered_target_evidence = {};
}

export function isRouteAction(action: LearningActionCard): boolean {
  return action.action === "start_learning_route" || action.action === "switch_learning_target";
}

/** Render the receipt from committed state, never from the model's forecast. */
export function completeLearningAction(project: Project, action: LearningActionCard): void {
  const timestamp = new Date().toISOString();
  action.status = "executed";
  action.resolved_at ??= timestamp;
  action.executed_at = timestamp;
  action.run_expires_at = null;
  action.error = null;
  const next = currentLearningStep(project);
  action.outcome = { route_revision: project.study.route_revision ?? 0,
    next_step_id: next?.step_id ?? null, next_step_title: next?.title ?? null };
  const label = action.target?.label ?? "当前步骤";
  if (action.action === "advance_learning_step") {
    action.title = action.skip_understanding_check ? `已跳过“${label}”` : `已完成“${label}”`;
    action.description = (action.skip_understanding_check
      ? "已记录为主动跳过，不计入已掌握；之后仍可回看本步。"
      : "本步进度已记录。") + (next ? `当前步骤是“${next.title}”，可以开始学习。` : "本条学习路线已结束。");
  } else if (isRouteAction(action)) {
    action.description = next ? `学习路线已生成，当前步骤是“${next.title}”。` : "学习路线已生成。";
  } else action.description = "已退出当前学习路线，可以继续自由提问。";
  const message = project.messages.find(message => message.learning_action?.action_id === action.action_id);
  if (message) {
    message.content = action.description;
    message.teaching_question = null;
    message.teaching_context = next ? { snapshot_id: action.snapshot_id,
      route_revision: project.study.route_revision ?? 0, step_id: next.step_id } : undefined;
  }
}

function resolveTarget(
  project: Project,
  snapshot: EvidenceSnapshot,
  action: LearningActionKind,
  targetKind?: LearningTargetKind,
  targetId?: string,
): LearningActionTarget | null {
  if (action === "stop_guided_learning") return null;
  if (action === "advance_learning_step") {
    const step = currentLearningStep(project);
    if (!step || project.study.phase === "completed") throw new Error("learning_step_unavailable");
    if (targetKind && targetKind !== "learning_step") throw new Error("learning_target_kind_invalid");
    if (targetId && targetId !== step.step_id) throw new Error("learning_target_not_current");
    return { kind: "learning_step", stable_id: step.step_id, label: step.title };
  }
  if (!targetKind || !ROUTE_TARGET_KINDS.has(targetKind)) throw new Error("learning_route_target_required");
  if (targetKind === "repository") {
    if (targetId) throw new Error("repository_target_has_id");
    return { kind: "repository", stable_id: null, label: project.source.display_name };
  }
  if (!targetId) throw new Error("learning_target_id_required");
  if (targetKind === "value_point") {
    const valuePoint = snapshot.value_points.find((item) => item.stable_id === targetId);
    if (!valuePoint) throw new Error("learning_value_point_not_found");
    return { kind: targetKind, stable_id: valuePoint.stable_id, label: valuePoint.title };
  }
  if (targetKind === "component") {
    const component = snapshot.graph.nodes.find((item) => item.id === targetId);
    if (!component) throw new Error("learning_component_not_found");
    return { kind: targetKind, stable_id: component.id, label: component.name };
  }
  const layer = snapshot.graph.layers.find((item) => item.id === targetId);
  if (!layer) throw new Error("learning_layer_not_found");
  return { kind: targetKind, stable_id: layer.id, label: layer.name };
}

function proposalCopy(
  action: LearningActionKind,
  target: LearningActionTarget | null,
  project: Project,
  skipUnderstandingCheck: boolean,
): { title: string; description: string } {
  if (action === "start_learning_route") {
    return {
      title: `为“${target?.label ?? project.source.display_name}”制定学习路线`,
      description: "确认后才会生成学习步骤并开始引导学习。",
    };
  }
  if (action === "switch_learning_target") {
    return {
      title: `切换学习目标到“${target?.label ?? project.source.display_name}”`,
      description: "确认后会替换当前路线；已有路线不会在确认前改变。",
    };
  }
  if (action === "advance_learning_step") {
    if (skipUnderstandingCheck) {
      return {
        title: `跳过“${target?.label ?? "当前步骤"}”的理解检查并继续`,
        description: "你明确选择跳过本步理解检查。确认后会记录为主动跳过并进入下一步；之后仍可回看本步。",
      };
    }
    return {
      title: `完成“${target?.label ?? "当前步骤"}”并继续`,
      description: "确认后才会记录本步进度并进入下一步。",
    };
  }
  return {
    title: "停止引导式学习",
    description: "确认后会退出当前路线；之后仍可自由提问或重新开始学习。",
  };
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(-limit);
}
