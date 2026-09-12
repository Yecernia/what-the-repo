import assert from "node:assert/strict";
import test from "node:test";
import { createWebResearchClient, WebSearchError } from "./web-research-client.js";
import { createWebResearchTools } from "../agent/web-research-tools.js";
import { searchInitialRepositoryResearch, restoreWebResearchState } from "./initial-web-research.js";
import type { SemanticBatch } from "../domain/semantic-batch.js";
import type { SemanticBatchContext } from "./semantic-contracts.js";

function recorder(): SemanticBatchContext {
  const rows = new Map<string, SemanticBatch>();
  return { jobId: "research-job", jobAttempt: 1, recorder: {
    load: async (_job, id) => rows.get(id) ?? null,
    start: async row => { rows.set(row.batch_id, structuredClone(row)); },
    complete: async (id, output, digest) => { Object.assign(rows.get(id)!, { status: "succeeded", output: structuredClone(output), output_digest: digest }); },
    fail: async (id, error, status = "failed") => { Object.assign(rows.get(id)!, { status, error }); },
  } };
}

test("initial research survives a worker restart including raw pages and the shared tool budget", async () => {
  let network = 0;
  const context = recorder();
  const client = createWebResearchClient("test", async () => {
    network++;
    return Response.json({ results: [{ url: "https://example.com/design", title: "Design", content: "candidate",
      raw_content: "Actual detailed mechanism" }], usage: { credits: 1 } });
  });
  const input = { repository: "example/repo", commitSha: "a".repeat(40), client, batchContext: context };
  const first = await searchInitialRepositoryResearch(input);
  assert.doesNotMatch(JSON.stringify(first.response), /Actual detailed/);
  const restarted = createWebResearchClient("test", async () => { throw new Error("must_not_repeat_network"); });
  const replay = await searchInitialRepositoryResearch({ ...input, client: restarted, batchContext: { ...context, jobAttempt: 2 } });
  assert.deepEqual(replay, first);
  assert.equal(network, 1);
  const web = createWebResearchTools({ research: undefined, client: restarted, state: restoreWebResearchState(replay) });
  const page = await web.tools[1]!.execute("read", { url: "https://example.com/design" });
  assert.match(JSON.stringify(page), /Actual detailed mechanism/);
  assert.equal(web.state.searchCalls, 1);
  assert.equal(web.state.pageCalls, 1);
  assert.equal(web.state.searches[0]?.credits, 1);
  assert.equal(replay.state.pageCalls, 0, "consumer state must not mutate the replay record");
  await searchInitialRepositoryResearch({ ...input, commitSha: "b".repeat(40) });
  assert.equal(network, 2, "a different source revision is separate research");
});

test("failed search is an explicit replayable outcome; cancellation is never successful research", async () => {
  const context = recorder();
  let calls = 0;
  const client = { identity: "fixture", readPage: async () => null,
    search: async () => { calls++; throw new WebSearchError("quota"); } };
  const input = { repository: "example/repo", commitSha: "c".repeat(40), client, batchContext: context };
  const result = await searchInitialRepositoryResearch(input);
  assert.equal(result.state.searches[0]?.errorCode, "quota");
  assert.match(JSON.stringify(result.response), /unavailable/);
  assert.deepEqual(await searchInitialRepositoryResearch(input), result);
  assert.equal(calls, 1);
  const web = createWebResearchTools({ research: undefined, client, state: restoreWebResearchState(result) });
  await assert.rejects(web.tools[0]!.execute("again", { query: "another question" }), /quota/);
  assert.equal(calls, 1);

  const controller = new AbortController();
  const cancelledInput = { ...input, commitSha: "d".repeat(40), signal: controller.signal,
    client: { ...client, search: async () => { controller.abort(new Error("analysis_cancelled")); throw controller.signal.reason; } } };
  await assert.rejects(searchInitialRepositoryResearch(cancelledInput), /analysis_cancelled/);
  assert.equal((await context.recorder.load(context.jobId, "value-initial-search"))?.status, "cancelled");
});
