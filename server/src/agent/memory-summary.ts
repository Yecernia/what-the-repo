import type { LearnerProfile } from "../domain/conversation.js";
import type { PiMemoryRecord } from "./types.js";

const SUMMARY_MAX_LENGTH = 4_000;
const SENSITIVE_SUMMARY_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})|(?:bearer\s+|api[_ -]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|token\s*[:=]|密码\s*[:：=]|密钥\s*[:：=])[^\s,;，。；]+/iu;
const SENSITIVE_SUMMARY_GLOBAL_PATTERN = new RegExp(SENSITIVE_SUMMARY_PATTERN.source, "giu");

/** Apply to evidence as well as values: hiding a summary does not protect raw facts. */
export function containsSensitiveMemory(...values: string[]): boolean {
  return values.some(value => /api[_ -]?key|secret|password|密码|密钥|\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})|-----BEGIN .*PRIVATE KEY|\bbearer\s+\S+|\btoken\s*[:=]/iu.test(value));
}

function clean(value: string, max: number): string {
  return value.replace(SENSITIVE_SUMMARY_GLOBAL_PATTERN, "[已隐藏]").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Keep manually edited summaries useful while preventing obvious credential
 * fragments from being persisted or rendered back to the user. */
export function sanitizeMemorySummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(SENSITIVE_SUMMARY_GLOBAL_PATTERN, "[已隐藏]").trim().slice(0, SUMMARY_MAX_LENGTH);
}

// Memory keys are chosen by the agent (for example `experience_level` or `preferred-style`), so they are only used
// to place a memory under a heading; the reader sees the remembered value, never the key.
const MEMORY_SECTIONS: Array<{ title: string; pattern: RegExp }> = [
  { title: "技术背景", pattern: /experience|level|background|language|skill|stack|familiar|经验|背景|语言|技能/iu },
  { title: "学习目标", pattern: /goal|target|objective|interest|目标|兴趣/iu },
  { title: "讲解偏好", pattern: /prefer|style|explain|format|tone|pace|depth|偏好|风格|讲解|方式/iu },
];
const OTHER_SECTION = "其他记住的事";

/** A single line of plain text that cannot turn into Markdown structure or leak a trailing full stop. */
function item(value: string, max: number): string {
  return clean(value, max)
    .replace(/[。；;，,、\s]+$/u, "")
    .replace(/[\\`*_[\]#<>|]/gu, (char) => "\\" + char);
}

/**
 * Build a readable Markdown projection from approved profile facts and memories, grouped under short headings the
 * learner can scan. It is deliberately deterministic: the summary never becomes a second, unverified source of
 * learner data.
 */
export function generateMemorySummary(
  profile: LearnerProfile,
  memories: readonly PiMemoryRecord[] = [],
): string {
  const sections = new Map<string, string[]>();
  const plain = (value: string) => value.replace(/\\/g, "").toLowerCase();
  // The profile and the agent's memories often say the same thing; keep the fuller wording once.
  const add = (title: string, value: string) => {
    if (!value) return;
    const key = plain(value);
    const all = [...sections.values()].flat();
    if (all.some((existing) => plain(existing).includes(key))) return;
    for (const [name, values] of sections) sections.set(name, values.filter((existing) => !key.includes(plain(existing))));
    sections.set(title, [...(sections.get(title) ?? []), value]);
  };
  if (profile.languages.length) add("技术背景", "熟悉 " + profile.languages.slice(0, 8).map((value) => item(value, 40)).join("、"));
  if (profile.experience_level) add("技术背景", item(profile.experience_level, 80));
  for (const goal of profile.goals.slice(0, 8)) add("学习目标", item(goal, 120));
  if (profile.explanation_preference) add("讲解偏好", item(profile.explanation_preference, 120));
  memories
    .filter((memory) => memory.scope === "user" && memory.confidence >= 0.65)
    .slice(-8)
    .filter((memory) => !SENSITIVE_SUMMARY_PATTERN.test(memory.key + "=" + memory.value))
    .forEach((memory) => {
      const section = MEMORY_SECTIONS.find(({ pattern }) => pattern.test(memory.key))?.title ?? OTHER_SECTION;
      add(section, item(memory.value, 180));
    });
  profile.inferred
    .slice(-8)
    .filter((claim) => claim.confidence >= 0.65)
    .forEach((claim) => add("从最近的对话里", item(claim.claim, 220)));
  const order = [...MEMORY_SECTIONS.map(({ title }) => title), "从最近的对话里", OTHER_SECTION];
  const blocks = order
    .filter((title) => sections.get(title)?.length)
    .map((title) => [`### ${title}`, sections.get(title)!.map((value) => `- ${value}`).join("\n")].join("\n\n"));
  return blocks.length
    ? sanitizeMemorySummary(blocks.join("\n\n")).slice(0, SUMMARY_MAX_LENGTH - 200)
    : "还没有形成稳定的记忆摘要。随着你继续交流，这里会逐步整理你的学习目标、技术背景和讲解偏好。";
}
