import { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest, type AdminRow } from './admin-api';

export interface AdminCacheEntry { value: AdminRow; fetchedAt: number; invalidated?: boolean }
export type AdminCache = Map<string, AdminCacheEntry>;

/** One visible admin resource. The cache is owned and cleared by the login session. */
export function useAdminQuery({ path, enabled, cache, freshMs, pollMs, onError }: {
  path: string; enabled: boolean; cache: AdminCache; freshMs: number;
  pollMs?: number; onError?: (error: unknown) => void;
}) {
  const [, render] = useState(0);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const pending = useRef<{ controller: AbortController; completion: Promise<void> } | null>(null);
  const sequence = useRef(0);
  const failures = useRef(0);
  const schedule = useRef<(() => void) | null>(null);
  const active = useRef(false);
  const invalidate = useCallback(() => {
    sequence.current++;
    pending.current?.controller.abort();
    pending.current = null;
  }, []);
  const load = useCallback(async (force = false, refresh = force) => {
    if (!enabled || !active.current) return;
    if (!force && pending.current) return pending.current.completion;
    invalidate();
    const request = sequence.current;
    const controller = new AbortController();
    const completion = (async () => {
      try {
        const value = await adminRequest(path, 'GET', undefined, undefined, controller.signal, refresh);
        if (request !== sequence.current) return;
        const entry = { value, fetchedAt: Date.now() };
        cache.delete(path);
        cache.set(path, entry);
        if (cache.size > 32) cache.delete(cache.keys().next().value!);
        const readState = value.readState as { refreshFailed?: boolean } | undefined;
        failures.current = readState?.refreshFailed ? failures.current + 1 : 0;
        render((value) => value + 1);
        setFailure(null);
      } catch (error) {
        if (controller.signal.aborted || request !== sequence.current) return;
        failures.current++;
        setFailure({ path, message: (error as Error).message });
        onError?.(error);
      } finally {
        if (request === sequence.current) {
          pending.current = null;
          schedule.current?.();
        }
      }
    })();
    pending.current = { controller, completion };
    return completion;
  }, [cache, enabled, invalidate, onError, path]);

  useEffect(() => {
    if (!enabled) {
      setFailure(null);
      return;
    }
    active.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    failures.current = 0;
    setFailure(null);
    const arrange = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      // Retry all failed reads, including normally non-polling configuration pages.
      const readState = cache.get(path)?.value.readState as { refreshing?: boolean; stale?: boolean } | undefined;
      const serverRefresh = readState?.refreshing || readState?.stale;
      const delay = failures.current
        ? Math.min(120_000, (pollMs ?? 15_000) * 2 ** Math.min(failures.current, 4))
        : pollMs ?? (serverRefresh ? 15_000 : undefined);
      if (delay) timer = setTimeout(() => void load(), delay);
    };
    schedule.current = arrange;
    const resume = () => {
      clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      const cached = cache.get(path);
      const stale = (cached?.value.readState as { stale?: boolean } | undefined)?.stale;
      if (!cached || cached.invalidated || stale || Date.now() - cached.fetchedAt >= freshMs) void load();
      else arrange();
    };
    document.addEventListener('visibilitychange', resume);
    resume();
    return () => {
      active.current = false;
      schedule.current = null;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
      invalidate();
    };
  }, [cache, enabled, freshMs, invalidate, load, path, pollMs]);

  const entry = enabled ? cache.get(path) : null;
  return {
    data: entry?.value ?? null,
    fetchedAt: entry?.fetchedAt,
    error: enabled && failure?.path === path ? failure.message : '',
    load,
  };
}

export function affectedAdminResources(path: string): Set<string> {
  const resources = ['audit'];
  if (path.startsWith('/config') || path.startsWith('/connections/')) resources.push('config', 'overview');
  if (path.startsWith('/budgets')) resources.push('budgets', 'overview');
  if (path.startsWith('/evolution/')) resources.push('feedback', 'budgets', 'overview');
  if (path.startsWith('/storage/') || path.startsWith('/repositories/')) resources.push('storage', 'overview');
  if (path.startsWith('/repositories/')) resources.push('activity');
  return new Set(resources);
}

/** Dirty drafts survive refreshes and navigation but never outlive the admin session. */
export function useAdminDraft<T>(key: string, source: T, drafts: Map<string, unknown>) {
  const [, render] = useState(0);
  const value = drafts.has(key) ? drafts.get(key) as T : source;
  const set = (next: T) => { drafts.set(key, next); render((n) => n + 1); };
  const saved = (submitted: T) => {
    if (drafts.get(key) === submitted) { drafts.delete(key); render((n) => n + 1); }
  };
  const discard = () => { drafts.delete(key); render((n) => n + 1); };
  return [value, set, saved, discard] as const;
}
