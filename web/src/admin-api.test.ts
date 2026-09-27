import { afterEach, expect, it, vi } from 'vitest';
import { adminAuthExpiredEvent, adminRequest, AdminRequestError } from './admin-api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('allows a slow read to finish, but aborts a stalled read at its deadline', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  }));
  const request = adminRequest('/overview');
  const failed = expect(request).rejects.toThrow('管理请求超时');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal?.aborted).toBe(true);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('propagates navigation cancellation without waiting for the deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
  const controller = new AbortController();
  const request = adminRequest('/overview', 'GET', undefined, undefined, controller.signal);
  const failed = expect(request).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([401, 403])('reports HTTP %s as authorization failure even with a non-JSON body', async (status) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream denial', { status })));
  const expired = vi.fn();
  window.addEventListener(adminAuthExpiredEvent, expired);
  try {
    await expect(adminRequest('/overview')).rejects.toBeInstanceOf(AdminRequestError);
    expect(expired).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener(adminAuthExpiredEvent, expired);
  }
});

it('keeps ordinary reads cacheable by the admin service and marks explicit refreshes', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await adminRequest('/overview');
  await adminRequest('/overview', 'GET', undefined, undefined, undefined, true);
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('x-admin-refresh');
  expect(fetch.mock.calls[1][1].headers).toHaveProperty('x-admin-refresh', '1');
});
