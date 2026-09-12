import assert from "node:assert/strict";
import test from "node:test";
import { createWebResearchClient } from "./web-research-client.js";
import { createWebResearchTools } from "../agent/web-research-tools.js";

test("Tavily uses one bounded basic request; page bodies are read on demand without another API charge", async () => {
  let calls = 0;
  const raw = "# Official architecture\n\n一切皆插件。\n" + "code-supported details\n".repeat(1_500);
  const client = createWebResearchClient("test-key", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "example/project architecture", search_depth: "basic", topic: "general", max_results: 4, chunks_per_source: 3, auto_parameters: false, include_answer: false, include_images: false, include_raw_content: "markdown", include_usage: true });
    return Response.json({ results: [
      { url: "https://example.com/design#intro", title: "Official", content: "Candidate only", raw_content: raw },
      { url: "https://example.com/design", title: "Duplicate", content: "Duplicate" },
      { url: "https://127.0.0.1/private", title: "Private", content: "Private" },
      { url: "http://example.com/unsafe", title: "HTTP", content: "HTTP" },
    ], usage: { credits: 1 } });
  });
  const web = createWebResearchTools({ research: undefined, client });
  const search = web.tools.find(tool => tool.name === "search_web")!;
  const read = web.tools.find(tool => tool.name === "read_web_page")!;
  const result = await search.execute("initial", { query: "example/project architecture" });
  assert.equal(web.state.searchResults.length, 1);
  assert.equal(web.state.searches[0]?.credits, 1);
  assert.match(web.state.searches[0]?.provider ?? "", /tavily-basic/);
  assert.doesNotMatch(JSON.stringify(result), /code-supported/);
  const page = await read.execute("page", { url: "https://example.com/design" });
  assert.match(JSON.stringify(page), /一切皆插件/);
  const payload = JSON.parse(page.content.filter(item => item.type === "text").map(item => item.text).join(""));
  assert.equal(payload.truncated, true);
  assert.equal(web.state.readPages[0]?.content, raw.slice(0, 24_000));
  assert.equal(calls, 1);
  await assert.rejects(read.execute("private", { url: "https://127.0.0.1/private" }), /url_not_exposed/);
  assert.equal(calls, 1);
});

test("search distinguishes no hits, configuration, API limits and malformed responses without leaking bodies", async () => {
  let calls = 0;
  await assert.rejects(createWebResearchClient(null, async () => { calls++; return Response.json({}); }).search("example/project"), /not_configured/);
  assert.equal(calls, 0);
  for (const [status, code] of [[401, "authentication"], [429, "rate_limit"], [432, "quota"], [433, "quota"], [503, "service"], [302, "service"]] as const) {
    const client = createWebResearchClient("never-in-output", async () => new Response("sensitive response never-in-output", { status }));
    const web = createWebResearchTools({ research: undefined, client });
    await assert.rejects(web.tools[0]!.execute("search", { query: "example/project" }), new RegExp(`^Error: web_search_${code}$`));
    assert.equal(web.state.searches[0]?.errorCode, code);
    assert.equal(web.state.searches[0]?.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(web.state.searches), /never-in-output/);
  }
  for (const body of ["<html>challenge</html>", "{}", "null", '{"results":[{}]}']) {
    const client = createWebResearchClient("test", async () => new Response(body));
    await assert.rejects(client.search("example/project"), /invalid_response/);
  }
  const empty = await createWebResearchClient("test", async () => Response.json({ results: [], usage: { credits: 1 } })).search("example/project");
  assert.deepEqual(empty, { results: [], credits: 1 });
});

test("search bounds response bytes and respects cancellation during body reading", async () => {
  let cancelled = false;
  const oversized = createWebResearchClient("test", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(oversized.search("example/project"), /response_too_large/);
  assert.equal(cancelled, true);
  const abort = new AbortController();
  const pending = createWebResearchClient("test", async () => new Response(new ReadableStream({ start() { queueMicrotask(() => abort.abort(new Error("test_cancelled"))); } })));
  await assert.rejects(pending.search("example/project", abort.signal), /test_cancelled/);
});
