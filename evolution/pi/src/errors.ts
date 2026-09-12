import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ErrorSummary } from "./contracts.js";

const MAX_ERROR_NAME_BYTES = 96;
const MAX_ERROR_MESSAGE_BYTES = 2_048;
const WINDOWS_ABSOLUTE_PATH = /(?:\\\\\?\\)?[A-Za-z]:[\\/](?:[^\s\r\n\t'"<>|]+[\\/]?)+/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s('"=])\/(?:[^\s\r\n\t'"<>|]+\/?)+/g;
const SECRET_TOKEN = /\b(?:sk|ghp|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi;

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSensitiveText(value: string, roots: string[] = []): string {
  let redacted = value.replace(/\0/g, "<nul>");
  for (const root of roots) {
    if (!root) continue;
    const absolute = resolve(root);
    redacted = redacted.replace(new RegExp(escapeRegExp(absolute), "gi"), "<redacted-path>");
    redacted = redacted.replace(
      new RegExp(escapeRegExp(absolute.replaceAll("\\", "/")), "gi"),
      "<redacted-path>",
    );
  }
  redacted = redacted
    .replace(WINDOWS_ABSOLUTE_PATH, "<redacted-path>")
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<redacted-path>`)
    .replace(SECRET_TOKEN, "<redacted-secret>")
    .replace(BEARER_TOKEN, "Bearer <redacted-secret>");
  return redacted;
}

export function summarizeError(error: unknown, roots: string[] = []): ErrorSummary {
  const rawName = error instanceof Error ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const name = truncateUtf8(redactSensitiveText(rawName, roots), MAX_ERROR_NAME_BYTES).value || "Error";
  const sanitized = redactSensitiveText(rawMessage, roots);
  const bounded = truncateUtf8(sanitized, MAX_ERROR_MESSAGE_BYTES);
  return {
    name,
    message: bounded.value,
    messageDigest: createHash("sha256").update(sanitized).digest("hex"),
    truncated: bounded.truncated,
  };
}

export function hasUnsafeAbsolutePath(value: string): boolean {
  WINDOWS_ABSOLUTE_PATH.lastIndex = 0;
  POSIX_ABSOLUTE_PATH.lastIndex = 0;
  return WINDOWS_ABSOLUTE_PATH.test(value) || POSIX_ABSOLUTE_PATH.test(value);
}
