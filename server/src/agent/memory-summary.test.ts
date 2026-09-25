import assert from "node:assert/strict";
import test from "node:test";
import { emptyProfile, normalizeProfile } from "../domain/conversation.js";
import { generateMemorySummary, sanitizeMemorySummary } from "./memory-summary.js";

test("memory summary sanitization removes every obvious credential fragment", () => {
  const value = sanitizeMemorySummary(
    "先记住 api_key=sk-first-secret，再记住 token=second-secret；Bearer third-secret。",
  );
  assert.equal(value, "先记住 [已隐藏]，再记住 [已隐藏]；[已隐藏]。");
  assert.doesNotMatch(value, /sk-first|second-secret|third-secret/);
});

test("legacy edited summaries are sanitized while loading", () => {
  const profile = normalizeProfile({
    ...emptyProfile(),
    memory_summary_mode: "edited",
    memory_summary: "我的 api_key=sk-legacy-secret 和 token=another-secret",
  });
  assert.equal(profile.memory_summary_mode, "edited");
  assert.equal(profile.memory_summary, "我的 [已隐藏] 和 [已隐藏]");
});

test("generated summary only includes high-confidence user memories", () => {
  const profile = normalizeProfile({
    ...emptyProfile(),
    languages: ["Go"],
    goals: ["理解调用链"],
  });
  const summary = generateMemorySummary(profile, [
    {
      memoryId: "safe",
      ownerId: "owner",
      scope: "user",
      key: "preferred-style",
      value: "先给输入输出，再解释实现",
      sourceMessageIds: ["message"],
      confidence: 0.9,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    {
      memoryId: "low",
      ownerId: "owner",
      scope: "user",
      key: "maybe",
      value: "不确定的偏好",
      sourceMessageIds: ["message"],
      confidence: 0.4,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    {
      memoryId: "secret",
      ownerId: "owner",
      scope: "user",
      key: "api-key",
      value: "sk-hidden-secret",
      sourceMessageIds: ["message"],
      confidence: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ]);
  assert.match(summary, /Go/);
  assert.match(summary, /先给输入输出，再解释实现/);
  assert.doesNotMatch(summary, /preferred-style|不确定的偏好|sk-hidden-secret|api-key/);
});

test("generated summary reads as short Markdown sections without internal keys or doubled full stops", () => {
  const profile = normalizeProfile({
    ...emptyProfile(),
    languages: ["TypeScript"],
    experience_level: "能读一些代码",
    goals: ["理解调用链。"],
  });
  const memory = (key: string, value: string) => ({
    memoryId: key, ownerId: "owner", scope: "user" as const, key, value, sourceMessageIds: ["message"], confidence: 0.9,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const summary = generateMemorySummary(profile, [
    memory("experience_level", "能读一些代码，但对 Agent 运行时还不熟悉。"),
    memory("explanation_style", "先讲整体，再讲 *细节*"),
    memory("timezone", "UTC+8"),
  ]);
  assert.equal(summary, [
    "### 技术背景", "", "- 熟悉 TypeScript", "- 能读一些代码，但对 Agent 运行时还不熟悉", "",
    "### 学习目标", "", "- 理解调用链", "",
    "### 讲解偏好", "", "- 先讲整体，再讲 \\*细节\\*", "",
    "### 其他记住的事", "", "- UTC+8",
  ].join("\n"));
});
