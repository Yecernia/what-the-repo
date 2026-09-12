(function () {
  try {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = systemDark ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = 'system';
    document.documentElement.style.colorScheme = resolved;
  } catch {
    // CSS still follows the operating-system theme when storage is unavailable.
  }
}());
