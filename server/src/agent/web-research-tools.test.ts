import assert from "node:assert/strict";
import test from "node:test";
import { createWebResearchTools } from "./web-research-tools.js";
import { WebSearchError } from "../analysis/web-research-client.js";
import { WebPageError } from "../analysis/research-page.js";

test("permanent API errors stop repeated HTTP searches instead of spending the remaining budget", async () => {
  let calls = 0;
  const web = createWebResearchTools({ research: undefined, client: { search: async () => { calls++; throw new WebSearchError("quota"); }, readPage: async () => null } });
  for (let i = 0; i < 3; i++) await assert.rejects(web.tools[0]!.execute(`s${i}`, { query: `example/project design ${i}` }), /web_search_quota/);
  assert.equal(calls, 1);
  assert.equal(web.state.searches.length, 1);
});

test("initial and Agent searches share the four-attempt budget, including failures", async () => {
  let calls = 0;
  const web = createWebResearchTools({ research: undefined, client: {
    search: async () => { calls++; throw new Error("web_search_unavailable"); },
    readPage: async () => { assert.fail("this test should not read pages"); },
  } });
  const search = web.tools.find((tool) => tool.name === "search_web")!;
  for (let index = 0; index < 4; index++) {
    await assert.rejects(search.execute(`search-${index}`, { query: "example/project" }), /web_search_unavailable/);
  }
  await assert.rejects(search.execute("search-5", { query: "example/project" }), /web_search_budget_exhausted/);
  assert.equal(calls, 4);
  assert.equal(web.state.searches.length, 4);
  assert.ok(web.state.searches.every((row) => row.status === "unavailable" && row.durationMs >= 0));
});

test("search results authorize only returned HTTPS pages and retain page evidence", async () => {
  const page = { url: "https://example.com/design", title: "Design", content: "Snippet", source_kind: "community_search" as const };
  let reads = 0;
  const web = createWebResearchTools({ research: undefined, client: {
    search: async () => [page],
    readPage: async () => { reads++; return { ...page, content: "Full text" }; },
  } });
  const search = web.tools.find((tool) => tool.name === "search_web")!;
  const read = web.tools.find((tool) => tool.name === "read_web_page")!;
  await assert.rejects(read.execute("early", { url: page.url }), /web_page_url_not_exposed/);
  await search.execute("initial", { query: "example/project" });
  await assert.rejects(read.execute("unlisted", { url: "https://example.com/unlisted" }), /web_page_url_not_exposed/);
  await assert.rejects(read.execute("http", { url: "http://example.com/design" }), /web_page_url_not_exposed/);
  await read.execute("allowed", { url: page.url });
  assert.equal(reads, 1);
  assert.equal(web.state.readPages[0]?.content, "Full text");
  assert.equal(web.state.searches[0]?.status, "results");
});

test("page attempts retain failure categories and truncation while enforcing the shared content budget", async () => {
  const page = { url: "https://example.com/design", title: "Design", content: "Snippet", source_kind: "community_search" as const };
  let reads = 0;
  const web = createWebResearchTools({ research: undefined, client: {
    search: async () => [page], readPage: async () => {
      reads++;
      if (reads === 1) throw new WebPageError("http_error", 503);
      return { ...page, content: "x".repeat(30_000) };
    },
  } });
  await web.tools[0]!.execute("search", { query: "example/project" });
  const read = web.tools[1]!;
  await assert.rejects(read.execute("failure", { url: page.url }), /web_page_http_error/);
  await read.execute("first", { url: page.url });
  await read.execute("second", { url: page.url });
  await assert.rejects(read.execute("exhausted", { url: page.url }), /web_page_payload_budget_exhausted/);
  assert.equal(reads, 3);
  assert.equal(web.state.totalChars, 48_000);
  assert.deepEqual(web.state.pageReads.map(({ durationMs, ...row }) => { assert.ok(durationMs >= 0); return row; }), [
    { url: page.url, status: "unavailable", chars: 0, truncated: false, errorCode: "http_error", httpStatus: 503 },
    { url: page.url, status: "read", chars: 24_000, truncated: true },
    { url: page.url, status: "read", chars: 24_000, truncated: true },
  ]);
});

test("a page client returning after cancellation cannot add content to the model or research state", async () => {
  const controller = new AbortController();
  const page = { url: "https://example.com/design", title: "Design", content: "Cancelled content", source_kind: "community_search" as const };
  const web = createWebResearchTools({ research: undefined, client: {
    search: async () => [page], readPage: async () => { controller.abort(new Error("user_cancelled")); return page; },
  } });
  await web.tools[0]!.execute("search", { query: "example/project" });
  await assert.rejects(web.tools[1]!.execute("cancelled", { url: page.url }, controller.signal), /user_cancelled/);
  assert.equal(web.state.readPages.length, 0);
  assert.equal(web.state.pageReads[0]?.status, "cancelled");
});
