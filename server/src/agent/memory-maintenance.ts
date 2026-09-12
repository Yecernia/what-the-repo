import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Project } from "../domain/conversation.js";
import { nowIso, profileClaimId } from "../domain/conversation.js";
import type { ProductStore } from "../persistence/store.js";
import { KeyedMutex } from "./mutex.js";
import type { PiMemoryRepository } from "./memory-store.js";
import { runStructuredWorker } from "./structured-worker.js";
import type { PiModelRuntime } from "./types.js";
import { generateMemorySummary } from "./memory-summary.js";

const MEMORY_RESULT = Type.Object({
  memories: Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 120 }),
    value: Type.String({ minLength: 1, maxLength: 500 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    source_message_id: Type.String({ maxLength: 128 }),
    evidence: Type.String({ minLength: 1, maxLength: 300 }),
  }), { maxItems: 8 }),
  profile_claims: Type.Array(Type.Object({
    claim: Type.String({ minLength: 1, maxLength: 500 }),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    source_message_id: Type.String({ maxLength: 128 }),
    evidence: Type.String({ minLength: 1, maxLength: 300 }),
  }), { maxItems: 8 }),
});

export type MemoryWorkerOutput = Static<typeof MEMORY_RESULT>;

function memoryId(ownerId: string, key: string): string {
  return "memory:" + createHash("sha256")
    .update(ownerId + ":" + key)
    .digest("hex")
    .slice(0, 24);
}

function eligibleMessages(project: Project) {
  return project.messages.filter((message) =>
    message.context_eligible
    && !message.error
    && (message.role === "user" || message.role === "assistant"));
}

function newUserMessageCount(project: Project, lastMessageId: string | null): number {
  const messages = eligibleMessages(project);
  const start = lastMessageId
    ? Math.max(0, messages.findIndex((message) => message.message_id === lastMessageId) + 1)
    : 0;
  return messages.slice(start).filter((message) => message.role === "user").length;
}

export async function applyMemoryOutput(input: {
  ownerId: string;
  project: Project;
  output: MemoryWorkerOutput;
  store: ProductStore;
  memories: PiMemoryRepository;
}): Promise<{ memories: number; profileClaims: number }> {
  const messages = new Map(
    input.project.messages
      .filter((message) => message.role === "user")
      .map((message) => [message.message_id, message]),
  );
  let savedMemories = 0;
  for (const row of input.output.memories) {
    const source = messages.get(row.source_message_id);
    if (
      !source
      || row.confidence < 0.65
      || !source.content.includes(row.evidence)
      || /api[_ -]?key|secret|token|password|密码|密钥/i.test(row.key + " " + row.value)
    ) continue;
    const timestamp = nowIso();
    await input.memories.upsert({
      memoryId: memoryId(input.ownerId, row.key),
      ownerId: input.ownerId,
      scope: "user",
      key: row.key,
      value: row.value,
      sourceMessageIds: [source.message_id],
      confidence: row.confidence,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    savedMemories += 1;
  }

  const profile = await input.store.loadProfile(input.ownerId);
  let savedClaims = 0;
  for (const row of input.output.profile_claims) {
    const source = messages.get(row.source_message_id);
    if (!source || row.confidence < 0.65 || !source.content.includes(row.evidence)) continue;
    const claimId = profileClaimId(row.claim, row.evidence, input.project.project_id);
    const claim = {
      claim_id: claimId,
      claim: row.claim,
      confidence: row.confidence,
      evidence: row.evidence,
      observed_at: nowIso(),
      source_project_id: input.project.project_id,
    };
    const index = profile.inferred.findIndex((item) => item.claim_id === claimId);
    if (index >= 0) profile.inferred[index] = claim;
    else profile.inferred.push(claim);
    savedClaims += 1;
  }
  const lastUser = [...input.project.messages].reverse()
    .find((message) => message.role === "user");
  profile.inferred = profile.inferred.slice(-50);
  profile.last_inferred_message_id = lastUser?.message_id ?? profile.last_inferred_message_id;
  const summary = profile.memory_summary_mode === "edited"
    ? profile.memory_summary
    : generateMemorySummary(profile, await input.memories.list(input.ownerId));
  const summaryChanged = profile.memory_summary !== summary
    || (profile.memory_summary_mode !== "edited" && !profile.memory_summary_updated_at);
  profile.memory_summary = summary;
  if (profile.memory_summary_mode !== "edited") profile.memory_summary_updated_at = summaryChanged ? nowIso() : profile.memory_summary_updated_at;
  profile.updated_at = nowIso();
  await input.store.saveProfile(input.ownerId, profile);
  return { memories: savedMemories, profileClaims: savedClaims };
}

export class MemoryMaintenance {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly store: ProductStore,
    private readonly memories: PiMemoryRepository,
  ) {}

  schedule(input: {
    ownerId: string;
    projectId: string;
    modelRuntime: PiModelRuntime;
  }): void {
    void this.mutex.runExclusive(input.ownerId, async () => {
      const project = await this.store.loadProject(input.projectId, input.ownerId);
      if (!project) return;
      const profile = await this.store.loadProfile(input.ownerId);
      if (!profile.enabled || newUserMessageCount(project, profile.last_inferred_message_id) < 3) {
        return;
      }
      const currentMemories = await this.memories.list(input.ownerId);
      const recent = eligibleMessages(project).slice(-10).map((message) => ({
        message_id: message.message_id,
        role: message.role,
        content: message.content.slice(0, 4_000),
      }));
      const result = await runStructuredWorker({
        skillId: "memory-maintenance",
        inputSchemaId: "memory-maintenance-input-v1",
        outputSchemaId: "memory-maintenance-output-v1",
        contextBuilderId: "memory-maintenance-context-v2",
        modelRuntime: input.modelRuntime,
        thinkingLevel: "low",
        schema: MEMORY_RESULT,
        systemPrompt: [
          "程序已经提供有界近期对话、当前画像和长期记忆；当前 Skill 负责提取与冲突处理方法。",
          "每条候选必须绑定输入 user message ID 和逐字证据；程序会再次校验敏感内容、来源和权限。必须调用 submit_result。",
        ].join("\n"),
        userPrompt: JSON.stringify({
          existing_profile: profile,
          existing_memories: currentMemories.slice(-20).map((row) => ({
            key: row.key,
            value: row.value,
            confidence: row.confidence,
          })),
          recent_messages: recent,
        }),
      });
      if (!result.value) {
        await this.store.saveTrace("memory-" + input.projectId + "-" + Date.now(), {
          trace_id: "memory-" + input.projectId + "-" + Date.now(),
          project_id: input.projectId,
          owner_id: input.ownerId,
          worker: "memory-profile-maintenance",
          model: result.model, provider: result.provider,
          stop_reason: result.stopReason,
          updated: false,
        });
        return;
      }
      const applied = await applyMemoryOutput({
        ownerId: input.ownerId,
        project,
        output: result.value,
        store: this.store,
        memories: this.memories,
      });
      await this.store.saveTrace("memory-" + input.projectId + "-" + Date.now(), {
        trace_id: "memory-" + input.projectId + "-" + Date.now(),
        project_id: input.projectId,
        owner_id: input.ownerId,
        worker: "memory-profile-maintenance",
        model: result.model, provider: result.provider,
        stop_reason: result.stopReason,
        updated: applied.memories + applied.profileClaims > 0,
        memories_updated: applied.memories,
        profile_claims_updated: applied.profileClaims,
        usage: result.usage,
      });
    }).catch(() => undefined);
  }
}
