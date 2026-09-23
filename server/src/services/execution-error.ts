import { ProductServiceError, serviceError } from './errors.js';

/** Local infrastructure errors are not provider prose and never mean user cancel. */
export function executionErrorCode(error: unknown): string | null {
  const row = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof row?.code === 'string' ? row.code : '';
  const message = typeof error === 'string' ? error : typeof row?.message === 'string' ? row.message : '';
  const known = ['runtime_lease_lost', 'database_pool_timeout', 'database_query_timeout',
    'database_control_unavailable', 'database_control_busy', 'client_network_error', 'server_error'];
  if (known.includes(code)) return code;
  if (known.includes(message)) return message;
  if (['runtime_lease_lost','pi_session_lease_lost','analysis_lease_lost'].includes(message)) return 'runtime_lease_lost';
  if (message === 'timeout exceeded when trying to connect') return 'database_pool_timeout';
  if (code === '57014') return 'database_query_timeout';
  return null;
}

export function runAbortCode(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  if (['run_cancelled','cancelled'].includes(message) || (reason as { name?: string })?.name === 'AbortError') return 'cancelled';
  if (message === 'conversation_stream_disconnected') return 'client_network_error';
  return executionErrorCode(reason) ?? 'server_error';
}

export function controlFailure(error: unknown): Error {
  if (error instanceof ProductServiceError) return error;
  const code = executionErrorCode(error) ?? 'database_control_unavailable';
  return serviceError(code, code, 503);
}
