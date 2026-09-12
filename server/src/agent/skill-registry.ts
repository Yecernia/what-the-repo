import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  formatSkillInvocation,
  loadSkills,
  NodeExecutionEnv,
  type Skill,
} from "@earendil-works/pi-agent-core/node";
import { parse } from "yaml";
import { resolvePublishedSkillSource } from "./published-skill-source.js";
import { loadSkillPromptReferences } from "./skill-prompt-references.js";

export const PRODUCT_SKILL_IDS = [
  "primary-conversational-supervisor",
  "component-explanation",
  "architecture-planning",
  "understanding-assessment",
  "citation-review",
  "memory-maintenance",
  "repository-value-discovery",
  "snapshot-language-overlay",
  "learning-route",
  "feedback-analysis",
  "skill-evolution",
] as const;

export type ProductSkillId = typeof PRODUCT_SKILL_IDS[number];

/**
 * Skills that can plausibly affect a user-facing repository answer. Evolution
 * method Skills and feedback-analysis itself are intentionally excluded.
 */
export const FEEDBACK_TARGET_SKILL_IDS = [
  "primary-conversational-supervisor",
  "component-explanation",
  "architecture-planning",
  "understanding-assessment",
  "citation-review",
  "memory-maintenance",
  "repository-value-discovery",
  "learning-route",
] as const satisfies readonly ProductSkillId[];

export interface ProductSkill {
  id: ProductSkillId;
  version: string;
  skill: Skill;
  allowedTools: readonly string[];
  optionalTools?: readonly string[];
  inputSchemaId: string;
  outputSchemaId: string;
  contextBuilderId: string;
  evalSuite: string;
}

export interface ProductSkillRunContract {
  toolNames: readonly string[];
  inputSchemaId: string;
  outputSchemaId: string;
  contextBuilderId: string;
}

function publishedSkill(value: {
  name: string;
  filePath: string;
  content: string;
}): Skill {
  const normalized = value.content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const frontmatter = match
    ? parse(match[1]) as Record<string, unknown> | null
    : null;
  const body = match ? normalized.slice(match[0].length).trim() : normalized.trim();
  const name = typeof frontmatter?.name === "string" ? frontmatter.name.trim() : value.name;
  const description = typeof frontmatter?.description === "string" ? frontmatter.description.trim() : "";
  if (name !== value.name || !description) throw new Error(`skill_not_loadable:${value.name}`);
  return { name, description, content: body, filePath: value.filePath };
}

const SKILL_METADATA: Record<ProductSkillId, Omit<ProductSkill, "skill">> = {
  "primary-conversational-supervisor": {
    id: "primary-conversational-supervisor",
    version: "4.0.5",
    allowedTools: [
      "get_project_overview",
      "list_value_points",
      "query_code_evidence",
      "get_component_context",
      "read_source_excerpt",
      "get_learning_context",
      "get_learner_profile",
      "assess_understanding",
      "propose_learning_action",
      "report_feedback_hint",
    ],
    inputSchemaId: "conversation-turn-v1",
    outputSchemaId: "natural-answer-v1",
    contextBuilderId: "primary-conversation-context-v3",
    evalSuite: "conversation-contract-v7",
  },
  "component-explanation": {
    id: "component-explanation",
    version: "1.0.0",
    allowedTools: [
      "list_repository_components",
      "get_repository_component",
      "query_repository_relations",
      "get_repository_evidence",
      "read_repository_source",
      "submit_result",
      "repair_result_text",
      "get_repository_file_outline",
    ],
    optionalTools: ["repair_result_text", "get_repository_file_outline"],
    inputSchemaId: "component-explanation-input-v6",
    outputSchemaId: "component-explanation-output-v6",
    contextBuilderId: "component-explanation-context-v18",
    evalSuite: "component-explanation-v20",
  },
  "architecture-planning": {
    id: "architecture-planning",
    version: "1.0.0",
    allowedTools: [
      "list_repository_components",
      "get_repository_component",
      "query_repository_relations",
      "get_repository_evidence",
      "read_repository_source",
      "submit_result",
      "repair_result_text",
      "get_repository_file_outline",
    ],
    optionalTools: ["repair_result_text", "get_repository_file_outline"],
    inputSchemaId: "architecture-planning-input-v6",
    outputSchemaId: "architecture-planning-output-v6",
    contextBuilderId: "architecture-planning-context-v18",
    evalSuite: "architecture-planning-v20",
  },
  "understanding-assessment": {
    id: "understanding-assessment",
    version: "4.0.2",
    allowedTools: ["submit_result"],
    inputSchemaId: "understanding-assessment-input-v1",
    outputSchemaId: "understanding-assessment-output-v1",
    contextBuilderId: "understanding-assessment-context-v2",
    evalSuite: "understanding-assessment-v4",
  },
  "citation-review": {
    id: "citation-review",
    version: "4.1.1",
    allowedTools: ["submit_result"],
    inputSchemaId: "citation-review-input-v1",
    outputSchemaId: "citation-review-output-v1",
    contextBuilderId: "citation-review-context-v2",
    evalSuite: "citation-review-v5",
  },
  "memory-maintenance": {
    id: "memory-maintenance",
    version: "4.1.0",
    allowedTools: ["submit_result"],
    inputSchemaId: "memory-maintenance-input-v1",
    outputSchemaId: "memory-maintenance-output-v1",
    contextBuilderId: "memory-maintenance-context-v2",
    evalSuite: "memory-maintenance-v5",
  },
  "repository-value-discovery": {
    id: "repository-value-discovery",
    version: "4.12.0",
    allowedTools: [
      "list_repository_components",
      "get_repository_component",
      "query_repository_relations",
      "get_repository_evidence",
      "read_repository_source",
      "search_web",
      "read_web_page",
      "submit_result",
      "get_repository_file_outline",
      "repair_result_text",
    ],
    optionalTools: ["repair_result_text"],
    inputSchemaId: "repository-research-input-v6",
    outputSchemaId: "repository-value-output-v6",
    contextBuilderId: "repository-value-context-v14",
    evalSuite: "repository-value-discovery-v21",
  },
  "snapshot-language-overlay": {
    id: "snapshot-language-overlay",
    version: "1.3.0",
    allowedTools: ["submit_result"],
    inputSchemaId: "snapshot-language-overlay-input-v1",
    outputSchemaId: "snapshot-language-overlay-output-v2",
    contextBuilderId: "snapshot-language-overlay-context-v3",
    evalSuite: "snapshot-language-overlay-v4",
  },
  "learning-route": {
    id: "learning-route",
    version: "4.0.5",
    allowedTools: [
      "list_repository_components",
      "get_repository_component",
      "query_repository_relations",
      "get_repository_evidence",
      "read_repository_source",
      "submit_result",
      "get_repository_file_outline",
    ],
    inputSchemaId: "learning-route-input-v3",
    outputSchemaId: "learning-route-output-v3",
    contextBuilderId: "learning-route-context-v3",
    evalSuite: "learning-route-v5",
  },
  "feedback-analysis": {
    id: "feedback-analysis",
    version: "4.1.0",
    allowedTools: ["submit_result"],
    inputSchemaId: "feedback-analysis-input-v2",
    outputSchemaId: "feedback-analysis-output-v2",
    contextBuilderId: "feedback-analysis-context-v2",
    evalSuite: "feedback-analysis-v5",
  },
  "skill-evolution": {
    id: "skill-evolution",
    version: "3.0.0",
    allowedTools: ["submit_result"],
    inputSchemaId: "skill-evolution-input-v1",
    outputSchemaId: "skill-evolution-output-v1",
    contextBuilderId: "skill-evolution-context-v1",
    evalSuite: "skill-evolution-v4",
  },
};

const cache = new Map<string, Promise<ProductSkill>>();
let publishedSkillRegistryRoot: string | null = null;

function skillDirectory(id: ProductSkillId): string {
  return fileURLToPath(new URL(`../../skills/${id}/`, import.meta.url));
}

async function loadProductSkillFile(
  id: ProductSkillId,
  directory: string,
  version: string,
  published?: { filePath: string; content: string; artifacts: readonly { path: string; content: string }[] },
): Promise<ProductSkill> {
  const metadata = SKILL_METADATA[id];
  const raw = published?.content ?? await readFile(join(directory, "SKILL.md"), "utf8");
  const references = await loadSkillPromptReferences(directory, raw, published?.artifacts);
  const complete = (skill: Skill): ProductSkill => ({
    ...metadata, version,
    // The effective body is shared by prompt sizing, frozen execution and cache identity.
    skill: references ? { ...skill, content: `${skill.content}\n\n${references}` } : skill,
  });
  if (published) {
    return complete(publishedSkill({ name: id, ...published }));
  }
  const env = new NodeExecutionEnv({ cwd: directory });
  try {
    const loaded = await loadSkills(env, directory);
    const skill = loaded.skills.find((candidate) => candidate.name === id);
    if (!skill || loaded.diagnostics.some((diagnostic) => diagnostic.path.endsWith("SKILL.md"))) {
      throw new Error(`skill_not_loadable:${id}`);
    }
    return complete(skill);
  } finally {
    await env.cleanup();
  }
}

export function configureProductSkillRegistry(root: string | null): void {
  const next = root ? resolve(root) : null;
  if (publishedSkillRegistryRoot === next) return;
  publishedSkillRegistryRoot = next;
  cache.clear();
}

export async function loadProductSkill(id: ProductSkillId): Promise<ProductSkill> {
  const published = await resolvePublishedSkillSource(publishedSkillRegistryRoot, id);
  const key = `${id}:${published?.cacheKey ?? `bundled:${SKILL_METADATA[id].version}`}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = loadProductSkillFile(
    id,
    published?.directory ?? skillDirectory(id),
    published?.version ?? SKILL_METADATA[id].version,
    published ?? undefined,
  );
  cache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

export async function skillPrompt(
  id: ProductSkillId,
  additionalInstructions?: string,
  selectedSkill?: ProductSkill,
): Promise<{ productSkill: ProductSkill; prompt: string }> {
  const productSkill = selectedSkill ?? await loadProductSkill(id);
  if (productSkill.id !== id) throw new Error("skill_identity_mismatch");
  return {
    productSkill,
    prompt: formatSkillInvocation(productSkill.skill, additionalInstructions),
  };
}

export function skillMetadata(id: ProductSkillId): Omit<ProductSkill, "skill"> {
  return { ...SKILL_METADATA[id] };
}

export function assertProductSkillRun(
  productSkill: ProductSkill,
  contract: ProductSkillRunContract,
): void {
  const allowed = new Set(productSkill.allowedTools);
  const optional = new Set(productSkill.optionalTools ?? []);
  const actual = new Set(contract.toolNames);
  if ([...actual].some((name) => !allowed.has(name))
    || [...allowed].some((name) => !optional.has(name) && !actual.has(name))) {
    throw new Error(`skill_tool_contract_mismatch:${productSkill.id}`);
  }
  if (productSkill.inputSchemaId !== contract.inputSchemaId) {
    throw new Error(`skill_input_contract_mismatch:${productSkill.id}`);
  }
  if (productSkill.outputSchemaId !== contract.outputSchemaId) {
    throw new Error(`skill_output_contract_mismatch:${productSkill.id}`);
  }
  if (productSkill.contextBuilderId !== contract.contextBuilderId) {
    throw new Error(`skill_context_contract_mismatch:${productSkill.id}`);
  }
}

export function skillRoot(id: ProductSkillId): string {
  return join(skillDirectory(id), "SKILL.md");
}
