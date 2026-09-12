import { describe, expect, it } from 'vitest';
import { resolveTheme } from './theme';

describe('theme resolution', () => {
  it('uses the operating-system appearance only for the system preference', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
