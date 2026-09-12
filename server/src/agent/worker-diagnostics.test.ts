import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { createWorkerDiagnostics, diagnoseToolSchema } from "./worker-diagnostics.js";
import { LocalProviderUsageBudget } from "./provider-budget.js";
import { streamWithProviderPermit } from "./model-runtime.js";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

test("schema diagnostics report schema fields and limits without retaining hostile keys or values", () => {
  const schema = Type.Object({ rows: Type.Array(Type.Object({ answer: Type.String({ maxLength: 3 }) }), { maxItems: 1 }), limit: Type.Integer({ maximum: 50 }) });
  const errors = diagnoseToolSchema(schema, { rows: [{ answer: "secret-source" }, { answer: "secret-value" }], limit: 51, "private-path": "private-secret" });
  assert.ok(errors.some((row) => row.keyword === "maxLength" && row.schemaPath === "#/properties/rows/items/properties/answer"));
  assert.ok(errors.some((row) => row.keyword === "maxItems"));
  assert.ok(errors.some((row) => row.keyword === "maximum"));
  assert.doesNotMatch(JSON.stringify(errors), /secret|private|instancePath/);
  assert.deepEqual(diagnoseToolSchema(Type.Object({ limit: Type.Integer() }), { limit: "20" }), []);
});

test("tool failures retain only allowlisted codes and numeric page positions", async () => {
  const diagnostics = createWorkerDiagnostics();
  try {
    const tool = { name: "read", label: "read", description: "read", parameters: Type.Object({}), execute: async () => { throw new Error("source_offset_out_of_range:private-source"); } };
    await assert.rejects(diagnostics.wrapTool(tool).execute("1", { member_offset: 20, relation_offset: 0 }));
    assert.equal(diagnostics.data.tools[0]?.errorCode, "source_offset_out_of_range");
    assert.equal(diagnostics.data.tools[0]?.memberOffset, 20);
    assert.doesNotMatch(JSON.stringify(diagnostics.data), /private-source/);
  } finally { diagnostics.finish(); }
});

test("source diagnostics correlate a file across different pages without storing names or source", async () => {
  const diagnostics = createWorkerDiagnostics();
  const tool = { name: "read_repository_source", label: "read", description: "read", parameters: Type.Object({}),
    execute: async (_id: string, input: unknown) => {
      const args = input as { path: string; offset: number };
      return { content: [{ type: "text" as const,
        text: JSON.stringify({ path: args.path, start_line: args.offset, end_line: args.offset + 19, content: "sensitive implementation" }) }], details: {} };
    } };
  try {
    diagnostics.request({ messages: [] });
    await diagnostics.wrapTool(tool).execute("1", { path: "private/file.ts", offset: 1 });
    diagnostics.request({ messages: [] });
    await diagnostics.wrapTool(tool).execute("2", { path: "private/file.ts", offset: 21 });
    await diagnostics.wrapTool(tool).execute("3", { path: "private/other.ts", offset: 21 });
    const [first, second, other] = diagnostics.data.tools;
    assert.equal(first?.sourcePathDigest, second?.sourcePathDigest);
    assert.notEqual(second?.sourcePathDigest, other?.sourcePathDigest);
    assert.deepEqual([second?.requestSequence, second?.sourceStartLine, second?.sourceEndLine], [2, 21, 40]);
    assert.doesNotMatch(JSON.stringify(diagnostics.data), /private\/|sensitive implementation/);
  } finally { diagnostics.finish(); }
});

test("concurrent worker diagnostics keep identities separate and never retain tool content", async () => {
  const a = createWorkerDiagnostics({ jobId: "job", jobAttempt: 2, batchId: "a" });
  const b = createWorkerDiagnostics({ jobId: "job", jobAttempt: 2, batchId: "b" });
  const tool = {
    name: "read", label: "read", description: "read", parameters: Type.Object({ offset: Type.Number() }),
    execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ items: ["sensitive-source"], next_offset: 2 }) }], details: {} }),
  };
  try {
    await Promise.all([a.wrapTool(tool).execute("1", { offset: 0, path: "private-path" }), b.wrapTool(tool).execute("2", { offset: 1 })]);
    assert.equal(a.data.identity?.batchId, "a");
    assert.equal(b.data.identity?.batchId, "b");
    assert.notEqual(a.data.runId, b.data.runId);
    assert.equal(a.data.tools[0]?.itemCount, 1);
    assert.equal(a.data.tools[0]?.nextOffset, 2);
    assert.doesNotMatch(JSON.stringify(a.data), /sensitive-source|private-path/);
  } finally { a.finish(); b.finish(); }
});

test("request diagnostics join budget events and distinguish first content from start", async () => {
  const faux = fauxProvider({ provider: "diagnostic-test" });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("hello")]);
  const diagnostics = createWorkerDiagnostics();
  const context = { messages: [{ role: "user" as const, content: "private-input", timestamp: Date.now() }] };
  const row = diagnostics.request(context);
  const model = faux.getModel() as Model<Api>;
  try {
    const stream = streamWithProviderPermit({ models, model, ownerId: "owner", providerBudget: new LocalProviderUsageBudget({ maxCallsPerMinute: 100, maxCostUsdPerDay: 10, minimumReservationUsd: 0 }) }, model, context, {}, row);
    for await (const _event of stream) { /* Drain the faux provider only. */ }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(row.usageEventId);
    assert.ok(row.requestStartedAt);
    assert.equal(row.status, "success");
    assert.ok(row.firstContentMs !== null);
    assert.ok(row.durationMs >= row.firstContentMs!);
    assert.doesNotMatch(JSON.stringify(row), /private-input|hello/);
  } finally { diagnostics.finish(); }
});
