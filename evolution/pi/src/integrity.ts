import { createHash } from "node:crypto";
import type { SkillCandidate } from "./contracts.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reviewedCandidateDigest(candidate: SkillCandidate): string {
  const { status: _status, ...reviewedFields } = candidate;
  return sha256(stableJson(reviewedFields));
}
