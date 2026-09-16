import { Suspense, lazy } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LazyLoadBoundary } from './LazyLoadBoundary';

afterEach(() => vi.restoreAllMocks());
it('renders successful content without adding layout elements', () => {
  const view = render(<LazyLoadBoundary><span>ready</span></LazyLoadBoundary>);
  expect(view.container.innerHTML).toBe('<span>ready</span>');
});
it('isolates a failed import, retains a sibling draft and honors reload cancellation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let reject!: (reason: Error) => void;
  const Lazy = lazy(() => new Promise<{ default: () => null }>((_resolve, fail) => { reject = fail; }));
  const beforeReload = vi.fn(() => false);
  render(<><textarea aria-label="draft" defaultValue="unsent" />
    <LazyLoadBoundary beforeReload={beforeReload}><Suspense fallback={<span>loading</span>}><Lazy /></Suspense></LazyLoadBoundary></>);
  expect(screen.getByText('loading')).toBeVisible();
  reject(new Error('private module URL must not be echoed'));
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
  expect(screen.queryByText('private module URL must not be echoed')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'draft' })).toHaveValue('unsent');
  fireEvent.click(screen.getByRole('button', { name: '重新加载页面' }));
  expect(beforeReload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: 'draft' })).toHaveValue('unsent');
});
