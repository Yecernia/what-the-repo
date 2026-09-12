import { useSyncExternalStore } from 'react';
import { englishMessages } from './ui-messages-en';

export type UiLanguage = 'zh-CN' | 'en';
export const UI_LANGUAGE_STORAGE_KEY = 'what-the-repo-ui-language';

export function normalizeUiLanguage(value: string | null | undefined): UiLanguage {
  return /^zh(?:-|$)/i.test(value ?? '') ? 'zh-CN' : 'en';
}

function initialLanguage(): UiLanguage {
  try {
    const saved = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en') return saved;
  } catch { /* The selection also works when browser storage is unavailable. */ }
  return typeof navigator === 'undefined' ? 'zh-CN' : normalizeUiLanguage(navigator.language);
}

let language = initialLanguage();
const listeners = new Set<() => void>();

export function getUiLanguage(): UiLanguage {
  return language;
}

export function setUiLanguage(value: UiLanguage): void {
  language = value;
  try { localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, value); } catch { /* Keep the in-memory choice. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(subscribe, getUiLanguage, () => 'zh-CN');
}

/** Translate only application-owned labels; repository and model text stays intact. */
export function translateFor(locale: UiLanguage, message: string, ...values: unknown[]): string {
  const translated = locale === 'en'
    ? message.replace(/\S[\s\S]*\S|\S/, key => englishMessages[key] ?? key)
    : message;
  return translated.replace(/\{(\d+)\}/g, (_match, index: string) => String(values[Number(index)]));
}

export function t(message: string, ...values: unknown[]): string {
  return translateFor(language, message, ...values);
}
