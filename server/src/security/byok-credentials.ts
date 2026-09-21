import { AsyncLocalStorage } from 'node:async_hooks';
import { credentialRedactor } from './secret-redaction.js';

interface CredentialScope { ownerId: string | null; draft: string; secrets: Set<string>; closed: boolean }
const scopes = new AsyncLocalStorage<CredentialScope>();
export function byokError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('请填写有效的 API Key。'), { statusCode: 400, code: 'provider_key_required' });
}
export function validateByokKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500
    || !/^[\x21-\x7e]+$/.test(value.trim())) throw byokError();
  return value.trim();
}
export function bindByokOwner(ownerId: string): void {
  const scope = scopes.getStore();
  if (!scope || scope.closed) return;
  if (scope.ownerId !== null && scope.ownerId !== ownerId) throw byokError();
  scope.ownerId = ownerId;
}
/** Track only credentials actually used in this request, solely for redaction. */
export function rememberByokSecret(ownerId: string, key: string): string {
  bindByokOwner(ownerId);
  const scope = scopes.getStore();
  if (scope && !scope.closed) scope.secrets.add(key);
  return key;
}
export function byokDraftKey(): string { return scopes.getStore()?.draft ?? ''; }
export function currentCredentialRedactor() { return credentialRedactor(scopes.getStore()?.secrets ?? []); }
export async function withCredentialScope<T>(draft: string, task: () => Promise<T>): Promise<T> {
  const normalized = draft ? validateByokKey(draft) : '';
  const scope: CredentialScope = { ownerId: null, draft: normalized,
    secrets: new Set(normalized ? [normalized] : []), closed: false };
  return scopes.run(scope, async () => {
    try { return await task(); }
    finally { scope.closed = true; scope.secrets.clear(); scope.draft = ''; }
  });
}
