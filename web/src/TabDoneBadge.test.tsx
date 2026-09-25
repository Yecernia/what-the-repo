import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TabDoneBadge } from './TabDoneBadge';

let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon-ink.svg?v=3" />'
    + '<link rel="icon" type="image/png" href="/favicon.png?v=3" /><link rel="shortcut icon" href="/favicon.ico?v=3" />';
});
afterEach(() => { document.head.innerHTML = ''; });

const hrefs = () => [...document.querySelectorAll('link')].map(link => link.getAttribute('href'));

it('marks the tab icon when work finishes in the background and restores it when the tab is seen', () => {
  const view = render(<TabDoneBadge working />);
  hidden = true;
  view.rerender(<TabDoneBadge working={false} />);
  expect(hrefs()).toEqual(['/favicon-done.svg?v=1', '/favicon-done.png?v=1', '/favicon-done.png?v=1']);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(hrefs()).toEqual(['/favicon-ink.svg?v=3', '/favicon.png?v=3', '/favicon.ico?v=3']);
});

it('leaves the tab icon alone when the work finishes while the tab is being looked at', () => {
  const view = render(<TabDoneBadge working />);
  view.rerender(<TabDoneBadge working={false} />);
  expect(hrefs()).toEqual(['/favicon-ink.svg?v=3', '/favicon.png?v=3', '/favicon.ico?v=3']);
});
