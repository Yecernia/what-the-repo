import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpsUrl, createPublicFetch, safePublicHttpsUrl } from "./outbound-url.js";

test("public URL syntax gate rejects private literals and DNS rebinding aliases", () => {
  for (const value of [
    "http://api.example.com",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://127.0.0.1.nip.io/",
    "https://service.internal/",
    "https://user:pass@example.com/",
  ]) {
    assert.equal(safePublicHttpsUrl(value), null, value);
  }
  assert.equal(safePublicHttpsUrl("https://api.example.com/path#fragment"), "https://api.example.com/path");
});
test("DNS validation rejects every private address returned for a hostname", async () => {
  const lookup = async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "::ffff:127.0.0.1", family: 6 },
  ];
  await assert.rejects(
    () => assertPublicHttpsUrl("https://provider.example/", lookup),
    /outbound_address_blocked/,
  );
});

test("safe fetch validates before sending credentials and blocks redirects", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return new Response(null, { status: 302, headers: { location: "https://other.example/" } });
  };
  const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
  const fetchPublic = createPublicFetch({ fetchImpl, lookup });
  await assert.rejects(
    () => fetchPublic("https://provider.example/models", {
      headers: { authorization: "Bearer should-not-follow" },
      redirect: "follow",
    }),
    /outbound_redirect_blocked/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.redirect, "manual");

  let blockedCalls = 0;
  const blockedFetch = createPublicFetch({
    fetchImpl: async () => {
      blockedCalls += 1;
      return new Response(null, { status: 200 });
    },
    lookup,
  });
  await assert.rejects(() => blockedFetch("https://127.0.0.1/models"), /outbound_url_blocked/);
  assert.equal(blockedCalls, 0);
});
