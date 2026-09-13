import { randomUUID } from "node:crypto";
import {
  Agent,
  formatSkillInvocation,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { PiModelRuntime, PiUsageSummary } from "./types.js";
import { streamWithProviderPermit } from "./model-runtime.js";
import { runtimeForSkill } from "./role-models.js";
import { DEFAULT_WORKER_MAX_REQUESTS, WorkerExecutionError, workerFailureCode, providerFailureReason, type WorkerFailureCode } from "./worker-failure.js";
import { providerErrorCode } from "./provider-error.js";
import { createWorkerDiagnostics, type WorkerDiagnosticIdentity, type WorkerDiagnostics } from "./worker-diagnostics.js";
import { TEXT_REPAIR_DEFINITION, TEXT_REPAIR_SCHEMA, TEXT_REPAIR_TOOL, TextSubmissionRepair } from "./text-submission-repair.js";
import {
  assertProductSkillRun,
  loadProductSkill,
  type ProductSkillId,
  type ProductSkill,
} from "./skill-registry.js";

export interface StructuredWorkerResult<T> {
  model?: string;
  provider?: string;
  value: T | null;
  usage: PiUsageSummary;
  stopReason: string;
  skillId: ProductSkillId;
  skillVersion: string;
  evalSuite: string;
  validationErrors: string[];
  diagnostics?: WorkerDiagnostics;
}

function usage(messages: readonly unknown[]): PiUsageSummary {
  const result: PiUsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  for (const message of messages) {
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") continue;
    const row = message as AssistantMessage;
    result.inputTokens += row.usage?.input ?? 0;
    result.outputTokens += row.usage?.output ?? 0;
    result.cachedTokens += row.usage?.cacheRead ?? 0;
    result.cacheWriteTokens += row.usage?.cacheWrite ?? 0;
    result.costUsd += row.usage?.cost.total ?? 0;
  }
  return result;
}

export async function runStructuredWorker<T extends TSchema>(options: {
  skillId: ProductSkillId;
  inputSchemaId: string;
  productSkill?: ProductSkill;
  outputSchemaId: string;
  contextBuilderId: string;
  systemPrompt: string;
  userPrompt: string;
  schema: T;
  tools?: AgentTool[];
  modelRuntime: PiModelRuntime;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  validateSubmitted?: (value: Static<T>) => string | readonly string[] | null | undefined;
  maxSubmitAttempts?: number;
  repairTextFields?: readonly string[];
  diagnosticIdentity?: WorkerDiagnosticIdentity;
}): Promise<StructuredWorkerResult<Static<T>>> {
  options = { ...options, modelRuntime: runtimeForSkill(options.modelRuntime, options.skillId) };
  const productSkill = options.productSkill ?? options.modelRuntime.skills?.[options.skillId] ?? await loadProductSkill(options.skillId);
  if (productSkill.id !== options.skillId) throw new Error("skill_identity_mismatch");
  const workerTools = options.tools ?? [];
  const textRepair = options.repairTextFields?.length ? new TextSubmissionRepair(options.schema, options.repairTextFields) : null;
  if (workerTools.some((tool) => tool.name === "submit_result" || (textRepair && tool.name === TEXT_REPAIR_TOOL))) {
    throw new Error("structured_worker_reserved_tool_name");
  }
  assertProductSkillRun(productSkill, {
    toolNames: [...workerTools.map((tool) => tool.name), "submit_result", ...(textRepair ? [TEXT_REPAIR_TOOL] : [])],
    inputSchemaId: options.inputSchemaId,
    outputSchemaId: options.outputSchemaId,
    contextBuilderId: options.contextBuilderId,
  });
  let submitted: Static<T> | null = null;
  let localFailure: WorkerFailureCode | null = null;
  const diagnostics = createWorkerDiagnostics(options.diagnosticIdentity);
  if (textRepair) diagnostics.data.textRepair = textRepair.stats;
  let validationErrors: string[] = [];
  let submitAttempts = 0;
  const maxSubmitAttempts = Math.max(1, Math.floor(options.maxSubmitAttempts ?? 2));
  const accept: AgentTool<T, Record<string, never>>["execute"] = async (toolCallId, params) => {
    diagnostics.toolExecuting(toolCallId);
    submitAttempts += 1;
    let rawErrors: ReturnType<NonNullable<typeof options.validateSubmitted>>;
    try { rawErrors = options.validateSubmitted?.(params); }
    catch {
      localFailure = "worker_internal_error";
      validationErrors = ["worker_internal_error: submission validation failed"];
      diagnostics.submission(params, validationErrors);
      throw new WorkerExecutionError(localFailure);
    }
    const errors = rawErrors
      ? (typeof rawErrors === "string" ? [rawErrors] : [...rawErrors]).filter(Boolean)
      : [];
    validationErrors = errors;
    diagnostics.submission(params, errors);
    if (errors.length && submitAttempts < maxSubmitAttempts) {
      return {
        content: [{
          type: "text",
          text: "提交未通过程序校验：" + errors.join("；")
            + "。请按反馈修正对应对象和字段后再次调用 submit_result；语言或格式问题可直接使用已有材料修正，只有证据不足或不匹配时才补查相关证据；"
            + "不要为了通过校验而删除仍有证据支持的对象。",
        }],
        details: {},
        terminate: false,
      };
    }
    submitted = params;
    return {
      content: [{
        type: "text",
        text: errors.length
          ? "已达到提交重试上限；结果已保留，但仍有校验提示：" + errors.join("；")
          : "结果已接收。",
      }],
      details: {},
      terminate: true,
    };
  };
  const submit: AgentTool<T, Record<string, never>> = {
    name: "submit_result",
    label: "正在提交结构化结果",
    description: "提交最终结果。必须调用这个工具，不要在普通文本中输出 JSON。",
    parameters: options.schema,
    ...(textRepair ? { prepareArguments: (args: unknown) => textRepair.prepare(args) } : {}),
    execute: accept,
  };
  const repairTools: AgentTool<typeof TEXT_REPAIR_SCHEMA>[] = textRepair ? [{
    ...TEXT_REPAIR_DEFINITION,
    label: "正在修正结果中的文本",
    prepareArguments: (args: unknown) => {
      textRepair.stats.attempts++;
      if (textRepair.stats.attempts > 3) throw new Error("已达到文本局部修正次数上限。");
      return args as Static<typeof TEXT_REPAIR_SCHEMA>;
    },
    execute: async (toolCallId, params) => {
      const value = textRepair.apply(params);
      return accept(toolCallId, value);
    },
  }] : [];
  const model = options.modelRuntime.model;
  const agent = new Agent({
    sessionId: "worker-" + randomUUID(),
    toolExecution: "parallel",
    streamFn: async (candidate, context, streamOptions) => {
      try {
        options.signal?.throwIfAborted();
        if (options.modelRuntime.beforeWorkerRequest) await options.modelRuntime.beforeWorkerRequest(options.diagnosticIdentity);
        else if (["component-explanation", "architecture-planning", "repository-value-discovery", "snapshot-language-overlay"].includes(options.skillId)
          && diagnostics.data.requestCount >= DEFAULT_WORKER_MAX_REQUESTS) throw new WorkerExecutionError("analysis_batch_call_limit_exceeded");
      } catch (error) {
        localFailure = workerFailureCode(error) ?? workerFailureCode(options.signal?.reason)
          ?? (options.signal?.aborted ? null : "worker_internal_error");
        throw localFailure ? new WorkerExecutionError(localFailure) : new Error("worker_cancelled");
      }
      return streamWithProviderPermit(options.modelRuntime, candidate as typeof model, context, {
        ...streamOptions,
        ...(options.modelRuntime.networkTimeoutMs ? { timeoutMs: options.modelRuntime.networkTimeoutMs } : {}),
      }, diagnostics.request(context));
    },
    getApiKey: () => options.modelRuntime.apiKey,
    shouldStopAfterTurn: () => {
      if (textRepair?.pending && textRepair.stats.attempts >= 3) textRepair.stats.exhausted = true;
      return localFailure !== null || submitted !== null || textRepair?.stats.exhausted === true;
    },
    initialState: {
      systemPrompt: formatSkillInvocation(productSkill.skill, options.systemPrompt),
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      messages: [],
      tools: [...workerTools, ...repairTools].map((tool) => diagnostics.wrapTool(tool)).concat(submit),
    },
  });
  const registeredToolNames = new Set([...workerTools, ...repairTools, submit].map((tool) => tool.name));
  const registeredSchemas = new Map([...workerTools, ...repairTools, submit].map((tool) => [tool.name, tool.parameters]));
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      const schema = registeredSchemas.get(event.toolName);
      if (schema) diagnostics.toolStarting(event.toolCallId, schema, event.args);
    }
    if (event.type === "tool_execution_end") {
      // SDK argument validation runs before execute(), outside the existing wrappers.
      diagnostics.toolDispatched(event.toolCallId, event.toolName, event.isError, registeredToolNames);
    }
  });
  const repairMessage: AgentMessage = {
    role: "user",
    content: [{
      type: "text",
      text: textRepair
        ? "如果工具已经反馈保存了修正草稿，请按最新反馈调用repair_result_text；否则请调用submit_result。不要在普通文本中输出JSON。"
        : "如果尚未提交结果，请现在调用 submit_result，并按工具 Schema 修正参数；不要在普通文本中输出 JSON。",
    }],
    timestamp: Date.now(),
  };
  agent.followUp(repairMessage);
  const abort = (): void => agent.abort();
  if (!options.signal?.aborted) options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) {
      return {
        value: null,
        usage: usage(agent.state.messages),
        stopReason: workerFailureCode(options.signal.reason) ?? "cancelled",
        skillId: productSkill.id,
        model: model.id, provider: model.provider,
        skillVersion: productSkill.version,
        evalSuite: productSkill.evalSuite,
        validationErrors,
        diagnostics: diagnostics.data,
      };
    }
    await agent.prompt(options.userPrompt);
    const finalAssistant = [...agent.state.messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    const providerFailed = finalAssistant?.stopReason === "error";
    const providerAborted = finalAssistant?.stopReason === "aborted";
    const lastRequest = diagnostics.data.requests.at(-1);
    const providerCause = providerErrorCode([
      finalAssistant?.errorMessage, lastRequest?.transport.at(-1)?.status, lastRequest?.transport.at(-1)?.errorCode,
    ].filter(Boolean).join(" "));
    const providerFailure = providerFailureReason(lastRequest?.transport, finalAssistant?.errorMessage);
    const failure = localFailure ?? workerFailureCode(options.signal?.reason)
      ?? (lastRequest?.status === "budget_rejected" ? providerCause
        : lastRequest?.status === "gate_error" ? "worker_internal_error" : null);
    return {
      value: failure ? null : submitted,
      usage: usage(agent.state.messages),
      stopReason: failure ?? (submitted
        ? validationErrors.length ? "completed_with_validation_errors" : "completed"
        : textRepair?.stats.exhausted
          ? "text_repair_exhausted"
          : options.signal?.aborted
          ? "cancelled"
          : providerFailed || providerAborted
            ? providerCause === "provider_request_failed" ? providerFailure : `${providerFailure}:${providerCause}`
            : "structured_output_missing"),
      skillId: productSkill.id,
      model: model.id, provider: model.provider,
      skillVersion: productSkill.version,
      evalSuite: productSkill.evalSuite,
      validationErrors,
      diagnostics: diagnostics.data,
    };
  } catch (error) {
    return {
      value: null,
      usage: usage(agent.state.messages),
      stopReason: localFailure ?? workerFailureCode(options.signal?.reason) ?? workerFailureCode(error)
        ?? (options.signal?.aborted ? "cancelled" : "worker_internal_error"),
      skillId: productSkill.id,
      model: model.id, provider: model.provider,
      skillVersion: productSkill.version,
      evalSuite: productSkill.evalSuite,
      validationErrors,
      diagnostics: diagnostics.data,
    };
  } finally {
    unsubscribe();
    diagnostics.finish();
    options.signal?.removeEventListener("abort", abort);
  }
}
