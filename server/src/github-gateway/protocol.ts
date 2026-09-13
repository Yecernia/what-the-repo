import { createHmac, timingSafeEqual } from "node:crypto";

const PROTOCOL_VERSION = 1;
const MAX_TOKEN_BYTES = 8 * 1024;

export interface GithubGatewayStartGrant {
  version: 1;
  kind: "github_oauth_start";
  audience?: "admin";
  nonce: string;
  issued_at: number;
  expires_at: number;
}

interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

export type GithubGatewayIdentityTicket = {
  version: 1;
  kind: "github_oauth_result";
  outcome: "success";
  audience?: "admin";
  nonce: string;
  ticket_id: string;
  issued_at: number;
  expires_at: number;
  github: GithubIdentity;
} | {
  version: 1;
  kind: "github_oauth_result";
  outcome: "error";
  audience?: "admin";
  nonce: string;
  ticket_id: string;
  issued_at: number;
  expires_at: number;
  error: "access_denied" | "github_unavailable" | "invalid_response";
};

function canonicalBase64Url(value: string): boolean {
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  if (!canonicalBase64Url(left) || !canonicalBase64Url(right)) return false;
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function signGithubGatewayPayload(payload: object, secret: string): string {
  if (secret.length < 32) throw new Error("github_gateway_secret_too_short");
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyGithubGatewayPayload(value: string, secret: string): unknown | null {
  if (!value || value.length > MAX_TOKEN_BYTES || secret.length < 32) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature || !canonicalBase64Url(body)) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function validEnvelope(value: Record<string, unknown>, kind: string, now: number): boolean {
  return value.version === PROTOCOL_VERSION
    && value.kind === kind
    && typeof value.nonce === "string"
    && /^[a-f0-9-]{16,80}$/i.test(value.nonce)
    && typeof value.issued_at === "number"
    && Number.isSafeInteger(value.issued_at)
    && typeof value.expires_at === "number"
    && Number.isSafeInteger(value.expires_at)
    && value.issued_at <= now + 30_000
    && value.expires_at >= now
    && value.expires_at - value.issued_at <= 10 * 60_000;
}

export function parseGithubGatewayStartGrant(
  value: string,
  secret: string,
  now = Date.now(),
): GithubGatewayStartGrant | null {
  const decoded = verifyGithubGatewayPayload(value, secret);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  if (!validEnvelope(record, "github_oauth_start", now) || (record.audience !== undefined && record.audience !== "admin")) return null;
  return record as unknown as GithubGatewayStartGrant;
}

function validGithubIdentity(value: unknown): value is GithubIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "number"
    && Number.isSafeInteger(record.id)
    && record.id > 0
    && typeof record.login === "string"
    && /^[A-Za-z0-9-]{1,100}$/.test(record.login)
    && (record.name === null || (typeof record.name === "string" && record.name.length <= 255))
    && (record.avatar_url === null || (typeof record.avatar_url === "string" && /^https:\/\//i.test(record.avatar_url) && record.avatar_url.length <= 2_048));
}

export function parseGithubGatewayIdentityTicket(
  value: string,
  secret: string,
  now = Date.now(),
): GithubGatewayIdentityTicket | null {
  const decoded = verifyGithubGatewayPayload(value, secret);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  if (!validEnvelope(record, "github_oauth_result", now)) return null;
  if (typeof record.ticket_id !== "string" || !/^[a-f0-9-]{16,80}$/i.test(record.ticket_id)) return null;
  if (record.outcome === "success" && validGithubIdentity(record.github)) {
    return record as unknown as GithubGatewayIdentityTicket;
  }
  if (
    record.outcome === "error"
    && ["access_denied", "github_unavailable", "invalid_response"].includes(String(record.error))
  ) {
    return record as unknown as GithubGatewayIdentityTicket;
  }
  return null;
}
