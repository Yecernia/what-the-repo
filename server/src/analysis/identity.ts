import { createHash } from "node:crypto";
import { skillMetadata } from "../agent/skill-registry.js";
import { PROVIDER_WIRE_VERSION } from "../agent/provider-catalog.js";
import { RESEARCH_VERSION } from "./github.js";
import { STATIC_TOOLCHAIN_IDENTITY } from "./toolchain.js";
import { LSP_POLICY_VERSION } from './lsp-policy.js';

export const ANALYZER_BUNDLE_VERSION = "static-kernel-1.0.0";

const SEMANTIC_SKILL_VERSIONS = [
  skillMetadata("component-explanation"),
  skillMetadata("architecture-planning"),
  skillMetadata("repository-value-discovery"),
].map((skill) => `${skill.id}@${skill.version}`).join(",");

export const ANALYSIS_CONFIG_DIGEST = createHash("sha256")
  .update([
    "project-native-facts-v1",
    STATIC_TOOLCHAIN_IDENTITY,
    LSP_POLICY_VERSION,
    process.env.WHAT_THE_REPO_LSP_ATTESTATION_SHA256?.trim().toLowerCase() ?? "no-attested-lsp",
    RESEARCH_VERSION,
    SEMANTIC_SKILL_VERSIONS,
    PROVIDER_WIRE_VERSION,
  ].join(":"))
  .digest("hex");

export function canonicalPublicSnapshotKey(
  repository: string,
  commitSha: string,
  analyzerBundleVersion = ANALYZER_BUNDLE_VERSION,
  analysisConfigDigest = ANALYSIS_CONFIG_DIGEST,
): string {
  return createHash("sha256").update(JSON.stringify({
    repository: repository.toLowerCase(),
    commit: commitSha,
    analyzer: analyzerBundleVersion,
    config: analysisConfigDigest,
  })).digest("hex");
}
