/** Conservative planning estimate, not a Provider tokenizer or a reason to truncate evidence. */
export function semanticInputBudget(serializedContext: string, model: { contextWindow?: number; maxTokens?: number }, additionalInputBytes = 0) {
  const contextWindow = model.contextWindow ?? 0;
  const reservedOutputTokens = model.maxTokens ?? 0;
  const estimatedInputTokens = Math.ceil((Buffer.byteLength(serializedContext, "utf8") + additionalInputBytes) / 2);
  const reservedToolTokens = Math.max(32_768, Math.ceil(contextWindow * 0.1));
  const valid = Number.isFinite(contextWindow) && contextWindow > 0
    && Number.isFinite(reservedOutputTokens) && reservedOutputTokens > 0;
  return {
    contextWindow, estimatedInputTokens, reservedOutputTokens, reservedToolTokens,
    fits: valid && estimatedInputTokens + reservedOutputTokens + reservedToolTokens <= contextWindow,
  };
}
