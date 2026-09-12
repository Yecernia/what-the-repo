import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { Pool } from "pg";
import type { ProviderKeyVault } from "./store.js";

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

export function encryptProviderKey(
  secret: string,
  ownerId: string,
  value: string,
  connectionId = "legacy",
): EncryptedProviderKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(keyOwner(ownerId, connectionId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: KEY_VERSION };
}

export function decryptProviderKey(
  secret: string,
  ownerId: string,
  encrypted: EncryptedProviderKey,
  connectionId = "legacy",
): string {
  if (encrypted.keyVersion !== KEY_VERSION) throw new Error("unsupported provider key encryption version");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), encrypted.iv);
  decipher.setAAD(Buffer.from(keyOwner(ownerId, connectionId), "utf8"));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString("utf8");
}

export class EncryptedPostgresKeyVault implements ProviderKeyVault {
  private readonly cache = new Map<string, string>();

  constructor(private readonly pool: Pool, private readonly secret: string) {}

  async init(): Promise<void> {
    const result = await this.pool.query<{
      owner_id: string;
      connection_id: string;
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      key_version: number;
    }>("SELECT owner_id, connection_id, ciphertext, iv, auth_tag, key_version FROM provider_keys");
    for (const row of result.rows) {
      const value = decryptProviderKey(this.secret, row.owner_id, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      }, row.connection_id);
      this.cache.set(keyOwner(row.owner_id, row.connection_id), value);
    }
  }

  async set(ownerId: string, value: string, connectionId = "legacy"): Promise<void> {
    const normalized = value.trim();
    if (!normalized) {
      await this.clear(ownerId, connectionId);
      return;
    }
    const encrypted = encryptProviderKey(this.secret, ownerId, normalized, connectionId);
    await this.pool.query(
      `INSERT INTO provider_keys(owner_id, connection_id, ciphertext, iv, auth_tag, key_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT(owner_id, connection_id) DO UPDATE SET
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         key_version = EXCLUDED.key_version,
         updated_at = now()`,
      [ownerId, connectionId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion],
    );
    this.cache.set(keyOwner(ownerId, connectionId), normalized);
  }

  get(ownerId: string, connectionId = "legacy"): string | null {
    return this.cache.get(keyOwner(ownerId, connectionId)) ?? null;
  }

  async clear(ownerId: string, connectionId = "legacy"): Promise<void> {
    await this.pool.query(
      "DELETE FROM provider_keys WHERE owner_id = $1 AND connection_id = $2",
      [ownerId, connectionId],
    );
    this.cache.delete(keyOwner(ownerId, connectionId));
  }

  masked(ownerId: string, connectionId = "legacy"): string | null {
    const key = this.get(ownerId, connectionId);
    if (!key) return null;
    return key.length <= 8 ? "*".repeat(key.length) : `${key.slice(0, 4)}********${key.slice(-4)}`;
  }
}
