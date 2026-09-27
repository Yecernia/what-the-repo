import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { defaultRuntimeMetrics, type RuntimeMetrics } from '../observability/metrics.js';
import { adminError } from './security.js';

const reads = new AsyncLocalStorage<{ deadline: number; resource: string; queries: number; metrics: RuntimeMetrics }>();

export async function runAdminRead<T>(resource: string, operation: () => Promise<T>, metrics = defaultRuntimeMetrics): Promise<T> {
  const state = { deadline: performance.now() + 3_000, resource, queries: 0, metrics };
  return reads.run(state, async () => {
    try { return await operation(); }
    finally {
      metrics.observe('what_the_repo_admin_read_queries', state.queries, { resource });
    }
  });
}

/** Stop scheduling SQL after the read budget, including after waiting for a connection.
 * The pool's server-side 2s statement_timeout bounds any final in-flight statement;
 * no Promise.race leaves an abandoned query consuming a connection.
 */
export function managementReadPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property !== 'query') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const state = reads.getStore();
        if (!state) return Reflect.apply(target.query, target, args);
        return (async () => {
          const checkBudget = () => {
            if (performance.now() >= state.deadline) throw adminError(503, 'admin_read_timeout');
          };
          checkBudget();
          const waiting = performance.now();
          const client = await target.connect();
          try {
            state.metrics.observe('what_the_repo_admin_connection_wait_ms', performance.now() - waiting,
              { resource: state.resource });
            checkBudget();
            state.queries++;
            const started = performance.now();
            try { return await Reflect.apply(client.query, client, args); }
            finally {
              state.metrics.observe('what_the_repo_admin_query_duration_ms', performance.now() - started,
                { resource: state.resource });
            }
          } finally { client.release(); }
        })();
      };
    },
  });
}
