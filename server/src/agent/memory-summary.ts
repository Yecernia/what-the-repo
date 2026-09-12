import type { LearnerProfile } from "../domain/conversation.js";
import type { PiMemoryRecord } from "./types.js";

const SUMMARY_MAX_LENGTH = 4_000;
const SENSITIVE_SUMMARY_PATTERN = /(?:bearer\s+|api[_ -]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|token\s*[:=]|sk-[a-z0-9_-]{8,})[^\s,;，。；]{4,}/iu;
const SENSITIVE_SUMMARY_GLOBAL_PATTERN = new RegExp(SENSITIVE_SUMMARY_PATTERN.source, "giu");

function clean(value: string, max: number): string {
  return value.replace(SENSITIVE_SUMMARY_GLOBAL_PATTERN, "[已隐藏]").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep manually edited summaries useful while preventing obvious credential
 * fragments from being persisted or rendered back to the user. */
export function sanitizeMemorySummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(SENSITIVE_SUMMARY_GLOBAL_PATTERN, "[已隐藏]").trim().slice(0, SUMMARY_MAX_LENGTH);
}

/**
 * Build a readable projection from approved profile facts and memories.
 * It is deliberately deterministic: the summary never becomes a second,
 * unverified source of learner data.
 */
export function generateMemorySummary(
  profile: LearnerProfile,
  memories: readonly PiMemoryRecord[] = [],
): string {
  const paragraphs: string[] = [];
  const explicit: string[] = [];
  if (profile.languages.length) explicit.push("熟悉 " + profile.languages.slice(0, 8).join("、"));
  if (profile.experience_level) explicit.push("经验水平为“" + clean(profile.experience_level, 80) + "”");
  if (profile.explanation_preference) explicit.push("偏好" + clean(profile.explanation_preference, 120));
  if (explicit.length) paragraphs.push("你的学习画像显示，你" + explicit.join("，") + "。");
  if (profile.goals.length) {
    paragraphs.push("当前学习目标主要是：" + profile.goals.slice(0, 8).map((item) => clean(item, 120)).join("；") + "。");
  }
  const claims = profile.inferred
    .slice(-8)
    .filter((item) => item.confidence >= 0.65)
    .map((item) => clean(item.claim, 220));
  if (claims.length) paragraphs.push("从近期对话中，系统观察到：" + claims.join("；") + "。");
  const memoryRows = memories
    .filter((item) => item.scope === "user" && item.confidence >= 0.65)
    .slice(-8)
    .filter((item) => !SENSITIVE_SUMMARY_PATTERN.test(item.key + "=" + item.value))
    .map((item) => clean(item.key, 80) + "：" + clean(item.value, 180));
  if (memoryRows.length) paragraphs.push("可用于后续回答的长期偏好：" + memoryRows.join("；") + "。");
  return paragraphs.length
    ? sanitizeMemorySummary(paragraphs.join("\n\n")).slice(0, SUMMARY_MAX_LENGTH - 200)
    : "还没有形成稳定的记忆摘要。随着你继续交流，这里会逐步整理你的学习目标、技术背景和讲解偏好。";
}
