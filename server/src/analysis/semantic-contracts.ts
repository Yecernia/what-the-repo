/** Shared result contracts, language checks and architecture limits. */
import { Type, type Static } from "typebox";
import { displayLanguageLabel, languageHasNaturalText } from "../domain/display-language.js";
import { type SemanticBatchRecorder } from "../domain/semantic-batch.js";
import { type HierarchyOperation } from "./hierarchy.js";
import type { WebSearchAttempt, WebPageAttempt } from "../agent/web-research-tools.js";
import type { AnalysisProgressReporter } from "./progress.js";

export const COMPONENT_PATCH = Type.Object({
  component_id: Type.String({ maxLength: 256 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  responsibility: Type.String({ minLength: 1, maxLength: 400 }),
  layer_name: Type.String({ minLength: 1, maxLength: 80 }),
  grouping_rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  layer_rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});

export const MAX_ARCHITECTURE_LAYERS = 12;
export const TARGET_SECOND_LEVEL_ITEMS = 12;
export const MAX_SECOND_LEVEL_ITEMS = 18;
export const MAX_COMPONENTS_PER_SCOPE = 18;

export const RESPONSIBILITY_SCOPE = Type.Object({
  scope_id: Type.String({ minLength: 1, maxLength: 80 }),
  layer_group_id: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  responsibility: Type.String({ minLength: 1, maxLength: 400 }),
  rationale: Type.String({ minLength: 1, maxLength: 500 }),
  component_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 2, maxItems: MAX_COMPONENTS_PER_SCOPE }),
  evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 24 }),
});

// Both worker tools expose plain object schemas for compatible Providers.
// Component explanation does not request layer plans or unused hierarchy operations.
export const COMPONENT_WORKER_RESULT = Type.Object({
  mode: Type.Literal("components"),
  components: Type.Array(COMPONENT_PATCH, { maxItems: 40 }),
});

// A complete global assignment does not need each partial batch to guess layers.
export const COMPONENT_FACT_PATCH = Type.Omit(COMPONENT_PATCH, ["layer_name", "layer_rationale"]);
export const COMPONENT_FACT_RESULT = Type.Object({
  mode: Type.Literal("components"),
  components: Type.Array(COMPONENT_FACT_PATCH, { maxItems: 40 }),
});
export type ComponentFactResult = Static<typeof COMPONENT_FACT_RESULT>;

export const MAX_COMPONENT_REASSIGNMENTS = 16;
export const MAX_SCOPE_MODEL_COMPONENTS = 96;

export const LAYER_WORKER_RESULT = Type.Object({
  mode: Type.Literal("layers"),
  groups: Type.Array(Type.Object({
    group_id: Type.String({ minLength: 1, maxLength: 80 }),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    responsibility: Type.String({ minLength: 1, maxLength: 400 }),
    rationale: Type.String({ minLength: 1, maxLength: 500 }),
  }), { minItems: 1, maxItems: MAX_ARCHITECTURE_LAYERS }),
  mappings: Type.Array(Type.Object({
    candidate_id: Type.String({ minLength: 1, maxLength: 256 }),
    group_id: Type.String({ minLength: 1, maxLength: 80 }),
  }), { minItems: 1, maxItems: MAX_SCOPE_MODEL_COMPONENTS }),
  component_reassignments: Type.Array(Type.Object({
    component_id: Type.String({ minLength: 1, maxLength: 256 }),
    group_id: Type.String({ minLength: 1, maxLength: 80 }),
    rationale: Type.String({ minLength: 1, maxLength: 500 }),
    evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 24 }),
  }), { maxItems: MAX_COMPONENT_REASSIGNMENTS }),
  scopes: Type.Array(RESPONSIBILITY_SCOPE, { maxItems: 64 }),
  direct_component_ids: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 160 }),
});

export type LayerWorkerResult = Static<typeof LAYER_WORKER_RESULT>;

// Nesting expresses ownership once; IDs and cross-references are assembled by code.
export const GLOBAL_LAYER_RESULT = Type.Object({
  mode: Type.Literal("layers"),
  layers: Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 80 }),
    responsibility: Type.String({ minLength: 1, maxLength: 400 }),
    rationale: Type.String({ minLength: 1, maxLength: 500 }),
    scopes: Type.Array(Type.Omit(RESPONSIBILITY_SCOPE, ["scope_id", "layer_group_id"]), { maxItems: 64 }),
    direct_component_ids: Type.Array(Type.String({ maxLength: 256 }), { maxItems: MAX_SCOPE_MODEL_COMPONENTS }),
  }), { minItems: 1, maxItems: MAX_ARCHITECTURE_LAYERS }),
});
export type GlobalLayerResult = Static<typeof GLOBAL_LAYER_RESULT>;

// Value prose is read in a scrolling detail panel. This is an output safety
// ceiling, not an editorial target: ordinary English paragraphs must not cause
// another model call merely to hit a presentation-length target.
export const VALUE_BODY_MAX_LENGTH = 4_000;

export const VALUE_DISCOVERY_RESULT = Type.Object({
  official_design_review: Type.Object({
    candidates: Type.Array(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 160 }),
      source: Type.String({ minLength: 1, maxLength: 500, description: "The supplied official URL or repository documentation path naming this design." }),
      decision: Type.Union([Type.Literal("included"), Type.Literal("excluded"), Type.Literal("unverified")]),
      selected_title: Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()], { description: "Exact final value-point title if included (including a merged/narrowed point); otherwise null." }),
      reason: Type.String({ minLength: 1, maxLength: 800, description: "Current-code verification outcome and why this decision follows. State limits; do not silently omit a central official design." }),
      evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 12 }),
    }), { maxItems: 8 }),
    no_candidates_reason: Type.String({ maxLength: 800, description: "Explain why no representative official design was found when candidates is empty; otherwise use an empty string." }),
  }),
  value_points: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 120 }),
    claim: Type.String({ minLength: 1, maxLength: VALUE_BODY_MAX_LENGTH, description: "用一个简洁完整的句子说清已证实的设计主张；细节放implementation。" }),
    problem: Type.String({ minLength: 1, maxLength: VALUE_BODY_MAX_LENGTH, description: "简述这个设计解决的具体问题，不重复结论或实现。" }),
    implementation: Type.String({ minLength: 1, maxLength: VALUE_BODY_MAX_LENGTH, description: "用短段落说明关键机制与必要边界；保留因果关系，不罗列所有标识或复述整段源码。" }),
    tradeoffs: Type.String({ minLength: 1, maxLength: VALUE_BODY_MAX_LENGTH, description: "简述有依据的成本、限制或替代方案取舍。" }),
    transfer_conditions: Type.String({ minLength: 1, maxLength: VALUE_BODY_MAX_LENGTH, description: "简述迁移所需的前提，不重复实现方式。" }),
    component_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 8 }),
    evidence_ids: Type.Array(Type.String({ maxLength: 256 }), { minItems: 1, maxItems: 12 }),
  }), { maxItems: 8 }),
});

export type ComponentWorkerResult = Static<typeof COMPONENT_WORKER_RESULT>;

export type ComponentPatch = Static<typeof COMPONENT_FACT_PATCH> & {
  layer_name?: string;
  layer_rationale?: string;
  layer_responsibility?: string;
  layer_group_rationale?: string;
};

export interface ArchitectureSemanticResult {
  components: ComponentPatch[];
  operations?: HierarchyOperation[];
  scopes?: ResponsibilityScopePatch[];
  direct_component_ids?: string[];
}

export interface ResponsibilityScopePatch {
  name: string;
  responsibility: string;
  grouping_rationale: string;
  component_ids: string[];
  evidence_ids: string[];
}

// Historical results and pure snapshot assembly need only value_points. Fresh
// Agent submissions use the full schema above and must include the review.
export type ValueDiscoveryResult = Pick<Static<typeof VALUE_DISCOVERY_RESULT>, "value_points">
  & Partial<Pick<Static<typeof VALUE_DISCOVERY_RESULT>, "official_design_review">>;

export type SemanticResult = ArchitectureSemanticResult & ValueDiscoveryResult;

export interface SemanticWorkerRun {
  model?: string;
  provider?: string;
  skill_id: "component-explanation" | "architecture-planning" | "repository-value-discovery";
  skill_version: string;
  stop_reason: string;
  eval_suite: string;
  display_language?: string;
  validation_errors?: string[];
  mode?: "components" | "layers" | "value_discovery";
  batch_id?: string;
  requested_component_count?: number;
  covered_component_count?: number;
  tools_used?: string[];
  web_searches?: WebSearchAttempt[];
  web_page_reads?: WebPageAttempt[];
  scope_input_omitted_count?: number;
  component_reassignment_count?: number;
  scope_postprocessing?: { proposed: number; accepted: number; rejected: number; fallback: number; direct: number };
  layer_input_budget?: { contextWindow: number; estimatedInputTokens: number; reservedOutputTokens: number; reservedToolTokens: number; fits: boolean; initialCandidateCount: number; directGlobal: boolean };
  evidence_preparation?: { duration_ms: number; read_count: number; bytes: number; unavailable_count: number };
  layer_assignment_mode?: "components" | "candidates";
  component_catalog?: { mode: "complete" | "tools"; total: number; supplied: number };
}

export interface LayerCandidate {
  id: string;
  name: string;
  responsibility: string;
  rationale: string;
  componentIds: string[];
}

export interface WorkerScopeProposal extends ResponsibilityScopePatch {
  layerGroupId: string;
}

export const ARCHITECTURE_BATCH_SIZE = 32;

export const ARCHITECTURE_REPAIR_BATCH_SIZE = 20;

export const MAX_REPAIR_MISSING_RATIO = 0.25;

export const MAX_REPAIR_COMPONENTS = 96;

export const LAYER_BATCH_SIZE = 32;

export const MAX_LAYER_ROUNDS = 6;


export interface SemanticBatchContext {
  recorder: SemanticBatchRecorder;
  jobId: string;
  jobAttempt?: number;
  onProgress?: AnalysisProgressReporter;
  batchProgress?: { start: () => Promise<void>; complete: (reused: boolean) => Promise<void> };
}

export function invalidNaturalTextFields(
  fields: Array<[string, unknown]>,
  language: string,
  required: Set<string>,
): string[] {
  const invalid: string[] = [];
  for (const [field, value] of fields) {
    // Optional rationale fields may be omitted or represented as null by an
    // OpenAI-compatible structured-output adapter. That is not a language
    // failure; only actual text is checked for the requested display language.
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
      if (required.has(field)) invalid.push(field + " 缺失");
      continue;
    }
    if (typeof value !== "string" || !languageHasNaturalText(value, language)) invalid.push(field);
  }
  return invalid;
}

export function componentLanguageError(patch: ComponentPatch, language: string): string | null {
  const fields = invalidNaturalTextFields([
    ["name", patch.name],
    ["responsibility", patch.responsibility],
    ["layer_name", patch.layer_name],
    ["grouping_rationale", patch.grouping_rationale],
    ["layer_rationale", patch.layer_rationale],
  ], language, new Set(["name", "responsibility", ...(patch.layer_name === undefined ? [] : ["layer_name"])]));
  return fields.length
    ? "字段 " + fields.join(", ") + " 没有使用" + displayLanguageLabel(language)
    + "；请保留代码标识，但把解释改写成用户语言。"
    : null;
}

export function layerLanguageError(
  group: { name: string; responsibility: string; rationale: string },
  language: string,
): string | null {
  const fields = invalidNaturalTextFields([
    ["name", group.name],
    ["responsibility", group.responsibility],
    ["rationale", group.rationale],
  ], language, new Set(["name", "responsibility", "rationale"]));
  return fields.length
    ? "字段 " + fields.join(", ") + " 没有使用" + displayLanguageLabel(language)
    + "；请保留代码标识，但把解释改写成用户语言。"
    : null;
}

export function scopeLanguageError(
  scope: { name: string; responsibility: string; rationale: string },
  language: string,
): string | null {
  const fields = invalidNaturalTextFields([
    ["scope.name", scope.name],
    ["scope.responsibility", scope.responsibility],
    ["scope.rationale", scope.rationale],
  ], language, new Set(["scope.name", "scope.responsibility", "scope.rationale"]));
  return fields.length
    ? "字段 " + fields.join(", ") + " 没有使用" + displayLanguageLabel(language)
    + "；请保留代码标识，但把职责范围解释改写成用户语言。"
    : null;
}

export function valueLanguageError(
  point: ValueDiscoveryResult["value_points"][number],
  language: string,
): string | null {
  const fields = [
    ["title", point.title],
    ["claim", point.claim],
    ["problem", point.problem],
    ["implementation", point.implementation],
    ["tradeoffs", point.tradeoffs],
    ["transfer_conditions", point.transfer_conditions],
  ].filter(([, value]) => !languageHasNaturalText(value, language))
    .map(([field]) => field);
  return fields.length
    ? "字段 " + fields.join(", ") + " 没有使用" + displayLanguageLabel(language)
    + "；请保留路径和符号原文，但把自然语言改写成用户语言。"
    : null;
}

export function scopeNameIsPlaceholder(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return !normalized
    || /^(?:cluster|group|scope|other|misc|unknown)(?:\s*[-_a-z0-9]+)?$/iu.test(normalized)
    || /^(?:其他|其它|其余|未分层|未分类|未知|职责范围)(?:\s*[-_a-z0-9一二三四五六七八九十]+)?$/u.test(normalized);
}
