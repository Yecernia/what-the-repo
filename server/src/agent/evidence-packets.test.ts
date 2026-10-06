import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EvidenceRef } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { loadEvidencePackets } from "./evidence-packets.js";
import { reviewAnswerEvidence, unavailableEvidenceReview } from "./citation-review.js";

import { validateAnswerCitations, withEvidenceReviewNotice } from "./citations.js";

const evidence: EvidenceRef = { stable_id: "double", label: "double", path: "src/double.ts", start_line: 10, end_line: 46, kind: "symbol", snapshot_id: "snapshot" };
const lines = Array.from({ length: 55 }, (_, index) => index === 44 ? "return x * 2;" : "// filler");
const store = { readSourceLines: async (_p: string, _s: string, _f: string, start: number, end: number) => ({ lines: lines.slice(start - 1, end), truncated: false }) } as ProductStore;
const input = { evidence: [evidence], store, projectId: "project", snapshotId: "snapshot" };

function reviewPayload(context: Context) {
  const user = context.messages.find(message => message.role === 'user'); assert.ok(Array.isArray(user?.content));
  const part = user.content.find(part => part.type === 'text'); assert.ok(part?.type === 'text');
  return JSON.parse(part.text) as { task_phase: string; final_answer: string; focus_section_ids: number[];
    answer_sections: Array<{ section_id: number; start: number; end: number }> };
}
function controlledReview(context: Context, outcome: string, ids: string[] = [], claim?: string, proof?: unknown) {
  const payload = reviewPayload(context); assert.equal(payload.task_phase, 'direct_review');
  return { sections: payload.focus_section_ids.map(section_id => ({ section_id, outcome, basis: 'Controlled final source comparison.', evidence_ids: ids,
    issues: claim ? [{ claim, actual_assertion: 'The original return assertion.', conditions: 'Original conditions.', reason: 'The return multiplies by two. [click](https://bad.invalid)',
      kind: outcome === 'contradicted' ? 'contradicted' : 'insufficient_evidence', ...(proof ? { counterevidence: 'Source returns double.', contradiction_proof: proof } : {}) }] : [] })) };
}
test("citation handoff prefers actual source ranges to earlier whole-file anchors", async () => {
  const whole: SnapshotEvidence = { ...evidence, stable_id: "whole", start_line: 1, end_line: null, kind: "file" };
  const first: SnapshotEvidence = { ...whole, stable_id: "read:10", start_line: 10, end_line: 20, kind: "source_excerpt" };
  const second: SnapshotEvidence = { ...whole, stable_id: "read:40", start_line: 40, end_line: 46, kind: "source_excerpt" };
  const snapshot = { snapshot_id: "snapshot", graph: { nodes: [{ evidence: [whole], members: [] }], edges: [], layers: [] }, value_points: [] } as unknown as EvidenceSnapshot;
  const exposed = new Map([whole, first, second].map(row => [row.stable_id, row]));
  const citationStore = { ...store, listSourceFiles: async () => [whole.path] } as ProductStore;
  for (const text of ["The function doubles its input.", "See `src/double.ts`.", "See `double.ts`."]) {
    const result = await validateAnswerCitations({ text, snapshot, exposed, projectId: "project", store: citationStore });
    assert.deepEqual(result.evidence.map(row => [row.start_line, row.end_line]), [[10, 20], [40, 46]]);
    assert.deepEqual(result.errors, []);
  }
  const lazy = await validateAnswerCitations({ text: "The function doubles its input.", snapshot: null, snapshotId: "snapshot",
    getSnapshot: async () => { throw new Error("unneeded snapshot read"); }, exposed, projectId: "project", store: citationStore });
  assert.deepEqual(lazy.evidence.map(row => [row.start_line, row.end_line]), [[10, 20], [40, 46]]);
  const explicit = await validateAnswerCitations({ text: "See `src/double.ts:10-46`.", snapshot, exposed, projectId: "project", store: citationStore });
  assert.deepEqual(explicit.evidence.map(row => [row.start_line, row.end_line]), [[10, 46]]);
});

test("unavailable review hides exception details and preserves an unverified answer", () => {
  const result = unavailableEvidenceReview("secret token and provider response");
  assert.equal(result.status, "unverified");
  assert.equal(result.completed, false);
  assert.equal(result.supported, false);
  assert.equal(result.stopReason, "review_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /secret|token|provider response/);
  assert.ok(withEvidenceReviewNotice("Original answer.", result).startsWith("Original answer."));
});

test("a reviewer cannot claim support without accepting a supplied complete evidence ID", async () => {
  const faux = fauxProvider({ provider: "citation-invalid-accepted-ids" }); const models = createModels(); models.setProvider(faux.provider);
  for (const ids of [[], ["invented"]]) {
    faux.setResponses(Array.from({ length: 2 }, () => context => fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'supported', ids)))));
    const result = await reviewAnswerEvidence({ ...input, text: "returns double", modelRuntime: { models, model: faux.getModel() as Model<Api> } });
    assert.equal(result.status, "unverified"); assert.equal(result.completed, false); assert.equal(result.supported, false);
    assert.deepEqual(result.acceptedEvidenceIds, []); assert.equal(result.semanticReview?.groups[0]?.runs.length, 2);
    assert.ok(result.semanticReview?.groups[0]?.runs[0]?.validationErrors.length);
  }
});
test("evidence packets include the return in the declared long function range", async () => {
  const result = await loadEvidencePackets(input);
  assert.equal(result.incomplete, false);
  assert.equal(result.packets[0].actual_end_line, 46);
  assert.ok(result.packets[0].excerpt.includes("return x * 2;"));
});

test("evidence packets report budgets, read failure and snapshot mismatch explicitly", async () => {
  const budget = await loadEvidencePackets({ ...input, maxLines: 12 });
  assert.equal(budget.incomplete, true);
  assert.equal(budget.packets[0].actual_end_line, 21);
  assert.equal(budget.packets[0].reason, "budget_exceeded");
  const failed = await loadEvidencePackets({ ...input, store: { readSourceLines: async () => { throw new Error("secret provider detail"); } } as unknown as ProductStore });
  assert.equal(failed.packets[0].reason, "read_failed");
  assert.equal(failed.packets[0].actual_start_line, null);
  const mismatch = await loadEvidencePackets({ ...input, snapshotId: "other" });
  assert.equal(mismatch.packets[0].reason, "snapshot_mismatch");
});

test("evidence packets page complete ranges and mark oversized whole-file anchors incomplete", async () => {
  const source = Array.from({ length: 1500 }, (_, index) => `line ${index + 1}`);
  const pagedStore = { readSourceLines: async (_p: string, _s: string, _f: string, start: number, end: number) => {
    const actualEnd = Math.min(end, start + 399, source.length);
    return { lines: source.slice(start - 1, actualEnd), truncated: actualEnd < end && actualEnd < source.length };
  } } as ProductStore;
  const complete = await loadEvidencePackets({ ...input, store: pagedStore, evidence: [{ ...evidence, end_line: 850 }] });
  assert.equal(complete.incomplete, false);
  assert.equal(complete.packets[0].actual_end_line, 850);
  const whole = await loadEvidencePackets({ ...input, store: pagedStore, evidence: [{ ...evidence, start_line: 1, end_line: null }] });
  assert.equal(whole.incomplete, true);
  assert.equal(whole.packets[0].actual_end_line, 1200);
  const largeLine = await loadEvidencePackets({ ...input, maxCharacters: 5 });
  assert.equal(largeLine.packets[0].reason, "budget_exceeded");
  assert.equal(largeLine.packets[0].actual_start_line, null);
});

test("citation review distinguishes no evidence, greetings and explicit contradictions", async () => {
  const faux = fauxProvider({ provider: "citation-evidence-test" }); const models = createModels(); models.setProvider(faux.provider);
  const modelRuntime = { models, model: faux.getModel() as Model<Api> };
  faux.setResponses([context => fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'insufficient_evidence', [], 'This repository guarantees no duplicate IDs.')))]);
  const missing = await reviewAnswerEvidence({ ...input, evidence: [], text: "This repository guarantees no duplicate IDs.", modelRuntime });
  assert.equal(missing.status, "unverified"); assert.equal(missing.completed, true); assert.equal(missing.issues[0]!.kind, "insufficient_evidence"); assert.equal(missing.evidenceIncomplete, false);
  const greeting = await reviewAnswerEvidence({ ...input, evidence: [], text: "你好！", modelRuntime }); assert.equal(greeting.status, "not_applicable");
  faux.setResponses([context => {
    assert.match(JSON.stringify(context.messages), /return x \* 2/);
    return fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'contradicted', ['double'], 'returns triple',
      { evidence_id: 'double', excerpt: 'return x * 2', claim_scope: 'javascript_runtime', evidence_scope: 'javascript_runtime' })));
  }]);
  const reviewed = await reviewAnswerEvidence({ ...input, text: "returns triple", modelRuntime }); assert.equal(reviewed.status, "reviewed"); assert.equal(reviewed.issues[0]!.kind, "contradicted");
  assert.equal(reviewed.diagnostics?.requestCount, 1); const notice = withEvidenceReviewNotice("returns triple", reviewed); assert.match(notice, /multiplies by two/); assert.doesNotMatch(notice, /\[click\]\(/);
  faux.setResponses([context => fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'insufficient_evidence', [], 'returns double')))]);
  const unreadable = await reviewAnswerEvidence({ ...input, text: "returns double", modelRuntime, store: { readSourceLines: async () => { throw Error('source missing'); } } as unknown as ProductStore });
  assert.equal(unreadable.status, 'unverified'); assert.equal(unreadable.supported, false); assert.deepEqual(unreadable.acceptedEvidenceIds, []); assert.equal(unreadable.diagnostics?.requestCount, 1);
  assert.match(withEvidenceReviewNotice('returns double', unreadable), /coverage is incomplete/);
});
test('twelve packets complete; thirteen retain every reference and deterministically mark overflow', async () => {
  const refs = Array.from({ length: 14 }, (_, i) => ({ ...evidence, stable_id: `id-${i}`, path: `src/${String(i).padStart(2, '0')}.ts`, start_line: 1, end_line: 1 }));
  const complete = await loadEvidencePackets({ ...input, evidence: refs.slice(0, 12) });
  assert.equal(complete.coverage.complete, true);
  for (const rows of [refs, [...refs].reverse()]) {
    const result = await loadEvidencePackets({ ...input, evidence: rows });
    assert.equal(result.packets.length, 14);
    assert.deepEqual(result.packets.map(row => row.evidence_id), refs.map(row => row.stable_id));
    assert.equal(result.packets.filter(row => row.selected).length, 12);
    assert.ok(result.packets.slice(12).every(row => row.reason === 'budget_exceeded' && row.budget === 'packet' && !row.excerpt.length));
    assert.equal(result.coverage.complete, false);
    assert.deepEqual(result.coverage.reasons, ['budget_exceeded']);
  }
  const thirteen = await loadEvidencePackets({ ...input, evidence: refs.slice(0, 13) });
  assert.equal(thirteen.coverage.packets[12].selected, false);
});

test('coverage distinguishes actual reads, line and character budgets without broadening ranges', async () => {
  const lineLimit = await loadEvidencePackets({ ...input, maxLines: 12 });
  assert.equal(lineLimit.coverage.packets[0].budget, 'lines');
  assert.equal(lineLimit.coverage.packets[0].requested_end_line, 46);
  assert.equal(lineLimit.coverage.packets[0].actual_end_line, 21);
  assert.equal(lineLimit.coverage.packets[0].read, true);
  const chars = await loadEvidencePackets({ ...input, maxCharacters: 5 });
  assert.equal(chars.coverage.packets[0].budget, 'characters');
  assert.equal(chars.coverage.packets[0].read, false);
  assert.doesNotMatch(JSON.stringify(chars.coverage), /filler/);
  const unavailable = await loadEvidencePackets({ ...input, evidence: [{ ...evidence, start_line: 56, end_line: 56 }] });
  assert.deepEqual(unavailable.coverage.reasons, ['range_unavailable']);
});

