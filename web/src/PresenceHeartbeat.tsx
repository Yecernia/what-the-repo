import { useEffect } from 'react';
/** Server counts one owner per 90 seconds; multiple tabs cannot multiply that owner. */
export function PresenceHeartbeat() {
  useEffect(() => {
    let busy = false;
    const beat = async () => {
      if (document.visibilityState !== 'visible' || busy || !navigator.onLine)
        return;
      busy = true;
      try {
        await fetch('/api/presence', {
          method: 'POST',
          credentials: 'same-origin',
        });
      } catch {
        /* Expiry handles disconnects. */
      } finally {
        busy = false;
      }
    };
    const onVisible = () => {
      void beat();
    };
    void beat();
    const timer = window.setInterval(onVisible, 25_000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, []);
  return null;
}
