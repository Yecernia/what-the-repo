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

export function e2eProviderEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const enabled = source.WHAT_THE_REPO_E2E_USE_PROVIDER === '1';
  const key = enabled ? source.WHAT_THE_REPO_FREE_PROVIDER_API_KEY ?? '' : '';
  const keyFile = enabled ? source.WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE ?? '' : '';
  if (enabled && !key && !keyFile) {
    throw new Error('WHAT_THE_REPO_E2E_USE_PROVIDER=1 requires a provider key or key file');
  }
  return {
    WHAT_THE_REPO_FREE_PROVIDER_API_KEY: key,
    WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE: keyFile,
  };
}
