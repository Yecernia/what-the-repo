import assert from "node:assert/strict";
import test from "node:test";
import { readResearchPage, WebPageError } from "./research-page.js";
import type { PublicFetchOptions } from "../security/outbound-url.js";

const url = "https://example.com/design";
const network = (fetchImpl: typeof fetch): PublicFetchOptions => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }], fetchImpl });

test("public redirects resolve again, stay bounded and never carry credentials into private destinations", async () => {
  const lookedUp: string[] = [], requested: string[] = [];
  const page = await readResearchPage(url, "official", undefined, {
    lookup: async hostname => { lookedUp.push(hostname); return [{ address: "8.8.8.8", family: 4 }]; },
    fetchImpl: async (input, init) => {
      requested.push(String(input));
      assert.equal(init?.redirect, "manual"); assert.equal(init?.credentials, "omit");
      return requested.length === 1 ? new Response(null, { status: 301, headers: { location: "https://www.example.com/design" } })
        : new Response("Official design", { headers: { "content-type": "text/plain" } });
    },
  });
  assert.equal(page.content, "Official design");
  assert.deepEqual(lookedUp, ["example.com", "www.example.com"]);
  for (const destination of ["http://example.com", "https://127.0.0.1", "https://user:password@example.com", "https://private.example.com"]) {
    let calls = 0;
    await assert.rejects(readResearchPage(url, "official", undefined, {
      lookup: async host => [{ address: host === "private.example.com" ? "10.0.0.1" : "8.8.8.8", family: 4 }],
      fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); },
    }), /web_page_(redirect|address)_blocked/);
    assert.equal(calls, 1);
  }
  let loops = 0;
  await assert.rejects(readResearchPage(url, "official", undefined, network(async () => {
    loops++; return new Response(null, { status: 302, headers: { location: "/design" } });
  })), /web_page_redirect_blocked/);
  assert.equal(loops, 4);
});

test("HTML reading retains titles, paragraphs and code while removing navigation without executing content", async () => {
  let requests = 0;
  const page = await readResearchPage(url, "official", undefined, network(async () => {
    requests++;
    return new Response(`<html><head><title>Design &amp; limits</title></head><body><nav>Global menu</nav>
      <main><nav>Local menu</nav><h1>How tasks run</h1><p>First paragraph.</p><p>Second paragraph.</p>
      <pre><code>if (a &lt; b) {\n  run();\n}</code></pre><a href="https://example.com/next">Related design</a>
      <script>throw new Error('must not execute')</script><style>private-style</style><footer>Footer links</footer></main>
      <aside>Outside main</aside></body></html>`, { headers: { "content-type": "text/html" } });
  }));
  assert.equal(page.title, "Design & limits");
  assert.match(page.content, /How tasks run/);
  assert.match(page.content, /First paragraph\.\n\nSecond paragraph\./);
  assert.match(page.content, /if \(a < b\) \{\n  run\(\);\n\}/);
  assert.doesNotMatch(page.content, /Global menu|Local menu|Footer links|Outside main|private-style|must not execute|https:\/\//);
  assert.equal(page.truncated, false);
  assert.equal(requests, 1);
  const fallback = await readResearchPage(url, "official", undefined, network(async () => new Response("<article><h2>Design</h2><p>Usable without main.</p></article>", { headers: { "content-type": "text/html" } })));
  assert.match(fallback.content, /Usable without main\./);
});

test("an oversized first chunk retains the bounded prefix and cancels the stream", async () => {
  let cancelled = false;
  const content = "Useful prefix\n\n" + "详细说明".repeat(30_000);
  const page = await readResearchPage(url, "official", undefined, network(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(content)); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/plain" } })));
  assert.equal(page.content, content.slice(0, 24_000));
  assert.equal(page.truncated, true);
  assert.equal(cancelled, true);
  const short = "Line one\n\n  indented code";
  const full = await readResearchPage(url, "official", undefined, network(async () => new Response(short, { headers: { "content-type": "text/plain" } })));
  assert.equal(full.content, short);
  assert.equal(full.truncated, false);
});

test("body reads respect both external cancellation and their own timeout", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  const hanging = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/plain" } });
  const pending = readResearchPage(url, "official", controller.signal, network(async () => {
    queueMicrotask(() => controller.abort(new Error("user_cancelled")));
    return hanging();
  }));
  await assert.rejects(pending, /user_cancelled/);
  assert.equal(cancelled, true);
  cancelled = false;
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => original(10));
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(readResearchPage(url, "official", undefined, network(async () => hanging())), /web_page_timeout/);
    assert.equal(cancelled, true);
  } finally { clearInterval(keepAlive); }
});

test("page failures distinguish HTTP, content and public-address restrictions without leaking responses", async () => {
  for (const [status, contentType, code] of [[503, "text/plain", "http_error"], [200, "image/png", "unsupported_content_type"]] as const) {
    let cancelled = false;
    await assert.rejects(readResearchPage(url, "official", undefined, network(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("private-body")); }, cancel() { cancelled = true; },
    }), { status, headers: { "content-type": contentType } }))), (error: unknown) => error instanceof WebPageError && error.code === code && !error.message.includes("private-body"));
    assert.equal(cancelled, true);
  }
  await assert.rejects(readResearchPage(url, "official", undefined, network(async () => new Response(" ", { headers: { "content-type": "text/plain" } }))), /web_page_empty/);
  let requests = 0;
  await assert.rejects(readResearchPage(url, "official", undefined, { lookup: async () => [{ address: "198.18.0.1", family: 4 }], fetchImpl: async () => { requests++; return new Response(""); } }), /web_page_address_blocked/);
  assert.equal(requests, 0);
  await assert.rejects(readResearchPage(url, "official", undefined, network(async () => new Response("", { status: 302, headers: { location: "https://internal.example/" } }))), /web_page_redirect_blocked/);
  await assert.rejects(readResearchPage(url, "official", undefined, network(async () => { throw new Error("private-network-detail"); })), /^Error: web_page_network$/);
});
