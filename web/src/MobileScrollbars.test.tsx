import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { MobileScrollbars } from './MobileScrollbars';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    media, matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps touch scrollbar artwork on product hosts but never on admin hosts or portals', async () => {
  render(<><MobileScrollbars /><textarea aria-label="Product editor" />
    <div className="admin-console"><textarea aria-label="Admin editor" /></div>
    {createPortal(<dialog open className="admin-code-dialog"><textarea aria-label="Admin dialog editor" /></dialog>, document.body)}
  </>);
  await waitFor(() => expect(screen.getByLabelText('Product editor')).toHaveClass('hand-scroll-native'));
  expect(screen.getByLabelText('Admin editor')).not.toHaveClass('hand-scroll-native');
  expect(screen.getByLabelText('Admin dialog editor')).not.toHaveClass('hand-scroll-native');
  expect(document.querySelector('.admin-code-dialog .mobile-scroll-layer')).toBeNull();
});

it('restores the native scrollbar if a tracked host moves into the admin scope', async () => {
  const view = (admin: boolean) => <><MobileScrollbars />
    <div className={admin ? 'admin-console' : 'product-editor'}><textarea aria-label="Moving editor" /></div>
  </>;
  const { rerender } = render(view(false));
  await waitFor(() => expect(screen.getByLabelText('Moving editor')).toHaveClass('hand-scroll-native'));
  rerender(view(true));
  await waitFor(() => expect(screen.getByLabelText('Moving editor')).not.toHaveClass('hand-scroll-native'));
  expect(document.querySelector('.mobile-scroll-layer')).toBeNull();
});
