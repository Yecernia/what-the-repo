// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { e2eProviderEnv, isolatedServiceEnv } from '../e2e/service-env.js';

describe('isolatedServiceEnv', () => {
  it('keeps only process essentials and explicit local overrides', () => {
    const env = isolatedServiceEnv(
      {
        PATH: 'safe-path',
        DATABASE_URL: 'postgresql://production',
        GITHUB_OAUTH_CLIENT_SECRET: 'oauth-secret',
        WHAT_THE_REPO_PROVIDER_API_KEY_FILE: 'provider-secret.txt',
        VITE_API_BASE_URL: 'https://production.example/api',
      },
      {
        DATABASE_URL: '',
        WHAT_THE_REPO_DATA_DIR: 'isolated-data',
        VITE_API_BASE_URL: '',
      },
    );

    expect(env.PATH).toBe('safe-path');
    expect(env.WHAT_THE_REPO_DATA_DIR).toBe('isolated-data');
    expect(env.DATABASE_URL).toBe('');
    expect(env.VITE_API_BASE_URL).toBe('');
    expect(env.GITHUB_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(env.WHAT_THE_REPO_PROVIDER_API_KEY_FILE).toBeUndefined();
  });
});

describe('e2eProviderEnv', () => {
  it('disables inherited provider credentials unless explicitly enabled', () => {
    expect(e2eProviderEnv({
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY: 'must-not-be-used',
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE: 'must-not-be-read',
    })).toEqual({
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY: '',
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE: '',
    });
  });

  it('allows explicit provider acceptance with a key file', () => {
    expect(e2eProviderEnv({
      WHAT_THE_REPO_E2E_USE_PROVIDER: '1',
      WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE: 'test-provider-key',
    }).WHAT_THE_REPO_FREE_PROVIDER_API_KEY_FILE).toBe('test-provider-key');
  });

  it('rejects explicit provider acceptance without credentials', () => {
    expect(() => e2eProviderEnv({ WHAT_THE_REPO_E2E_USE_PROVIDER: '1' })).toThrow('requires a provider key');
  });
});
