import type { PiRunDisplay, PiRunEvent } from "./types.js";

const MAX_LABEL_LENGTH = 120;
const MAX_TEXT_LENGTH = 360;
function clean(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function label(value: string, fallback: string): string {
  return clean(value, MAX_LABEL_LENGTH) || fallback;
}

function toolLabel(summary: string): string {
  return label(
    summary
      .replace(/^正在\s*/u, "")
      .replace(/^已完成\s*/u, "")
      .replace(/^已收到\s*/u, ""),
    "项目查询",
  );
}

function modelStage(summary: string): { stage: string; text: string } {
  if (summary.includes("较早对话")) {
    return {
      stage: "context",
      text: "上下文较长，我先保留已确认事实和工具结果，再继续回答。",
    };
  }
  if (summary.includes("组织回答")) {
    return {
      stage: "planning",
      text: "我先整理问题目标和已有上下文，再决定下一步。",
    };
  }
  return {
    stage: "reasoning",
    text: "正在梳理解决路径，稍后会用可验证证据核对判断。",
  };
}

type PiRunEventType = PiRunEvent["type"];

const LEGACY_EVENT_TYPES: Record<string, PiRunEventType> = {
  capacity_waiting: 'capacity_waiting',
  run_started: "run_started",
  model_started: "model_started",
  model_completed: "model_started",
  assistant_delta: "assistant_delta",
  tool_call_requested: "tool_call_requested",
  tool_started: "tool_call_requested",
  tool_result_received: "tool_result_received",
  tool_completed: "tool_result_received",
  usage_updated: "usage_updated",
  run_completed: "run_completed",
  run_failed: "run_failed",
  run_paused: "run_paused",
  run_cancelled: "run_cancelled",
  thinking_started: "thinking_started",
  thinking_completed: "thinking_completed",
  turn_completed: "turn_completed",
  answer_started: "answer_started",
  assistant_commentary: "assistant_commentary",
  commentary: "assistant_commentary",
};

function recordEventType(record: Record<string, unknown>): PiRunEventType | null {
  for (const candidate of [record.type, record.stage, record.event_type]) {
    if (typeof candidate !== "string" || candidate === "run_event") continue;
    const normalized = LEGACY_EVENT_TYPES[candidate];
    if (normalized) return normalized;
  }
  return null;
}

/** Keep replay labels deterministic and independent of arbitrary persisted text. */
function replaySummary(type: PiRunEventType, record: Record<string, unknown>): string {
  if (type === "run_failed" && record.error_code === "session_busy") return "上一轮仍在处理";
  if (type === "run_paused") return "已暂停，可继续提问";
  if (type === "run_cancelled") return "已取消";
  if (type === "run_failed") return "本轮运行未完成";
  if (type === "run_started") return "正在理解问题";
  if (type === "model_started") {
    return record.display_stage === "context" ? "正在整理较早对话" : "正在组织回答";
  }
  if (type === "thinking_started") return "正在整理思路";
  if (type === "thinking_completed") return "思路整理完成";
  if (type === "turn_completed") return "当前步骤已完成";
  if (type === "assistant_commentary") return "中间说明";
  if (type === "tool_call_requested") return "正在查询项目证据";
  if (type === "tool_result_received") return record.tool_error === true ? "工具未完成，正在调整查询" : "已完成工具调用";
  if (type === "answer_started" || type === "assistant_delta") return "正在生成回答";
  if (type === "usage_updated") return "已更新用量";
  if (type === "run_completed") return "已完成";
  return "正在处理当前回答";
}

/** Convert a runtime event to bounded, user-visible metadata. */
export function displayForEvent(input: {
  type: PiRunEvent["type"];
  summary: string;
  toolName?: string;
  isError?: boolean;
  errorCode?: string;
  text?: string;
}): PiRunDisplay {
  const safeLabel = label(input.summary, "正在处理");
  switch (input.type) {
    case 'capacity_waiting':
      return { kind: 'summary', stage: 'capacity_waiting', label: '服务器繁忙，正在等待处理…', status: 'running', visible: true };
    case "run_started":
      return {
        kind: "summary",
        stage: "understanding",
        label: safeLabel,
        text: "我先确认问题范围，并判断是否需要查询项目证据。",
        status: "running",
        visible: true,
      };
    case "model_started": {
      const phase = modelStage(input.summary);
      return {
        kind: "summary",
        stage: phase.stage,
        label: safeLabel,
        text: phase.text,
        status: "running",
        visible: true,
      };
    }
    case "thinking_started":
      return {
        kind: "summary",
        stage: "reasoning",
        label: safeLabel,
        text: "正在梳理可能的解决路径，下面会继续核对仓库证据。",
        status: "running",
        visible: true,
      };
    case "thinking_completed":
      return {
        kind: "commentary",
        stage: "reasoning",
        label: safeLabel,
        text: "思路整理完成，下面继续核对代码证据并组织回答。",
        status: "completed",
        visible: true,
      };
    case "turn_completed":
      return {
        kind: "commentary",
        stage: "turn",
        label: safeLabel,
        text: "已经收到当前步骤的结果，接下来结合证据继续判断。",
        status: "completed",
        visible: true,
      };
    case "assistant_commentary": {
      const text = clean(input.text ?? "", MAX_TEXT_LENGTH);
      return {
        kind: "commentary",
        stage: "reasoning",
        label: "中间说明",
        text: text || "已经整理好一段中间说明，下面继续核对代码证据。",
        status: "completed",
        visible: true,
      };
    }
    case "tool_call_requested": {
      const name = input.toolName ? clean(input.toolName, MAX_LABEL_LENGTH) : undefined;
      const readable = toolLabel(input.summary);
      return {
        kind: "tool",
        stage: "tool",
        label: safeLabel,
        text: `准备调用“${readable}”，获取与问题相关的只读证据。`,
        ...(name ? { toolName: name } : {}),
        status: "running",
        visible: true,
      };
    }
    case "tool_result_received": {
      const name = input.toolName ? clean(input.toolName, MAX_LABEL_LENGTH) : undefined;
      const readable = toolLabel(input.summary);
      return {
        kind: "tool",
        stage: "tool",
        label: safeLabel,
        text: input.isError
          ? `“${readable}”没有完成，正在调整查询方向。`
          : `已收到“${readable}”的结果，下面结合证据继续判断。`,
        ...(name ? { toolName: name } : {}),
        status: input.isError ? "failed" : "completed",
        visible: true,
      };
    }
    case "answer_started":
      return {
        kind: "summary",
        stage: "answer",
        label: safeLabel,
        text: "已经找到回答入口，下面整理成可以直接阅读的结论。",
        status: "running",
        visible: true,
      };
    case "assistant_delta":
      return {
        kind: "answer",
        stage: "answer",
        label: safeLabel,
        status: "running",
        visible: false,
      };
    case "usage_updated":
      return {
        kind: "answer",
        stage: "usage",
        label: safeLabel,
        status: "completed",
        visible: false,
      };
    case "run_completed":
      return {
        kind: "answer",
        stage: "completion",
        label: safeLabel,
        status: "completed",
        visible: false,
      };
    case "run_paused":
      return {
        kind: "summary",
        stage: "paused",
        label: safeLabel,
        text: "本轮已暂停，已经完成的查询结果会保留。",
        status: "paused",
        visible: true,
      };
    case "run_cancelled":
      return {
        kind: "summary",
        stage: "cancelled",
        label: safeLabel,
        text: "本轮已取消，不会把未完成的回答当作最终结论。",
        status: "cancelled",
        visible: true,
      };
    case "run_failed":
      return {
        kind: "summary",
        stage: "failed",
        label: safeLabel,
        text: input.errorCode === "session_busy"
          ? "上一轮仍在处理，当前回答没有启动新的模型调用。"
          : "这一步没有完成，当前回答不会把未经确认的内容当作结论。",
        status: "failed",
        visible: true,
      };
    default:
      return {
        kind: "commentary",
        stage: "runtime",
        label: safeLabel,
        text: "正在处理当前回答。",
        status: "completed",
        visible: true,
      };
  }
}

export function isPiRunEventType(value: unknown): value is PiRunEvent["type"] {
  return typeof value === "string" && [
    "capacity_waiting",
    "run_started",
    "model_started",
    "assistant_delta",
    "tool_call_requested",
    "tool_result_received",
    "usage_updated",
    "run_completed",
    "run_failed",
    "run_paused",
    "run_cancelled",
    "thinking_started",
    "thinking_completed",
    "turn_completed",
    "answer_started",
    "assistant_commentary",
  ].includes(value);
}

/**
 * Normalize a persisted trace row. Older rows only contain `stage` and
 * `label`; they are mapped to the same fixed summaries without trusting any
 * arbitrary `text` field as model output.
 */
export function displayFromRecord(record: Record<string, unknown>): PiRunDisplay | null {
  const rawType = recordEventType(record);
  if (!rawType) return null;
  return displayForEvent({
    type: rawType,
    summary: replaySummary(rawType, record),
    toolName: typeof record.tool_name === "string" ? record.tool_name : undefined,
    isError: record.isError === true || record.tool_error === true,
    errorCode: typeof record.error_code === "string" ? record.error_code : undefined,
    // Only an explicitly classified commentary event may carry display text
    // through replay. Labels/text on all other legacy rows are untrusted.
    text: rawType === "assistant_commentary" && typeof record.text === "string"
      ? record.text
      : undefined,
  });
}
