import { createHash } from 'node:crypto';
import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { PiModelRuntime } from './types.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');

// Anthropic moves its breakpoint from the previous last message to the new one.
// This is cache metadata, not a rewrite of the conversation's token content.
function withoutCacheMarker(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarker);
  if (!value || typeof value !== 'object') return value;
  const { cache_control: _marker, ...block } = value as Record<string, unknown>;
  if (Array.isArray(block.content)) block.content = block.content.map(withoutCacheMarker);
  return block;
}

/** Prevent Pi's cross-model fallback from turning private reasoning into ordinary text. */
export function compatibleReplayContext(context: Context, model: Model<Api>): Context {
  let changed = false;
  const messages = context.messages.map(message => {
    if (message.role !== 'assistant' || (message.provider === model.provider
      && message.api === model.api && message.model === model.id)) return message;
    changed = true;
    return { ...message, content: message.content.flatMap((block): AssistantMessage['content'] => {
      if (block.type === 'thinking') return [];
      if (block.type === 'text') return [{ type: 'text' as const, text: block.text }];
      const { thoughtSignature: _signature, ...tool } = block;
      return [tool];
    }) };
  });
  return changed ? { ...context, messages } : context;
}

export function promptCacheScope(runtime: PiModelRuntime, sessionId: string): string {
  return digest([runtime.ownerId ?? null, runtime.providerConnectionId ?? null,
    runtime.model.provider, runtime.model.api, runtime.model.id, runtime.model.baseUrl,
    // Separate anonymous/direct runtimes too, without retaining a credential.
    digest(runtime.apiKey ?? ''), sessionId]);
}

/** Worker execution IDs stay unique; only a known OpenAI cache group is shared. */
export function workerPromptCacheKey(runtime: PiModelRuntime, context: Context, sessionId?: string): string | undefined {
  if (!sessionId?.startsWith('worker-') || !runtime.ownerId || !runtime.attribution?.agentRole
    || !['openai-completions', 'openai-responses'].includes(runtime.model.api)) return sessionId;
  if (!URL.canParse(runtime.model.baseUrl) || new URL(runtime.model.baseUrl).hostname !== 'api.openai.com') return sessionId;
  return promptCacheScope(runtime, digest([runtime.attribution.agentRole, context.systemPrompt, context.tools]));
}

export interface PromptCacheDiagnostic {
  systemDigest: string;
  toolsDigest: string;
  parametersDigest: string;
  historyDigest: string;
  messageCount: number;
  commonMessages: number;
  comparedMessages: number;
  reason: 'first_request' | 'tools_changed' | 'system_changed' | 'parameters_changed' | 'history_changed' | 'prefix_preserved';
}

interface PrefixState extends PromptCacheDiagnostic {
  messageDigests: string[];
  observedAt: number;
}

/** Bounded, process-local fingerprints only. These diagnose structure, not provider cache hits. */
export class PromptCacheObserver {
  private readonly previous = new Map<string, PrefixState>();

  constructor(private readonly capacity = 256, private readonly maxMessages = 256) {}

  observe(scope: string, payload: Record<string, unknown>, now = Date.now()): PromptCacheDiagnostic {
    const allMessages = Array.isArray(payload.messages) ? payload.messages
      : Array.isArray(payload.input) ? payload.input : [];
    const isInstruction = (value: unknown): boolean => !!value && typeof value === 'object'
      && ['system', 'developer'].includes(String((value as { role?: unknown }).role));
    const messages = allMessages.filter(value => !isInstruction(value)).map(withoutCacheMarker);
    const systemDigest = digest([withoutCacheMarker(payload.system), payload.instructions, allMessages.filter(isInstruction)]);
    const toolsDigest = digest([payload.tools, payload.tool_choice, payload.parallel_tool_calls]);
    const parametersDigest = digest([payload.model, payload.thinking, payload.reasoning, payload.reasoning_effort, payload.output_config]);
    const messageDigests = messages.slice(0, this.maxMessages).map(digest);
    const old = this.previous.get(scope);
    const previous = old && now - old.observedAt < 30 * 60_000 ? old : undefined;
    let commonMessages = 0;
    const comparedMessages = previous ? Math.min(previous.messageDigests.length, messageDigests.length) : 0;
    while (commonMessages < comparedMessages && previous!.messageDigests[commonMessages] === messageDigests[commonMessages]) commonMessages++;
    const reason = !previous ? 'first_request'
      : previous.toolsDigest !== toolsDigest ? 'tools_changed'
      : previous.systemDigest !== systemDigest ? 'system_changed'
      : previous.parametersDigest !== parametersDigest ? 'parameters_changed'
      : messages.length < previous.messageCount || previous.historyDigest !== digest(messages.slice(0, previous.messageCount))
        ? 'history_changed' : 'prefix_preserved';
    const result: PromptCacheDiagnostic = {
      systemDigest, toolsDigest, parametersDigest, historyDigest: digest(messages),
      messageCount: messages.length, commonMessages, comparedMessages, reason,
    };
    this.previous.delete(scope);
    this.previous.set(scope, { ...result, messageDigests, observedAt: now });
    while (this.previous.size > this.capacity) this.previous.delete(this.previous.keys().next().value!);
    return result;
  }
}
