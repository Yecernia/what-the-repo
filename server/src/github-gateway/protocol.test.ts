import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGithubGatewayIdentityTicket,
  parseGithubGatewayStartGrant,
  signGithubGatewayPayload,
} from "./protocol.js";

const secret = "gateway-test-secret-012345678901234567890123456789";
const now = Date.parse("2026-08-28T12:00:00.000Z");

test("GitHub gateway protocol signs and verifies a start grant", () => {
  const token = signGithubGatewayPayload({
    version: 1,
    kind: "github_oauth_start",
    nonce: "12345678-1234-1234-1234-123456789012",
    issued_at: now,
    expires_at: now + 60_000,
  }, secret);
  assert.deepEqual(parseGithubGatewayStartGrant(token, secret, now), {
    version: 1,
    kind: "github_oauth_start",
    nonce: "12345678-1234-1234-1234-123456789012",
    issued_at: now,
    expires_at: now + 60_000,
  });
});

test("GitHub gateway protocol rejects tampering and expiry", () => {
  const token = signGithubGatewayPayload({
    version: 1,
    kind: "github_oauth_start",
    nonce: "12345678-1234-1234-1234-123456789012",
    issued_at: now,
    expires_at: now + 60_000,
  }, secret);
  assert.equal(parseGithubGatewayStartGrant(`${token.slice(0, -1)}x`, secret, now), null);
  assert.equal(parseGithubGatewayStartGrant(token, secret, now + 60_001), null);
});

test("GitHub gateway protocol validates a minimal identity ticket", () => {
  const token = signGithubGatewayPayload({
    version: 1,
    kind: "github_oauth_result",
    outcome: "success",
    nonce: "12345678-1234-1234-1234-123456789012",
    ticket_id: "abcdef12-1234-1234-1234-123456789012",
    issued_at: now,
    expires_at: now + 60_000,
    github: {
      id: 42,
      login: "octocat",
      name: "The Octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/583231",
    },
  }, secret);
  const ticket = parseGithubGatewayIdentityTicket(token, secret, now);
  assert.equal(ticket?.outcome, "success");
  if (ticket?.outcome === "success") assert.equal(ticket.github.id, 42);
});
