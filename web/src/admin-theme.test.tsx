import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ADMIN_THEME_KEY, useAdminTheme } from './admin-theme';
import { AdminThemeToggle } from './AdminThemeToggle';

function Harness() {
  const { theme, toggle } = useAdminTheme();
  return <AdminThemeToggle theme={theme} toggle={toggle} />;
}
const root = document.documentElement;
beforeEach(() => { localStorage.clear(); root.removeAttribute('data-admin-theme'); });
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); localStorage.clear();
  root.removeAttribute('data-admin-theme'); root.removeAttribute('data-theme');
  root.style.removeProperty('color-scheme');
});

it('keeps the existing light appearance by default without writing a preference', () => {
  render(<Harness />);
  expect(root.dataset.adminTheme).toBe('light');
  expect(screen.getByRole('switch', { name: '深色模式' })).toHaveAttribute('aria-checked', 'false');
  expect(localStorage.getItem(ADMIN_THEME_KEY)).toBeNull();
});
it('toggles both directions and restores the choice on remount', () => {
  const first = render(<Harness />);
  fireEvent.click(screen.getByRole('switch'));
  expect(root.dataset.adminTheme).toBe('dark');
  expect(localStorage.getItem(ADMIN_THEME_KEY)).toBe('dark');
  first.unmount(); render(<Harness />);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  fireEvent.click(screen.getByRole('switch'));
  expect(root.dataset.adminTheme).toBe('light');
  expect(localStorage.getItem(ADMIN_THEME_KEY)).toBe('light');
});
it('isolates admin preference from the product theme and restores DOM on unmount', () => {
  root.dataset.theme = 'dark'; root.style.colorScheme = 'dark';
  localStorage.setItem('what-the-repo-theme', 'system');
  const view = render(<StrictMode><Harness /></StrictMode>);
  fireEvent.click(screen.getByRole('switch'));
  expect(root.dataset.theme).toBe('dark');
  expect(root.style.colorScheme).toBe('dark');
  expect(localStorage.getItem('what-the-repo-theme')).toBe('system');
  view.unmount(); expect(root.hasAttribute('data-admin-theme')).toBe(false);
});
it('restores a pre-existing admin marker when leaving the console', () => {
  root.dataset.adminTheme = 'dark';
  const view = render(<Harness />); expect(root.dataset.adminTheme).toBe('light');
  view.unmount(); expect(root.dataset.adminTheme).toBe('dark');
});
it.each(['invalid', 'system', ''])('handles an unsupported saved preference: %s', value => {
  localStorage.setItem(ADMIN_THEME_KEY, value); render(<Harness />);
  expect(root.dataset.adminTheme).toBe('light');
});
it('synchronizes other tabs and handles a cleared preference', () => {
  render(<Harness />); localStorage.setItem(ADMIN_THEME_KEY, 'dark');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: ADMIN_THEME_KEY })));
  expect(root.dataset.adminTheme).toBe('dark');
  localStorage.removeItem(ADMIN_THEME_KEY);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(root.dataset.adminTheme).toBe('light');
});
it('ignores unrelated storage events', () => {
  render(<Harness />); localStorage.setItem(ADMIN_THEME_KEY, 'dark');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'another-setting' })));
  expect(root.dataset.adminTheme).toBe('light');
});
it('still switches when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  render(<Harness />); fireEvent.click(screen.getByRole('switch'));
  expect(root.dataset.adminTheme).toBe('dark');
  fireEvent.click(screen.getByRole('switch')); expect(root.dataset.adminTheme).toBe('light');
});
