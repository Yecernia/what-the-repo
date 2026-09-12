import { createHash } from "node:crypto";
import { skillMetadata } from "../agent/skill-registry.js";
import { PROVIDER_WIRE_VERSION } from "../agent/provider-catalog.js";
import { RESEARCH_VERSION } from "./github.js";

export const ANALYZER_BUNDLE_VERSION = "typescript-0.4.0";

const SEMANTIC_SKILL_VERSIONS = [
  skillMetadata("component-explanation"),
  skillMetadata("architecture-planning"),
  skillMetadata("repository-value-discovery"),
].map((skill) => `${skill.id}@${skill.version}`).join(",");

export const ANALYSIS_CONFIG_DIGEST = createHash("sha256")
  .update([
    "nine-language-lsp-tree-sitter-two-layer-incremental-v3",
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
