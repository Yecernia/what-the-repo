import type { Message, Project } from "./conversation.js";

export const DEFAULT_DISPLAY_LANGUAGE = "zh-CN";

const LANGUAGE_LABELS: Record<string, string> = {
  "zh-CN": "简体中文",
  zh: "中文",
  en: "English",
  "en-US": "English",
  ja: "日本語",
  ko: "한국어",
};

export function normalizeDisplayLanguage(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().replaceAll("_", "-") : "";
  if (!raw) return DEFAULT_DISPLAY_LANGUAGE;
  if (/^zh(?:-|$)/i.test(raw)) return "zh-CN";
  if (/^en(?:-|$)/i.test(raw)) return "en";
  if (/^ja(?:-|$)/i.test(raw)) return "ja";
  if (/^ko(?:-|$)/i.test(raw)) return "ko";
  return raw.slice(0, 32);
}

export function displayLanguageLabel(value: unknown): string {
  const language = normalizeDisplayLanguage(value);
  return LANGUAGE_LABELS[language] ?? language;
}

/** A saved project choice survives later conversations in another language. */
export function projectDisplayLanguage(project: Pick<Project, "display_language" | "messages">): string {
  return project.display_language
    ? normalizeDisplayLanguage(project.display_language)
    : inferDisplayLanguage(project.messages, DEFAULT_DISPLAY_LANGUAGE);
}

export function inferDisplayLanguage(
  messages: readonly Pick<Message, "role" | "content">[],
  fallback: unknown = DEFAULT_DISPLAY_LANGUAGE,
): string {
  // A current request outweighs old conversation prose. Code and URLs are not
  // evidence that a Chinese-speaking reader wants an English learning route.
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const text = message.content.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, " ").trim();
    if (!text) continue;
    const explicit = text.match(/(?:请用|请使用|请改用)\s*(?:英文|英语|中文|汉语)|(?:用|使用|改用)\s*(?:英文|英语|中文|汉语)(?:来)?(?:回答|回复|解释|讲解|写|说|制定|生成|交流)|\b(?:answer|reply|respond|speak|explain|write)(?:\s+to me)?\s+in\s+(?:english|chinese)\b/gi);
    if (explicit?.length) return /英文|英语|english/i.test(explicit.at(-1)!) ? "en" : "zh-CN";
    const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    const hangul = (text.match(/[\uac00-\ud7af]/g) ?? []).length;
    const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    if (kana >= 2) return "ja";
    if (hangul >= 2 && hangul >= latin * 0.2) return "ko";
    if (han >= 1 && han >= latin * 0.2) return "zh-CN";
    if (latin >= 2) return "en";
  }
  return normalizeDisplayLanguage(fallback);
}

export function displayLanguageInstruction(value: unknown): string {
  return "所有用户可见自然语言字段必须使用"
    + displayLanguageLabel(value)
    + "；路径、符号、包名、命令和代码片段保留原文。";
}

export function languageHasNaturalText(value: unknown, language: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = normalizeDisplayLanguage(language);
  if (normalized === "zh-CN" || normalized === "zh") return /[\u3400-\u9fff]/.test(value);
  if (normalized === "ja") return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
  if (normalized === "ko") return /[\uac00-\ud7af]/.test(value);
  if (normalized === "en") return /[A-Za-z]/.test(value);
  return true;
}
