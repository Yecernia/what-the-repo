import { useEffect } from 'react';
/** Server counts one owner per 90 seconds; multiple tabs cannot multiply that owner. */
export function PresenceHeartbeat() {
  useEffect(() => {
    let pending: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null = null;
    let disposed = false;
    const cancel = () => {
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.controller.abort();
      pending = null;
    };
    const beat = async () => {
      if (disposed || document.visibilityState !== 'visible' || pending || !navigator.onLine)
        return;
      const controller = new AbortController();
      const request = { controller, timer: setTimeout(() => {
        if (pending?.controller === controller) cancel();
      }, 10_000) };
      pending = request;
      try {
        await fetch('/api/presence', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
        });
      } catch {
        /* Expiry handles disconnects. */
      } finally {
        clearTimeout(request.timer);
        // A timed-out fetch may finish after a replacement heartbeat starts.
        if (pending === request) pending = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) cancel();
      void beat();
    };
    void beat();
    const timer = window.setInterval(onVisible, 25_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('offline', onVisible);
    return () => {
      disposed = true;
      cancel();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('offline', onVisible);
    };
  }, []);
  return null;
}
