import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });
describe('server-managed API keys', () => {
  it('sends a draft once and never resends it on ordinary settings or chat-related requests', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ providers: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const { apiClient } = await import('./api');
    const key = 'browser-managed-canary-123';
    await apiClient.addProviderConnection({ provider: 'deepseek', api_key: key, verification_token: 'proof', models: ['m'] });
    const first = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(first[1].headers).get('x-wtr-byok-draft')).toBe(key);
    expect(String(first[1].body)).not.toContain(key);
    expect(first[1].redirect).toBe('error'); expect(first[1].cache).toBe('no-store');
    await apiClient.getSettings();
    const next = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(next[1].headers).get('x-wtr-byok-draft')).toBeNull();
    await apiClient.replaceProviderKey('one', { api_key: key, verification_token: 'proof', models: ['m'] });
    const replaced = fetch.mock.calls[2] as unknown as [string, RequestInit];
    expect(replaced[0]).toContain('/connections/one/key'); expect(replaced[1].method).toBe('PUT');
    expect(persist.mock.calls.some(call => JSON.stringify(call).includes(key))).toBe(false);
  });
  it('rejects credential transmission to remote HTTP before fetch', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://remote.example');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { apiClient } = await import('./api');
    expect(() => apiClient.verifyProviderConnection({ provider: 'deepseek', api_key: 'canary-only' })).toThrow(/HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
