import assert from "node:assert/strict";
import test from "node:test";
import { createModels, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EvidenceRef } from "../domain/conversation.js";
import type { EvidenceSnapshot, SnapshotEvidence } from "../domain/snapshot.js";
import type { ProductStore } from "../persistence/store.js";
import { loadEvidencePackets } from "./evidence-packets.js";
import { hasSameScopeProof } from './direct-citation-review.js';
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
  assert.ok(withEvidenceReviewNotice("Original answer.", result, 'en').startsWith("Original answer."));
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
  assert.equal(reviewed.diagnostics?.requestCount, 1); const notice = withEvidenceReviewNotice("returns triple", reviewed, 'en'); assert.match(notice, /multiplies by two/); assert.doesNotMatch(notice, /\[click\]\(/);
  faux.setResponses([context => fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'insufficient_evidence', [], 'returns double')))]);
  const unreadable = await reviewAnswerEvidence({ ...input, text: "returns double", modelRuntime, store: { readSourceLines: async () => { throw Error('source missing'); } } as unknown as ProductStore });
  assert.equal(unreadable.status, 'unverified'); assert.equal(unreadable.supported, false); assert.deepEqual(unreadable.acceptedEvidenceIds, []); assert.equal(unreadable.diagnostics?.requestCount, 1);
  assert.match(withEvidenceReviewNotice('returns double', unreadable, 'en'), /coverage is incomplete/);
});
test('twelve packets complete; thirteen retain every reference and deterministically mark overflow', async () => {
  const refs = Array.from({ length: 14 }, (_, i) => ({ ...evidence, stable_id: `id-${i}`, path: `src/${String(i).padStart(2, '0')}.ts`, start_line: 1, end_line: 1 }));
  const complete = await loadEvidencePackets({ ...input, evidence: refs.slice(0, 12) });
  assert.equal(complete.coverage.complete, true);
  for (const rows of [refs, [...refs].reverse()]) {
    const result = await loadEvidencePackets({ ...input, evidence: rows });
    assert.equal(result.packets.length, 14);
    assert.deepEqual(result.packets.flatMap(row => row.references.map(ref => ref.evidence_id)), refs.map(row => row.stable_id));
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

test('shared source packets preserve all references and spend source budgets only once', async () => {
  const refs = [
    { ...evidence, stable_id: 'whole', start_line: 1, end_line: 50 },
    ...Array.from({ length: 16 }, (_, i) => ({ ...evidence, stable_id: `narrow-${i}`, start_line: i + 1, end_line: i + 3 })),
    { ...evidence, stable_id: 'overlap', start_line: 48, end_line: 55 },
    { ...evidence, stable_id: 'other', path: 'z.ts', start_line: 1, end_line: 1 },
  ];
  const source = Array.from({ length: 55 }, (_, i) => `line ${i + 1}`);
  const maxCharacters = source.join('\n').length + 1 + 'other\n'.length;
  let previous: Awaited<ReturnType<typeof loadEvidencePackets>> | undefined;
  for (const rows of [refs, [...refs].reverse()]) {
    const reads: Array<[string, number, number]> = [];
    const result = await loadEvidencePackets({ ...input, evidence: rows, maxLines: 56, maxCharacters,
      store: { readSourceLines: async (_p: string, _s: string, path: string, start: number, end: number) => {
        reads.push([path, start, end]); return { lines: path === 'z.ts' ? ['other'] : source.slice(start - 1, end), truncated: false };
      } } as ProductStore });
    assert.equal(result.incomplete, false);
    assert.equal(result.packets.length, 2);
    assert.deepEqual(reads, [['src/double.ts', 1, 55], ['z.ts', 1, 1]]);
    assert.deepEqual(result.packets.flatMap(p => p.references.map(r => r.evidence_id)).sort(), refs.map(r => r.stable_id).sort());
    assert.deepEqual(result.packets[0].excerpt, source);
    assert.equal(result.packets.flatMap(p => p.excerpt).length, 56);
    if (previous) assert.deepEqual(result, previous);
    previous = result;
    const proof = { evidence_id: 'narrow-0', excerpt: 'line 2', claim_scope: 'javascript_runtime' as const, evidence_scope: 'javascript_runtime' as const };
    assert.equal(hasSameScopeProof(proof, result.packets), true);
    assert.equal(hasSameScopeProof({ ...proof, excerpt: 'line 50' }, result.packets), false, 'sharing text must not broaden the cited reference');
    assert.equal(hasSameScopeProof({ ...proof, evidence_id: 'invented' }, result.packets), false);
  }
});

test('shared packets retain gaps, snapshot boundaries, missing finite ranges and actual budget failures', async () => {
  const ref = (id: string, start: number, end: number | null) => ({ ...evidence, stable_id: id, start_line: start, end_line: end });
  const separated = await loadEvidencePackets({ ...input, evidence: [ref('a', 1, 2), ref('b', 10, 12)] });
  assert.deepEqual(separated.packets.map(p => [p.actual_start_line, p.actual_end_line]), [[1, 2], [10, 12]]);
  const mismatch = await loadEvidencePackets({ ...input, evidence: [ref('a', 1, 20), { ...ref('b', 2, 3), snapshot_id: 'foreign' }] });
  assert.equal(mismatch.packets.length, 2);
  assert.equal(mismatch.incomplete, true);
  assert.ok(mismatch.packets.some(p => p.reason === 'snapshot_mismatch'));
  const outOfFile = await loadEvidencePackets({ ...input, evidence: [ref('whole', 1, null), ref('absent', 60, 62)] });
  assert.equal(outOfFile.packets.length, 1);
  assert.equal(outOfFile.packets[0].actual_end_line, 55);
  assert.equal(outOfFile.packets[0].reason, 'range_unavailable');
  for (const limits of [{ maxLines: 2 }, { maxCharacters: 2 }]) {
    const limited = await loadEvidencePackets({ ...input, ...limits, evidence: [ref('wide', 1, 20), ref('narrow', 2, 3)] });
    assert.equal(limited.incomplete, true);
    assert.equal(limited.packets[0].references.length, 2);
    assert.equal(limited.packets[0].reason, 'budget_exceeded');
  }
  const failed = await loadEvidencePackets({ ...input, evidence: [ref('wide', 1, 20), ref('narrow', 2, 3)],
    store: { readSourceLines: async () => { throw Error('unavailable'); } } as unknown as ProductStore });
  assert.equal(failed.packets[0].reason, 'read_failed');
  assert.equal(failed.packets[0].references.length, 2);
});

test('a reviewer can accept a contained original reference without losing its identity', async () => {
  const faux = fauxProvider({ provider: 'shared-source-reference' }); const models = createModels(); models.setProvider(faux.provider);
  const nested = { ...evidence, stable_id: 'return-only', start_line: 45, end_line: 45 };
  faux.setResponses([context => {
    const payload = reviewPayload(context) as ReturnType<typeof reviewPayload> & { evidence: Array<{ references: unknown[]; excerpt: string[] }> };
    assert.equal(payload.evidence.length, 1);
    assert.equal(payload.evidence[0].references.length, 2);
    assert.equal(payload.evidence[0].excerpt.filter(line => line === 'return x * 2;').length, 1);
    return fauxAssistantMessage(fauxToolCall('submit_result', controlledReview(context, 'supported', ['return-only'])));
  }]);
  const result = await reviewAnswerEvidence({ ...input, evidence: [evidence, nested], text: 'returns double', modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(result.supported, true);
  assert.deepEqual(result.acceptedEvidenceIds, ['return-only']);
});

