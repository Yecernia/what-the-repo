import assert from "node:assert/strict";
import test from "node:test";
import { validateEvolutionQueueEnvelope } from "../src/task-queue.js";

test("evolution queue envelope contains only matching durable identifiers", () => {
  assert.deepEqual(validateEvolutionQueueEnvelope({
    job_id: "evolution:feedback-request-1",
    request_id: "feedback-request-1",
  }), {
    job_id: "evolution:feedback-request-1",
    request_id: "feedback-request-1",
  });
  assert.throws(() => validateEvolutionQueueEnvelope({
    job_id: "evolution:feedback-request-2",
    request_id: "feedback-request-1",
  }), /do not match/);
  const sanitized = validateEvolutionQueueEnvelope({
    job_id: "evolution:feedback-request-1",
    request_id: "feedback-request-1",
    api_key: "must-not-be-consumed",
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ["job_id", "request_id"]);
});
