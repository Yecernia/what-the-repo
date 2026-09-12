const SAFE_INHERITED_ENV_NAMES = (
  process.platform === 'win32'
    ? [
        'APPDATA',
        'COMSPEC',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PATHEXT',
        'PROGRAMDATA',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'WINDIR',
      ]
    : ['HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TEMP', 'TMP', 'TMPDIR', 'TZ']
) as readonly string[];

export function isolatedServiceEnv(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const name of SAFE_INHERITED_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) isolated[name] = value;
  }
  return { ...isolated, ...overrides };
}
