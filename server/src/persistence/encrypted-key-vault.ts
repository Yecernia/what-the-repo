import type { Pool } from "pg";
import type { ProviderKeyVault } from "./store.js";
import { rememberByokSecret, validateByokKey } from "../security/byok-credentials.js";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_VERSION = 1;
// Version 1 persisted ciphertext depends on these exact KDF bytes.
// Keep this compatibility identifier when renaming the product.
const KEY_SALT = "repo-onboarding-provider-keys:v1";

export interface EncryptedProviderKey {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

function encryptionKey(secret: string): Buffer {
  if (secret.length < 16) throw new Error("provider key encryption secret must contain at least 16 characters");
  return scryptSync(secret, KEY_SALT, 32);
}

function keyOwner(ownerId: string, connectionId: string): string {
  return connectionId === "legacy" ? ownerId : `${ownerId}\0${connectionId}`;
}

function encryptWithKey(
  key: Buffer,
  ownerId: string,
  value: string,
  connectionId = "legacy",
): EncryptedProviderKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(keyOwner(ownerId, connectionId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

function decryptWithKey(
  key: Buffer,
  ownerId: string,
  encrypted: EncryptedProviderKey,
  connectionId = "legacy",
): string {
  if (encrypted.keyVersion !== KEY_VERSION) throw new Error("unsupported provider key encryption version");
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.iv);
  decipher.setAAD(Buffer.from(keyOwner(ownerId, connectionId), "utf8"));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  try { return plaintext.toString("utf8"); } finally { plaintext.fill(0); }
}

export function encryptProviderKey(secret: string, ownerId: string, value: string, connectionId = 'legacy'): EncryptedProviderKey {
  const key = encryptionKey(secret);
  try { return encryptWithKey(key, ownerId, value, connectionId); } finally { key.fill(0); }
}
export function decryptProviderKey(secret: string, ownerId: string, value: EncryptedProviderKey, connectionId = 'legacy'): string {
  const key = encryptionKey(secret);
  try { return decryptWithKey(key, ownerId, value, connectionId); } finally { key.fill(0); }
}

/** Only ciphertext is durable; no startup hydration or plaintext key cache. */
export class EncryptedPostgresKeyVault implements ProviderKeyVault {
  readonly #key: Buffer;
  readonly #pool: Pool;
  constructor(pool: Pool, secret: string) { this.#pool = pool; this.#key = encryptionKey(secret); }
  async init(): Promise<void> {}
  async has(ownerId: string, connectionId = 'legacy'): Promise<boolean> {
    const result = await this.#pool.query('SELECT 1 FROM provider_keys WHERE owner_id=$1 AND connection_id=$2', [ownerId, connectionId]);
    return Boolean(result.rowCount);
  }
  async get(ownerId: string, connectionId = 'legacy'): Promise<string | null> {
    const result = await this.#pool.query('SELECT ciphertext,iv,auth_tag,key_version FROM provider_keys WHERE owner_id=$1 AND connection_id=$2', [ownerId, connectionId]);
    const row = result.rows[0];
    if (!row) return null;
    try {
      return rememberByokSecret(ownerId, decryptWithKey(this.#key, ownerId, {
        ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag, keyVersion: row.key_version,
      }, connectionId));
    } catch {
      throw Object.assign(new Error('provider_credential_unavailable'), { code: 'provider_unavailable', statusCode: 503 });
    }
  }
  async set(ownerId: string, value: string, connectionId = 'legacy'): Promise<void> {
    if (!value.trim()) { await this.clear(ownerId, connectionId); return; }
    const key = rememberByokSecret(ownerId, validateByokKey(value));
    const encrypted = encryptWithKey(this.#key, ownerId, key, connectionId);
    await this.#pool.query(`INSERT INTO provider_keys(owner_id,connection_id,ciphertext,iv,auth_tag,key_version,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(owner_id,connection_id) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,
      key_version=EXCLUDED.key_version,updated_at=EXCLUDED.updated_at`,
    [ownerId, connectionId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion]);
  }
  async clear(ownerId: string, connectionId = 'legacy'): Promise<void> {
    await this.#pool.query('DELETE FROM provider_keys WHERE owner_id=$1 AND connection_id=$2', [ownerId, connectionId]);
  }
  async masked(ownerId: string, connectionId = 'legacy'): Promise<string | null> {
    return await this.has(ownerId, connectionId) ? '********' : null;
  }
}

/** FileStore's development fallback is encrypted in memory, not a durable vault. */
export class TransientKeyVault implements ProviderKeyVault {
  readonly #key = randomBytes(32);
  readonly #values = new Map<string, EncryptedProviderKey>();
  async init(): Promise<void> {}
  async set(ownerId: string, value: string, connectionId = 'legacy'): Promise<void> {
    if (!value.trim()) { await this.clear(ownerId, connectionId); return; }
    const key = rememberByokSecret(ownerId, validateByokKey(value));
    this.#values.set(JSON.stringify([ownerId, connectionId]), encryptWithKey(this.#key, ownerId, key, connectionId));
  }
  async get(ownerId: string, connectionId = 'legacy'): Promise<string | null> {
    const row = this.#values.get(JSON.stringify([ownerId, connectionId]));
    return row ? rememberByokSecret(ownerId, decryptWithKey(this.#key, ownerId, row, connectionId)) : null;
  }
  async has(ownerId: string, connectionId = 'legacy'): Promise<boolean> {
    return this.#values.has(JSON.stringify([ownerId, connectionId]));
  }
  async clear(ownerId: string, connectionId = 'legacy'): Promise<void> {
    this.#values.delete(JSON.stringify([ownerId, connectionId]));
  }
  async masked(ownerId: string, connectionId = 'legacy'): Promise<string | null> {
    return await this.has(ownerId, connectionId) ? '********' : null;
  }
}
