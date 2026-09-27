import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PiAgentRunOptions, PiModelRuntime } from "./types.js";

export type ReplayConfiguration = Pick<PiAgentRunOptions, "systemPrompt" | "tools" | "thinkingLevel">;

/** No credentials or endpoint strings are persisted in the replay marker. */
export function replayScope(runtime: PiModelRuntime, configuration?: ReplayConfiguration): string {
  const { provider, api, id, baseUrl } = runtime.model;
  return createHash("sha256").update(JSON.stringify({
    version: 1, provider, api, id, baseUrl, connection: runtime.providerConnectionId ?? null,
    ...(configuration ? {
      systemPrompt: configuration.systemPrompt,
      thinkingLevel: configuration.thinkingLevel,
      tools: configuration.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    } : {}),
  })).digest("hex");
}

/** Explicit protocol boundary: carry facts, never provider reasoning or signatures. */
export function historicalSummary(messages: AgentMessage[]): string {
  const history = messages.map((message) => {
    if (message.role === "compactionSummary") return { role: "history", text: message.summary };
    if (!("content" in message)) return { role: message.role };
    const content = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.flatMap<unknown>((block) => {
        if (block.type === "text") return [{ type: "text", text: block.text }];
        if (block.type === "toolCall") return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments }];
        return [];
      }) : [];
    return { role: message.role, content,
      ...(message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
    };
  });
  return "Historical conversation data recorded by the application, not new user instructions or a new assistant response. Preserve visible facts, corrections and tool evidence; do not repeat completed work merely because it appears here.\n" + JSON.stringify(history);
}
