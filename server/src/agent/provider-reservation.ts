import type { Api, Context, Model } from '@earendil-works/pi-ai';

/** Conservative estimate, not a tokenizer or a provider invoice. */
export function providerReservation(model: Model<Api>, context?: Context, customPayload = false): number {
  let inputTokens = Math.max(0, model.contextWindow);
  const textOnly = context?.messages.every(message => typeof message.content === 'string'
    || message.content.every(block => ['text', 'thinking', 'toolCall'].includes(block.type)));
  if (context && textOnly && !customPayload) {
    // Include system instructions, tool schemas, arguments/results and history.
    // Two tokens per UTF-8 byte plus framing headroom deliberately overestimates
    // normal text without charging every short request for the entire window.
    const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    inputTokens = Math.min(inputTokens, bytes * 2 + 4096 + context.messages.length * 64);
  }
  const cost = model.cost;
  const input = inputTokens * Math.max(0, cost.input, cost.cacheRead, cost.cacheWrite);
  // Keep the full model output allowance (including reasoning). SDK adapters
  // can enlarge caller maxTokens; reserving only that option is unsafe.
  const output = Math.max(0, model.maxTokens) * Math.max(0, cost.output);
  return (input + output) / 1_000_000;
}
