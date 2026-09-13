import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  EvaluationRequirement,
  EvolutionTask,
  OperationLedger,
} from "./contracts.js";
import { sha256, stableJson } from "./integrity.js";
import { EvolutionStateStore } from "./state-store.js";
import { SkillVersionRegistry } from "./versions.js";

export interface FeedbackEvolutionRequest {
  request_id: string;
  dedupe_key: string;
  trigger: "human_feedback";
  skill_ids: string[];
  reasons: string[];
  strengths: string[];
  source_trace_ids?: string[];
  source_message_ids?: string[];
  sample_count: number;
  status: "pending" | "task_created" | "dismissed";
  task_ids?: string[];
  task_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackEvolutionPolicy {
  whitelist: string[];
  checkIds: string[];
  checkDefinitionDigests: Record<string, string>;
  evaluation: EvaluationRequirement;
  maxSteps?: number;
  maxTimeMs?: number;
  maxTokens?: number;
  maxCostUsd?: number | null;
  maxCandidateBytes?: number;
}

export interface FeedbackQueuePromotionOptions {
  queueRoot: string;
  requestStore?: FeedbackEvolutionRequestStore;
  state: EvolutionStateStore;
  versions: SkillVersionRegistry;
  policies: Record<string, FeedbackEvolutionPolicy>;
  skillsRoot?: string;
  limit?: number;
}

export interface FeedbackEvolutionRequestStore {
  list(requestIds: string[] | undefined, limit: number): Promise<FeedbackEvolutionRequest[]>;
  save(request: FeedbackEvolutionRequest): Promise<void>;
}

export interface FeedbackQueuePromotionResult {
  requestId: string;
  taskIds: string[];
  skippedSkillIds: string[];
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,191}$/;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,190}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function safeTaskId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const result = normalized.slice(0, 120) || `feedback-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  if (!TASK_ID.test(result)) throw new Error("feedback request produced an invalid EvolutionTask ID");
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

function boundedStrings(value: unknown, label: string, max: number, maxLength = 240): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid ${label}`);
  }
  const result = value.map((item) => String(item).trim()).filter(Boolean).slice(0, max);
  if (result.some((item) => item.length > maxLength || /[\u0000-\u001f\u007f]/.test(item))) {
    throw new Error(`invalid ${label}`);
  }
  return result;
}

export function validateFeedbackEvolutionRequest(value: unknown): FeedbackEvolutionRequest {
  const row = object(value, "feedback request");
  const status = row.status;
  if (status !== "pending" && status !== "task_created" && status !== "dismissed") {
    throw new Error("invalid feedback request status");
  }
  if (row.trigger !== "human_feedback") throw new Error("invalid feedback request trigger");
  const requestId = text(row.request_id, "feedback request ID");
  const dedupeKey = text(row.dedupe_key, "feedback dedupe key");
  if (!REQUEST_ID.test(requestId) || !SHA256.test(dedupeKey)) throw new Error("invalid feedback request identity");
  const skillIds = boundedStrings(row.skill_ids, "feedback skill IDs", 12, 191);
  if (skillIds.length === 0 || skillIds.some((skillId) => !SKILL_ID.test(skillId))) {
    throw new Error("invalid feedback skill IDs");
  }
  const sampleCount = row.sample_count;
  if (!Number.isSafeInteger(sampleCount) || Number(sampleCount) < 1) throw new Error("invalid feedback sample count");
  const createdAt = text(row.created_at, "feedback created_at");
  const updatedAt = text(row.updated_at, "feedback updated_at");
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error("invalid feedback request timestamp");
  }
  return {
    request_id: requestId,
    dedupe_key: dedupeKey,
    trigger: "human_feedback",
    skill_ids: skillIds,
    reasons: boundedStrings(row.reasons, "feedback reasons", 20),
    strengths: boundedStrings(row.strengths, "feedback strengths", 20),
    source_trace_ids: boundedStrings(row.source_trace_ids ?? [], "feedback trace IDs", 100, 191),
    source_message_ids: boundedStrings(row.source_message_ids ?? [], "feedback message IDs", 100, 191),
    sample_count: Number(sampleCount),
    status,
    task_ids: boundedStrings(row.task_ids ?? [], "feedback task IDs", 12, 128),
    task_id: typeof row.task_id === "string" ? row.task_id : null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

async function writeRequestFile(root: string, request: FeedbackEvolutionRequest): Promise<void> {
  const directory = resolve(root);
  if (!isAbsolute(directory)) throw new Error("feedback queue root must be absolute");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${request.request_id}.json`);
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function taskFor(
  request: FeedbackEvolutionRequest,
  skillId: string,
  policy: FeedbackEvolutionPolicy,
  binding: Awaited<ReturnType<SkillVersionRegistry["exportCurrent"]>>,
): EvolutionTask {
  const taskId = safeTaskId(`feedback-${request.request_id}-${skillId}`);
  const failureEvidence = [
    ...request.reasons.map((reason) => `用户反馈问题：${reason}`),
    ...request.strengths.map((strength) => `用户反馈优点：${strength}`),
    `已聚合样本数：${request.sample_count}`,
  ].slice(0, 32);
  return {
    taskId,
    trigger: "human_feedback",
    failureEvidence,
    skillId,
    baseSkillVersion: binding.version,
    baseRevision: binding.revision,
    baseSnapshotDigest: binding.snapshotDigest,
    whitelist: [...policy.whitelist],
    checkIds: [...policy.checkIds],
    checkDefinitionDigests: { ...policy.checkDefinitionDigests },
    evaluation: structuredClone(policy.evaluation),
    maxSteps: policy.maxSteps ?? 40,
    maxTimeMs: policy.maxTimeMs ?? 15 * 60_000,
    maxTokens: policy.maxTokens ?? 120_000,
    maxCostUsd: policy.maxCostUsd === undefined ? 10 : policy.maxCostUsd,
    maxCandidateBytes: policy.maxCandidateBytes ?? 512 * 1024,
  };
}

function initialLedger(task: EvolutionTask): OperationLedger {
  const now = new Date().toISOString();
  return {
    taskId: task.taskId,
    taskDigest: sha256(stableJson(task)),
    status: "created",
    createdAt: now,
    updatedAt: now,
    steps: ["created_from_human_feedback"],
    allowedTools: ["read_candidate", "write_candidate", "edit_candidate", "run_check", "submit_candidate"],
    operations: [],
    checkResults: [],
    sideEffects: [],
    compactionContext: "",
  };
}

async function currentBinding(
  options: FeedbackQueuePromotionOptions,
  skillId: string,
): Promise<Awaited<ReturnType<SkillVersionRegistry["exportCurrent"]>> | undefined> {
  const current = await options.versions.current(skillId);
  if (current) return options.versions.exportCurrent(skillId);
  if (!options.skillsRoot) return undefined;
  const skillsRoot = await realpath(resolve(options.skillsRoot));
  const skillRoot = await realpath(join(skillsRoot, skillId));
  const child = relative(skillsRoot, skillRoot);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error("bundled Skill escapes the reviewed skills root");
  const content = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const contentDigest = sha256(content);
  const artifact = {
    path: "SKILL.md",
    content,
    sha256: contentDigest,
    bytes: Buffer.byteLength(content, "utf8"),
  };
  await options.versions.bootstrap(
    skillId,
    `bundled.${contentDigest.slice(0, 12)}`,
    `bootstrap-${contentDigest.slice(0, 20)}`,
    [artifact],
  );
  return options.versions.exportCurrent(skillId);
}

/** Convert bounded product feedback requests into one reviewed EvolutionTask per Skill. */
export async function promoteFeedbackRequests(
  options: FeedbackQueuePromotionOptions,
  requestIds?: string[],
): Promise<FeedbackQueuePromotionResult[]> {
  const limit = options.limit ?? 20;
  const requested = requestIds?.map((requestId) => {
    if (!REQUEST_ID.test(requestId)) throw new Error("invalid feedback request ID");
    return requestId;
  });
  const requestedSet = new Set(requested ?? []);
  const queueRoot = resolve(options.queueRoot);
  const requests = options.requestStore
    ? await options.requestStore.list(requested, limit)
    : await readRequestFiles(queueRoot, requested, limit);
  const results: FeedbackQueuePromotionResult[] = [];
  for (const request of requests) {
    if (request.status === "dismissed") continue;
    if (request.status === "task_created") {
      if (requestedSet.has(request.request_id)) {
        results.push({
          requestId: request.request_id,
          taskIds: request.task_ids ?? [],
          skippedSkillIds: [],
        });
      }
      continue;
    }
    const taskIds = [...(request.task_ids ?? [])];
    const skippedSkillIds: string[] = [];
    for (const skillId of request.skill_ids) {
      const policy = options.policies[skillId];
      const binding = policy ? await currentBinding(options, skillId) : undefined;
      if (!policy || !binding) {
        skippedSkillIds.push(skillId);
        continue;
      }
      const allowedPaths = new Set(binding.artifacts.map((artifact) => artifact.path));
      if (policy.whitelist.some((path) => !allowedPaths.has(path))) {
        throw new Error("feedback evolution policy exceeds the published Skill snapshot");
      }
      const task = taskFor(request, skillId, policy, binding);
      if (taskIds.includes(task.taskId)) continue;
      if (await options.state.hasTask(task.taskId)) {
        const stored = await options.state.loadTask(task.taskId);
        if (stableJson(stored) !== stableJson(task)) {
          throw new Error("existing feedback EvolutionTask does not match the queued request");
        }
      } else {
        await options.state.create(task, initialLedger(task));
      }
      taskIds.push(task.taskId);
    }
    if (taskIds.length === 0) continue;
    request.status = "task_created";
    request.task_ids = taskIds.slice(0, 12);
    request.task_id = request.task_ids[0] ?? null;
    request.updated_at = new Date().toISOString();
    if (options.requestStore) await options.requestStore.save(request);
    else await writeRequestFile(queueRoot, request);
    results.push({ requestId: request.request_id, taskIds: request.task_ids, skippedSkillIds });
  }
  return results;
}

async function readRequestFiles(
  queueRoot: string,
  requestIds: string[] | undefined,
  limit: number,
): Promise<FeedbackEvolutionRequest[]> {
  const names = requestIds
    ? requestIds.map((requestId) => `${requestId}.json`)
    : (await readdir(queueRoot).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".json"))
      .sort();
  const requests: FeedbackEvolutionRequest[] = [];
  for (const name of names.slice(0, limit)) {
    try {
      requests.push(validateFeedbackEvolutionRequest(
        JSON.parse(await readFile(join(queueRoot, name), "utf8")) as unknown,
      ));
    } catch (error) {
      if (requestIds && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return requests;
}
