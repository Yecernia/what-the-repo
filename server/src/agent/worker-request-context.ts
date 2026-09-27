import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/pi-ai";

/** Preserve request-only annotations even when the SDK copies its original history. */
export function workerRequestContext(): (context: Context, instruction: string) => Context {
  let originalPrefix: string[] = [];
  const annotations = new Map<number, string>();
  return (context, instruction) => {
    const original = context.messages.map(message => createHash("sha256").update(JSON.stringify(message)).digest("hex"));
    if (originalPrefix.some((message, index) => original[index] !== message)) {
      throw new Error("worker_request_history_changed");
    }
    const messages = [...context.messages];
    const latest = messages.at(-1);
    // Never fabricate a tool result or insert a user turn into a tool continuation.
    if (messages.length <= originalPrefix.length || !latest || (latest.role !== "user" && latest.role !== "toolResult")) {
      throw new Error("worker_request_context_requires_new_tail");
    }
    annotations.set(messages.length - 1, `[程序请求上下文]\n${instruction}\n[/程序请求上下文]`);
    for (const [index, text] of annotations) {
      const message = messages[index];
      if (message.role !== "user" && message.role !== "toolResult") throw new Error("worker_request_history_changed");
      const content = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      messages[index] = { ...message, content: [...content, { type: "text", text }] };
    }
    originalPrefix = original;
    return { ...context, messages };
  };
}
