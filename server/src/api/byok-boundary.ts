import type { FastifyInstance } from 'fastify';
import { byokError, currentCredentialRedactor, withCredentialScope } from '../security/byok-credentials.js';

const wrapped = new WeakSet<Function>();
/** A draft is sent only to credential-management endpoints, never on ordinary chat. */
export function registerByokBoundary(app: FastifyInstance): void {
  app.addHook('onRoute', route => {
    const original = route.handler;
    if (wrapped.has(original)) return;
    const handler: typeof original = async function(request, reply) {
      const draft = request.headers['x-wtr-byok-draft'];
      const obsolete = request.headers['x-wtr-byok'];
      delete request.headers['x-wtr-byok-draft']; delete request.headers['x-wtr-byok'];
      for (let i = request.raw.rawHeaders.length - 2; i >= 0; i -= 2) {
        if (/^x-wtr-byok(?:-draft)?$/i.test(request.raw.rawHeaders[i]!)) request.raw.rawHeaders.splice(i, 2);
      }
      const endpoint = request.routeOptions.url ?? '';
      const allowed = ['/api/settings/connections', '/api/settings/connections/verify',
        '/api/settings/connections/:connectionId/key'].includes(endpoint);
      if (obsolete !== undefined || draft !== undefined && (!allowed || typeof draft !== 'string')) throw byokError();
      return withCredentialScope(draft as string ?? '', async () => {
        if (endpoint.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
        const body = request.body;
        if (body && typeof body === 'object' && Object.hasOwn(body, 'api_key')) {
          delete (body as Record<string, unknown>).api_key;
          throw byokError();
        }
        if (body !== undefined && currentCredentialRedactor().contains(JSON.stringify(body))) throw byokError();
        try {
          const result = await original.call(this, request, reply);
          return result === reply ? result : currentCredentialRedactor().data(result);
        } catch (error) {
          const value = error as { message?: unknown; statusCode?: number; code?: string; resetAt?: string };
          const redactor = currentCredentialRedactor();
          const clean = new Error(redactor.text(typeof value?.message === 'string' ? value.message : 'request_failed'));
          throw Object.assign(clean, { statusCode: value?.statusCode, code: redactor.text(value?.code ?? ''),
            ...(typeof value?.resetAt === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value.resetAt) ? { resetAt: value.resetAt } : {}) });
        }
      });
    };
    wrapped.add(handler); route.handler = handler;
  });
}
