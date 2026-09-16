import { useEffect, useLayoutEffect, useState } from 'react';

export type AdminTheme = 'light' | 'dark';
export const ADMIN_THEME_KEY = 'what-the-repo-admin-theme';

function readPreference(): AdminTheme {
  try { return window.localStorage.getItem(ADMIN_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

/** Admin-only preference: never change the product's theme or server configuration. */
export function useAdminTheme() {
  const [theme, setTheme] = useState<AdminTheme>(readPreference);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-admin-theme');
    return () => {
      if (previous === null) root.removeAttribute('data-admin-theme');
      else root.setAttribute('data-admin-theme', previous);
    };
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.adminTheme = theme;
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if ((event.key === ADMIN_THEME_KEY || event.key === null)
        && (event.storageArea === null || event.storageArea === window.localStorage)) {
        setTheme(readPreference());
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { window.localStorage.setItem(ADMIN_THEME_KEY, next); }
    catch { /* A denied storage write must not prevent switching this page. */ }
  };
  return { theme, toggle };
}
