import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GithubGatewayConfig } from "./config.js";
import { buildGithubGateway } from "./app.js";
import {
  parseGithubGatewayIdentityTicket,
  signGithubGatewayPayload,
  verifyGithubGatewayPayload,
} from "./protocol.js";

const now = Date.parse("2026-08-28T12:00:00.000Z");
const sharedSecret = "gateway-test-secret-012345678901234567890123456789";

function config(): GithubGatewayConfig {
  return {
    host: "127.0.0.1",
    port: 8408,
    nodeEnv: "test",
    publicUrl: "https://github.example.com",
    applicationCallbackUrl: "https://example.com/api/auth/github/callback",
    sharedSecret,
    githubClientId: "github-client",
    githubClientSecret: "github-secret",
  };
}

function cookieValue(headers: string | string[] | undefined, name: string): string {
  const rows = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const row = rows.find((item) => item.startsWith(`${name}=`));
  assert.ok(row, `missing cookie ${name}`);
  return row.split(";", 1)[0].slice(name.length + 1);
}

async function startOAuth(app: ReturnType<typeof buildGithubGateway>, audience?: "admin"): Promise<{
  cookie: string;
  state: string;
  verifier: string;
}> {
  const grant = signGithubGatewayPayload({
    version: 1,
    kind: "github_oauth_start",
    audience,
    nonce: "12345678-1234-1234-1234-123456789012",
    issued_at: now,
    expires_at: now + 60_000,
  }, sharedSecret);
  const response = await app.inject({ method: "GET", url: `/oauth/github/start?request=${encodeURIComponent(grant)}` });
  assert.equal(response.statusCode, 302);
  const location = new URL(String(response.headers.location));
  assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(location.searchParams.get("redirect_uri"), "https://github.example.com/oauth/github/callback");
  assert.equal(location.searchParams.has("scope"), false);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  const cookie = cookieValue(response.headers["set-cookie"], "wtr_github_gateway_state");
  const decoded = verifyGithubGatewayPayload(cookie, sharedSecret) as { verifier: string; state: string };
  assert.equal(location.searchParams.get("code_challenge"), createHash("sha256").update(decoded.verifier).digest("base64url"));
  return { cookie, state: decoded.state, verifier: decoded.verifier };
}

test("GitHub gateway completes OAuth, revokes the transient token and signs identity", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const app = buildGithubGateway({
    config: config(),
    now: () => now,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 42, login: "octocat", name: "Octo", avatar_url: "https://avatars.githubusercontent.com/u/42" }), { status: 200 });
      }
      if (url === "https://api.github.com/applications/github-client/token") return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  });
  await app.ready();
  try {
    const started = await startOAuth(app);
    const response = await app.inject({
      method: "GET",
      url: `/oauth/github/callback?code=test-code&state=${encodeURIComponent(started.state)}`,
      headers: { cookie: `wtr_github_gateway_state=${started.cookie}` },
    });
    assert.equal(response.statusCode, 303);
    const location = new URL(String(response.headers.location));
    assert.equal(location.origin + location.pathname, "https://example.com/api/auth/github/callback");
    const ticket = parseGithubGatewayIdentityTicket(location.searchParams.get("ticket") ?? "", sharedSecret, now);
    assert.equal(ticket?.outcome, "success");
    if (ticket?.outcome === "success") {
      assert.equal(ticket.github.id, 42);
      assert.equal(ticket.nonce, "12345678-1234-1234-1234-123456789012");
    }
    const exchange = JSON.parse(String(requests[0]?.init?.body)) as { code_verifier: string };
    assert.equal(exchange.code_verifier, started.verifier);
    assert.equal(requests[2]?.init?.method, "DELETE");
    assert.doesNotMatch(JSON.stringify(response.payload), /temporary-token/);
  } finally {
    await app.close();
  }
});

test("GitHub admin OAuth keeps its audience and uses only the configured admin callback", async () => {
  const app = buildGithubGateway({
    config: { ...config(), adminCallbackUrl: "https://admin.example.com/api/auth/github/callback" },
    now: () => now,
    fetchImpl: (async () => { throw new Error("OAuth denial must not call upstream"); }) as typeof fetch,
  });
  await app.ready();
  try {
    const started = await startOAuth(app, "admin");
    const response = await app.inject({
      method: "GET",
      url: `/oauth/github/callback?error=access_denied&state=${encodeURIComponent(started.state)}&redirect_uri=https://untrusted.example/callback`,
      headers: { cookie: `wtr_github_gateway_state=${started.cookie}` },
    });
    assert.equal(response.statusCode, 303);
    const location = new URL(String(response.headers.location));
    assert.equal(location.origin + location.pathname, "https://admin.example.com/api/auth/github/callback");
    const ticket = parseGithubGatewayIdentityTicket(location.searchParams.get("ticket") ?? "", sharedSecret, now);
    assert.equal(ticket?.audience, "admin");
    assert.equal(ticket?.outcome, "error");
  } finally {
    await app.close();
  }
});

test("GitHub admin OAuth is unavailable until its callback is configured", async () => {
  const app = buildGithubGateway({ config: config(), now: () => now });
  await app.ready();
  try {
    const grant = signGithubGatewayPayload({
      version: 1,
      kind: "github_oauth_start",
      audience: "admin",
      nonce: "12345678-1234-1234-1234-123456789012",
      issued_at: now,
      expires_at: now + 60_000,
    }, sharedSecret);
    const response = await app.inject({ method: "GET", url: `/oauth/github/start?request=${encodeURIComponent(grant)}` });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.json().code, "admin_callback_unavailable");
  } finally {
    await app.close();
  }
});

test("GitHub gateway repository transport is bearer protected and path constrained", async () => {
  const fetched: string[] = [];
  const app = buildGithubGateway({
    config: config(),
    fetchImpl: (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await app.ready();
  try {
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/github/fetch",
      payload: { kind: "metadata", owner: "octocat", repo: "Spoon-Knife" },
    });
    assert.equal(unauthorized.statusCode, 401);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/github/fetch",
      headers: { authorization: `Bearer ${sharedSecret}` },
      payload: { kind: "metadata", owner: "..", repo: "anything" },
    });
    assert.equal(invalid.statusCode, 400);
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/github/fetch",
      headers: { authorization: `Bearer ${sharedSecret}` },
      payload: { kind: "metadata", owner: "octocat", repo: "Spoon-Knife" },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(fetched, ["https://api.github.com/repos/octocat/Spoon-Knife"]);
  } finally {
    await app.close();
  }
});

test("GitHub gateway repository transport has no fixed request timeout", async () => {
  const requests: Array<{ url: string; signal: AbortSignal | null }> = [];
  const app = buildGithubGateway({
    config: config(),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, signal: init?.signal ?? null });
      if (url.includes("/zip/")) return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200 });
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await app.ready();
  try {
    const headers = { authorization: `Bearer ${sharedSecret}` };
    const metadata = await app.inject({
      method: "POST",
      url: "/v1/github/fetch",
      headers,
      payload: { kind: "metadata", owner: "octocat", repo: "Spoon-Knife" },
    });
    assert.equal(metadata.statusCode, 200);
    const archive = await app.inject({
      method: "POST",
      url: "/v1/github/fetch",
      headers,
      payload: { kind: "archive", owner: "octocat", repo: "Spoon-Knife", ref: "0123456789abcdef0123456789abcdef01234567" },
    });
    assert.equal(archive.statusCode, 200);
    assert.deepEqual(requests.map((request) => request.signal), [null, null]);
  } finally {
    await app.close();
  }
});

test("GitHub gateway revokes a transient token even when the user response is invalid", async () => {
  const requests: string[] = [];
  const app = buildGithubGateway({
    config: config(),
    now: () => now,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response("not-json", { status: 200 });
      }
      if (url === "https://api.github.com/applications/github-client/token") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
  });
  await app.ready();
  try {
    const started = await startOAuth(app);
    const response = await app.inject({
      method: "GET",
      url: `/oauth/github/callback?code=test-code&state=${encodeURIComponent(started.state)}`,
      headers: { cookie: `wtr_github_gateway_state=${started.cookie}` },
    });
    assert.equal(response.statusCode, 303);
    const ticket = parseGithubGatewayIdentityTicket(
      new URL(String(response.headers.location)).searchParams.get("ticket") ?? "",
      sharedSecret,
      now,
    );
    assert.equal(ticket?.outcome, "error");
    if (ticket?.outcome === "error") assert.equal(ticket.error, "github_unavailable");
    assert.deepEqual(requests, [
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/applications/github-client/token",
    ]);
  } finally {
    await app.close();
  }
});
