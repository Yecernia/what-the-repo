import { afterEach, expect, it, vi } from 'vitest';
import { englishMessages } from './ui-messages-en';
import { normalizeUiLanguage, setUiLanguage, translateFor, UI_LANGUAGE_STORAGE_KEY } from './ui-language';

afterEach(() => { vi.restoreAllMocks(); });

it('uses the saved selection on a fresh load and otherwise follows the browser', async () => {
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
  vi.resetModules();
  expect((await import('./ui-language')).getUiLanguage()).toBe('en');
  setUiLanguage('zh-CN');
  vi.resetModules();
  expect((await import('./ui-language')).getUiLanguage()).toBe('zh-CN');
  expect(normalizeUiLanguage('zh-TW')).toBe('zh-CN');
  expect(normalizeUiLanguage('fr-FR')).toBe('en');
});

it('preserves identifiers and inserted source text when translating a label', () => {
  const source = '源码/{0}/Flask';
  expect(translateFor('en', '打开源码 {0}{1}', source, ':12')).toBe(`Open source ${source}:12`);
  expect(translateFor('en', ' 思考 ')).toBe(' Reasoning ');
  expect(translateFor('en', '用户自定义的项目名')).toBe('用户自定义的项目名');
});

it('keeps interpolation slots intact across the English dictionary', () => {
  for (const [key, value] of Object.entries(englishMessages)) {
    expect([...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort(), key)
      .toEqual([...key.matchAll(/\{\d+\}/g)].map(match => match[0]).sort());
  }
});
