import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { ProviderUsageReport } from "./provider-budget.js";
import type { TextRepairStats } from "./text-submission-repair.js";

export interface WorkerDiagnosticIdentity {
  jobId: string;
  jobAttempt: number;
  batchId: string;
}

export interface ProviderRequestDiagnostic {
  sequence: number;
  startedAt: string;
  contextBytes: number;
  gateWaitMs: number;
  budgetWaitMs: number;
  usageEventId: string | null;
  requestStartedAt: string | null;
  firstContentMs: number | null;
  lastContentMs: number | null;
  contentEvents: number;
  durationMs: number;
  status: string;
  completionReason?: string;
  requestLimits?: {
    modelMaxTokens: number;
    wireMaxTokens: number | null;
    // Sent fields, not proof that the provider accepted the requested limit.
    wireTokenLimits?: Partial<Record<"max_tokens" | "max_completion_tokens" | "max_output_tokens", number>>;
  };
  usage: ProviderUsageReport | null;
  transport: Array<{ headersMs: number; status: number | null; errorCode?: string }>;
}

export interface WorkerDiagnostics {
  schemaVersion: "worker-diagnostics-v1";
  identity: WorkerDiagnosticIdentity | null;
  runId: string;
  startedAt: string;
  durationMs: number;
  requestCount: number;
  toolCount: number;
  submitAttempts: number;
  rejectedSubmissions: number;
  submissions: Array<{ attempt: number; bytes: number; errorCategories: string[]; requestSequence?: number }>;
  requests: ProviderRequestDiagnostic[];
  tools: Array<{
    sequence: number; name: string; argumentDigest: string; durationMs: number;
    resultBytes: number; status: string; offset: number | null;
    nextOffset: number | null; itemCount: number | null;
    memberOffset?: number | null; relationOffset?: number | null;
    requestSequence?: number;
    sourcePathDigest?: string;
    sourceStartLine?: number;
    sourceEndLine?: number;
    errorCode?: string;
  }>;
  // Additive fields: older persisted diagnostics do not include SDK dispatch failures.
  toolDispatchCount?: number;
  textRepair?: TextRepairStats;
  toolDispatchErrorCount?: number;
  toolDispatches?: Array<{
    sequence: number; requestSequence: number; name: string;
    executed: boolean; isError: boolean;
    schemaErrors?: Array<{ keyword: string; schemaPath: string }>;
  }>;
  droppedRecords: number;
  peakMemory: { rss: number; heapUsed: number; external: number; arrayBuffers: number };
  resourceScope: "shared_worker_process";
  cpuMs: { user: number; system: number };
}

// Counts only. Never return serialized prompts, tool arguments, source or thinking.
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

// Only schema-owned paths and fixed categories; never instance paths, values or SDK error text.
const SCHEMA_KEYWORDS = new Set(["type", "required", "maxLength", "minLength", "maxItems", "minItems", "maximum", "minimum", "enum", "const", "additionalProperties", "anyOf", "oneOf", "pattern"]);
export function diagnoseToolSchema(schema: TSchema, args: unknown): Array<{ keyword: string; schemaPath: string }> {
  try {
    const paths = new Set<string>();
    const visit = (value: unknown, path: string): void => {
      paths.add(path);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) visit(child, path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"));
      }
    };
    visit(schema, "#");
    // Matches the SDK's TypeBox conversion; diagnostics do not decide whether to execute.
    const converted = Value.Convert(schema, structuredClone(args));
    return [...Compile(schema).Errors(converted)].slice(0, 16).map((error) => ({
      keyword: SCHEMA_KEYWORDS.has(error.keyword) ? error.keyword : "validation",
      schemaPath: paths.has(error.schemaPath) ? error.schemaPath : "#",
    }));
  } catch { return [{ keyword: "validation", schemaPath: "#" }]; }
}

const TOOL_ERROR_CODES = new Set(["source_path_not_exposed", "invalid_source_path", "source_path_outside_snapshot", "source_path_outside_component", "source_offset_out_of_range", "entity_id_required", "entity_ids_required", "entity_outside_worker_scope", "component_outside_worker_scope", "component_not_found", "repository_tool_cancelled"]);

export function createWorkerDiagnostics(identity?: WorkerDiagnosticIdentity) {
  const start = performance.now();
  const cpu = process.cpuUsage();
  const data: WorkerDiagnostics = {
    schemaVersion: "worker-diagnostics-v1", identity: identity ?? null,
    runId: randomUUID(), startedAt: new Date().toISOString(), durationMs: 0,
    requestCount: 0, toolCount: 0, submitAttempts: 0, rejectedSubmissions: 0,
    submissions: [], requests: [], tools: [], droppedRecords: 0,
    toolDispatchCount: 0, toolDispatchErrorCount: 0, toolDispatches: [],
    peakMemory: { rss: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    resourceScope: "shared_worker_process",
    cpuMs: { user: 0, system: 0 },
  };
  const sample = (): void => {
    const memory = process.memoryUsage();
    for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) {
      data.peakMemory[key] = Math.max(data.peakMemory[key], memory[key]);
    }
  };
  sample();
  const timer = setInterval(sample, 1_000);
  timer.unref();
  const keep = <T>(rows: T[], row: T): void => {
    if (rows.length < 512) rows.push(row);
    else data.droppedRecords++;
  };
  const executingCalls = new Set<string>();
  const pendingSchemaErrors = new Map<string, ReturnType<typeof diagnoseToolSchema>>();
  return {
    data,
    toolStarting(callId: string, schema: TSchema, args: unknown): void {
      const errors = diagnoseToolSchema(schema, args);
      if (errors.length) pendingSchemaErrors.set(callId, errors);
    },
    toolExecuting(callId: string): void { executingCalls.add(callId); },
    toolDispatched(callId: string, name: string, isError: boolean, registeredNames: ReadonlySet<string>): void {
      data.toolDispatchCount = (data.toolDispatchCount ?? 0) + 1;
      if (isError) data.toolDispatchErrorCount = (data.toolDispatchErrorCount ?? 0) + 1;
      const executed = executingCalls.delete(callId);
      const schemaErrors = pendingSchemaErrors.get(callId);
      pendingSchemaErrors.delete(callId);
      keep(data.toolDispatches!, {
        sequence: data.toolDispatchCount, requestSequence: data.requestCount,
        // A model can put arbitrary source or secrets in an invented tool name.
        name: registeredNames.has(name) ? name : "unknown_tool",
        executed, isError,
        ...(!executed && isError && schemaErrors?.length ? { schemaErrors } : {}),
      });
    },
    request(context: unknown): ProviderRequestDiagnostic {
      const row: ProviderRequestDiagnostic = {
        sequence: ++data.requestCount, startedAt: new Date().toISOString(),
        contextBytes: jsonByteLength(context), gateWaitMs: 0, budgetWaitMs: 0,
        usageEventId: null, requestStartedAt: null, firstContentMs: null,
        lastContentMs: null, contentEvents: 0,
        durationMs: 0, status: "running", usage: null, transport: [],
      };
      keep(data.requests, row);
      return row;
    },
    submission(value: unknown, errors: string[]): void {
      data.submitAttempts++;
      if (errors.length) data.rejectedSubmissions++;
      keep(data.submissions, {
        attempt: data.submitAttempts, bytes: jsonByteLength(value),
        requestSequence: data.requestCount,
        errorCategories: [...new Set(errors.map((error) => /^[a-z_]+(?=:)/u.exec(error)?.[0] ?? "validation"))],
      });
    },
    wrapTool(tool: AgentTool): AgentTool {
      return { ...tool, execute: async (callId, params, ...rest) => {
        executingCalls.add(callId);
        const started = performance.now();
        const args = params && typeof params === "object" ? params as Record<string, unknown> : {};
        const row: WorkerDiagnostics["tools"][number] = {
          sequence: ++data.toolCount, name: tool.name,
          requestSequence: data.requestCount,
          argumentDigest: createHash("sha256").update(JSON.stringify(params)).digest("hex"),
          durationMs: 0, resultBytes: 0, status: "failed",
          offset: typeof args.offset === "number" ? args.offset : null,
          nextOffset: null, itemCount: null,
          memberOffset: typeof args.member_offset === "number" ? args.member_offset : null,
          relationOffset: typeof args.relation_offset === "number" ? args.relation_offset : null,
        };
        try {
          const value = await tool.execute(callId, params, ...rest);
          row.resultBytes = jsonByteLength(value.content);
          row.status = "completed";
          const text = value.content.find((block) => block.type === "text");
          if (text?.type === "text") {
            try {
              const payload = JSON.parse(text.text) as Record<string, unknown>;
              row.nextOffset = typeof payload.next_offset === "number" ? payload.next_offset : null;
              row.itemCount = Array.isArray(payload.items) ? payload.items.length : null;
              // Correlate pages of the same authorized file without retaining its
              // path, symbols, query text, or source content in normal diagnostics.
              if ((tool.name === "read_repository_source" || tool.name === "get_repository_file_outline")
                && typeof payload.path === "string") {
                row.sourcePathDigest = createHash("sha256").update(payload.path).digest("hex");
                if (typeof payload.start_line === "number") row.sourceStartLine = payload.start_line;
                if (typeof payload.end_line === "number") row.sourceEndLine = payload.end_line;
              }
            } catch { /* Some tools return prose; no content is retained. */ }
          }
          return value;
        } catch (error) {
          const code = error instanceof Error ? error.message.split(":", 1)[0] : "";
          row.errorCode = code && TOOL_ERROR_CODES.has(code) ? code : "tool_execution_failed";
          throw error;
        } finally {
          row.durationMs = performance.now() - started;
          keep(data.tools, row);
          sample();
        }
      } };
    },
    finish(): void {
      clearInterval(timer);
      executingCalls.clear();
      pendingSchemaErrors.clear();
      sample();
      data.durationMs = performance.now() - start;
      const elapsed = process.cpuUsage(cpu);
      data.cpuMs = { user: elapsed.user / 1_000, system: elapsed.system / 1_000 };
    },
  };
}
