import { useEffect, useRef } from 'react';

const DONE_ICONS: Record<string, string> = {
  'image/svg+xml': '/favicon-done.svg?v=1',
  'image/png': '/favicon-done.png?v=1',
};

function showDone(done: boolean) {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    link.dataset.restingHref ??= link.getAttribute('href') ?? '';
    // The .ico shortcut has no type; browsers accept a PNG in its place.
    link.setAttribute('href', done ? DONE_ICONS[link.type] ?? DONE_ICONS['image/png'] : link.dataset.restingHref);
  }
}

/** When an answer or analysis finishes while the tab is in the background, the page in the tab icon turns into
 * a tick; it goes back to the usual icon as soon as the tab is looked at again. */
export function TabDoneBadge({ working }: { working: boolean }) {
  const wasWorking = useRef(working);
  useEffect(() => {
    const finished = wasWorking.current && !working;
    wasWorking.current = working;
    if (finished && document.hidden) showDone(true);
  }, [working]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) showDone(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); showDone(false); };
  }, []);
  return null;
}
