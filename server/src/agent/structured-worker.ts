import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { PiModelRuntime, PiUsageSummary, WorkerRequestAllowance } from "./types.js";
import { streamWithProviderPermit } from "./model-runtime.js";
import { runtimeForSkill } from "./role-models.js";
import { DEFAULT_WORKER_MAX_REQUESTS, WorkerExecutionError, workerFailureCode, providerFailureReason, type WorkerFailureCode } from "./worker-failure.js";
import { providerErrorCode } from "./provider-error.js";
import { createWorkerDiagnostics, type WorkerDiagnosticIdentity, type WorkerDiagnostics } from "./worker-diagnostics.js";
import { TEXT_REPAIR_DEFINITION, TEXT_REPAIR_SCHEMA, TEXT_REPAIR_TOOL, TextSubmissionRepair } from "./text-submission-repair.js";
import { workerRequestContext } from "./worker-request-context.js";
import {
  assertProductSkillRun,
  formatProductSkillInvocation,
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

type ExplorationPhase = "explore" | "converge" | "submit";

function explorationPhase(remaining: number): ExplorationPhase {
  return remaining <= 4 ? "submit" : remaining <= 10 ? "converge" : "explore";
}

function phaseInstruction(phase: ExplorationPhase, remaining: number): string {
  const budget = `本批次或整个任务最多还可进行 ${remaining} 次模型请求（含本次）。上限是保护措施，不是探索目标；证据足够时立即提交。`;
  if (phase === "submit") return `${budget}\n现在进入提交修正阶段。只用已有且已核实的候选、组件和证据 ID 调用 submit_result；可用 repair_result_text 局部修正，或 get_repository_evidence 确认已有 ID。不要开始新研究。若证据不足，按现有未核实规则处理，不编造证据。提交校验反馈后只修对应字段并再次提交。`;
  if (phase === "converge") return `${budget}\n现在收敛候选：核实已有候选的关键机制、证据和边界，完成 official_design_review，准备提交；不要开启新的研究方向或广泛检索。证据足够时立即调用 submit_result，按校验反馈局部修正。`;
  return `${budget}\n逐步探索并维护可提交的候选；证据足够时立即调用 submit_result，不必用完额度。`;
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
  /** Teaching/review tasks only; overrides may lower but never raise the default bounds. */
  taskLimits?: { maxRequests?: number; timeoutMs?: number };
  repairTextFields?: readonly string[];
  diagnosticIdentity?: WorkerDiagnosticIdentity;
  /** Explicit opt-in for bounded exploration; only value discovery enables it. */
  explorationEndgame?: { evidenceToolName: string };
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
  let phase: ExplorationPhase = "explore";
  const toolAllowed = (name: string): boolean => !options.explorationEndgame || phase !== "submit"
    || name === options.explorationEndgame.evidenceToolName;
  const guardedTools = workerTools.map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
    if (!toolAllowed(tool.name)) return {
      content: [{ type: "text" as const, text: "收尾阶段请提交或修正已有结果；当前探索工具不可用。" }],
      details: {},
    };
    return tool.execute(...args);
  } }));
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
  const boundedTask = ["learning-route", "understanding-assessment", "citation-review"].includes(options.skillId);
  const maxRequests = Math.max(1, Math.min(6, options.taskLimits?.maxRequests ?? 6));
  const timeoutMs = Math.max(1, Math.min(120_000, options.taskLimits?.timeoutMs ?? 120_000));
  const externalSignal = options.signal;
  const taskController = boundedTask ? new AbortController() : null;
  const forwardAbort = () => taskController?.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardAbort();
  else if (taskController) externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  if (taskController) options = { ...options, signal: taskController.signal };
  const timer = taskController ? setTimeout(() => taskController.abort(new WorkerExecutionError("worker_time_limit_exceeded")), timeoutMs) : null;
  timer?.unref();
  const appendRequestContext = workerRequestContext();
  const agent = new Agent({
    sessionId: "worker-" + randomUUID(),
    toolExecution: "parallel",
    streamFn: async (candidate, context, streamOptions) => {
      try {
        options.signal?.throwIfAborted();
        if (boundedTask && diagnostics.data.requestCount >= maxRequests) throw new WorkerExecutionError("worker_call_limit_exceeded");
        if (options.explorationEndgame && diagnostics.data.requestCount >= DEFAULT_WORKER_MAX_REQUESTS)
          throw new WorkerExecutionError("analysis_batch_call_limit_exceeded");
        const allowance: void | WorkerRequestAllowance = await options.modelRuntime.beforeWorkerRequest?.(options.diagnosticIdentity);
        if ((!options.modelRuntime.beforeWorkerRequest || (options.explorationEndgame && !allowance))
          && ["component-explanation", "architecture-planning", "repository-value-discovery", "snapshot-language-overlay"].includes(options.skillId)
          && diagnostics.data.requestCount >= DEFAULT_WORKER_MAX_REQUESTS) throw new WorkerExecutionError("analysis_batch_call_limit_exceeded");
        if (options.explorationEndgame) {
          const remaining = allowance
            ? Math.min(allowance.batchRemaining, allowance.jobRemaining, DEFAULT_WORKER_MAX_REQUESTS - diagnostics.data.requestCount)
            : DEFAULT_WORKER_MAX_REQUESTS - diagnostics.data.requestCount;
          phase = explorationPhase(remaining);
          const requestContext = appendRequestContext(context, phaseInstruction(phase, remaining));
          const request = diagnostics.request(requestContext);
          request.phase = phase;
          request.remaining = remaining;
          return streamWithProviderPermit(options.modelRuntime, candidate as typeof model, requestContext, {
            ...streamOptions,
            ...(options.modelRuntime.networkTimeoutMs ? { timeoutMs: options.modelRuntime.networkTimeoutMs } : {}),
          }, request);
        }
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
      systemPrompt: formatProductSkillInvocation(productSkill, options.systemPrompt),
      model,
      thinkingLevel: options.thinkingLevel ?? "medium",
      messages: [],
      tools: [...guardedTools, ...repairTools].map((tool) => diagnostics.wrapTool(tool)).concat(submit),
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
    if (timer) clearTimeout(timer);
    if (taskController) externalSignal?.removeEventListener("abort", forwardAbort);
    unsubscribe();
    diagnostics.finish();
    options.signal?.removeEventListener("abort", abort);
  }
}
