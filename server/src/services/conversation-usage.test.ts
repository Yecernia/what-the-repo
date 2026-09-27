import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../domain/conversation.js";
import { answerMessage } from "./conversation-service.js";

test("answer usage includes uncached input, cache reads and writes without counting output as prompt", () => {
  const project = createProject("guest:usage", "https://github.com/example/usage", "Usage", null);
  const message = answerMessage(project, "Answer", "test-model", "completed", 1,
    { inputTokens: 11, cachedTokens: 23, cacheWriteTokens: 7, outputTokens: 5 }, "trace:test", []);
  assert.deepEqual(message.usage, { prompt_tokens: 41, cached_tokens: 23, completion_tokens: 5, total_tokens: 46 });
});
