import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicGithubHead, fetchPublicGithubSource, fetchResearchPage, safeResearchUrl, readGithubArchive } from "./github.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { zipSync, strToU8 } from "fflate";

test("archive download enforces size before buffering and stops an in-flight body on cancellation", async () => {
  let cancelled = 0;
  const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled++; } });
  await assert.rejects(readGithubArchive(new Response(body(), { headers: { "content-length": "100" } }), undefined, 8), /too_large/);
  await assert.rejects(readGithubArchive(new Response(body()), undefined, 8), /too_large/);
  assert.equal(cancelled, 2);
  const controller = new AbortController();
  const pending = readGithubArchive(new Response(new ReadableStream({ cancel() { cancelled++; } })), controller.signal, 8);
  controller.abort(new Error("analysis_cancelled"));
  await assert.rejects(pending, /analysis_cancelled/);
  assert.equal(cancelled, 3);
  assert.equal(Buffer.from(await readGithubArchive(new Response("source"), undefined, 8)).toString(), "source");
});

test("source fetch pins the queued commit and binds README to the downloaded archive", async () => {
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), "queued-github-"));
  const pinned = "a".repeat(40), latest = "b".repeat(40);
  const requests: Array<Record<string, string>> = [];
  let mismatch = false;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (body.kind === "metadata") return Response.json({ default_branch: "main", homepage: "https://docs.example.com/" });
      if (body.kind === "commit") return Response.json({ sha: mismatch || body.ref === "main" ? latest : pinned });
      if (body.kind === "tree") return Response.json({ tree: [{ path: "README.md", type: "blob", size: 20 }] });
      if (body.kind === "archive") return new Response(new Uint8Array(zipSync({ "repo/README.md": strToU8("Pinned source documentation") })).buffer);
      throw new Error("unexpected_request");
    }) as typeof fetch;
    const gateway = { baseUrl: "https://gateway.example", sharedSecret: "test-secret" };
    let resolvedBeforeArchive = false;
    const fetched = await fetchPublicGithubSource("https://github.com/example/repository", join(root, "source"), null, null, gateway, undefined, pinned, async head => {
      assert.equal(head.commitSha, pinned);
      assert.deepEqual(requests.map(r => r.kind), ["metadata", "commit"]);
      resolvedBeforeArchive = true;
    });
    assert.equal(resolvedBeforeArchive, true);
    assert.equal(fetched.commitSha, pinned);
    assert.equal(await readFile(join(root, "source", "README.md"), "utf8"), "Pinned source documentation");
    assert.equal(fetched.research.readme?.content, "Pinned source documentation");
    assert.equal(fetched.research.official_pages[0]?.url, "https://docs.example.com/");
    assert.equal(fetched.research.official_pages[0]?.content, "");
    assert.deepEqual(requests.map(r => r.kind), ["metadata", "commit", "tree", "archive"]);
    assert.ok(requests.filter(r => r.kind !== "metadata").every(r => r.ref === pinned));
    mismatch = true; requests.length = 0;
    await assert.rejects(fetchPublicGithubSource("https://github.com/example/repository", join(root, "mismatch"), null, null, gateway, undefined, pinned), /github_target_commit_mismatch/u);
    assert.deepEqual(requests.map(r => r.kind), ["metadata", "commit"]);
    requests.length = 0;
    await assert.rejects(fetchPublicGithubSource("https://github.com/example/repository", join(root, "invalid"), null, null, gateway, undefined, "main"), /github_invalid_target_commit/u);
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub head lookup uses the bounded gateway transport when configured", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      if (body.kind === "metadata") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (body.kind === "commit") {
        return new Response(JSON.stringify({ sha: "0123456789abcdef0123456789abcdef01234567" }), { status: 200 });
      }
      throw new Error(`unexpected gateway request: ${JSON.stringify(body)}`);
    }) as typeof fetch;

    const head = await fetchPublicGithubHead(
      "https://github.com/octocat/Spoon-Knife",
      null,
      null,
      {
        baseUrl: "https://github.example.com/",
        sharedSecret: "gateway-test-secret-012345678901234567890123456789",
      },
    );
    assert.deepEqual(head, {
      owner: "octocat",
      repo: "Spoon-Knife",
      repository: "octocat/Spoon-Knife",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    assert.deepEqual(requests.map((request) => request.url), [
      "https://github.example.com/v1/github/fetch",
      "https://github.example.com/v1/github/fetch",
    ]);
    assert.equal(requests.every((request) => request.authorization === "Bearer gateway-test-secret-012345678901234567890123456789"), true);
    assert.deepEqual(requests.map((request) => request.body), [
      { kind: "metadata", owner: "octocat", repo: "Spoon-Knife" },
      { kind: "commit", owner: "octocat", repo: "Spoon-Knife", ref: "main" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("untrusted research pages reject reserved DNS addresses before fetching", async () => {
  let fetched = false;
  const page = await fetchResearchPage('https://example.com/design', 'official', undefined, {
    lookup: async () => [{ address: '198.18.0.1', family: 4 }],
    fetchImpl: async () => { fetched = true; return new Response(''); },
  });
  assert.equal(page, null);
  assert.equal(fetched, false);
});

test("research URLs reject internal aliases and never follow redirects", async () => {
  assert.equal(safeResearchUrl("https://[::1]/docs"), null);
  assert.equal(safeResearchUrl("https://127.0.0.1.nip.io/docs"), null);
  assert.equal(safeResearchUrl("http://public.example/docs"), null);

  const calls: Array<{ init?: RequestInit }> = [];
  const page = await fetchResearchPage(
    "https://docs.example/project#section",
    "official",
    undefined,
    {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImpl: async (_input, init) => {
        calls.push({ init });
        return new Response("", { status: 302, headers: { location: "https://internal.example/" } });
      },
    },
  );
  assert.equal(page, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.redirect, "manual");
});
