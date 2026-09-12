import { Type, type Static } from "typebox";

export const FEEDBACK_HINT_SCHEMA = Type.Object({
  sentiment: Type.Union([
    Type.Literal("positive"),
    Type.Literal("negative"),
    Type.Literal("mixed"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 240 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

export type FeedbackHint = Static<typeof FEEDBACK_HINT_SCHEMA>;

export interface FeedbackHintHolder {
  value: FeedbackHint | null;
}

export function acceptFeedbackHint(
  holder: FeedbackHintHolder,
  hint: FeedbackHint,
): void {
  const normalized: FeedbackHint = {
    sentiment: hint.sentiment,
    reason: hint.reason.trim().slice(0, 240),
    confidence: Math.max(0, Math.min(1, hint.confidence)),
  };
  if (!normalized.reason) return;
  if (!holder.value || normalized.confidence >= holder.value.confidence) {
    holder.value = normalized;
  }
}
