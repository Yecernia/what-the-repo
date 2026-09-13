import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { GithubGatewayConfig } from "./config.js";
import {
  parseGithubGatewayStartGrant,
  signGithubGatewayPayload,
  verifyGithubGatewayPayload,
  type GithubGatewayIdentityTicket,
} from "./protocol.js";

const OAUTH_COOKIE = "wtr_github_gateway_state";
const JSON_RESPONSE_LIMIT = 32 * 1024 * 1024;
const ARCHIVE_RESPONSE_LIMIT = 180 * 1024 * 1024;
const API_TIMEOUT_MS = 15_000;

interface GithubGatewayDependencies {
  config: GithubGatewayConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface OAuthSession {
  version: 1;
  kind: "github_oauth_session";
  audience?: "admin";
  nonce: string;
  state: string;
  verifier: string;
  issued_at: number;
  expires_at: number;
}

type RepositoryFetchKind = "metadata" | "commit" | "tree" | "readme" | "archive";

interface RepositoryFetchBody {
  kind?: unknown;
  owner?: unknown;
  repo?: unknown;
  ref?: unknown;
}

interface GithubUserResponse {
  id?: unknown;
  login?: unknown;
  name?: unknown;
  avatar_url?: unknown;
}

function httpError(statusCode: number, message: string, code: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function requireRepositoryAuthorization(request: FastifyRequest, secret: string): void {
  const authorization = request.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix) || !safeSecretEqual(authorization.slice(prefix.length), secret)) {
    throw httpError(401, "GitHub 网关请求未授权", "gateway_unauthorized");
  }
}

function validOwner(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value)
    && !value.endsWith("-");
}

function validRepo(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value) && value !== "." && value !== "..";
}

function validRef(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 200
    && !/[\u0000-\u001f\u007f\\~^:?*[\]]/.test(value)
    && !value.includes("..")
    && !value.startsWith("/")
    && !value.endsWith("/");
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function parseOAuthSession(value: string, secret: string, now: number): OAuthSession | null {
  const decoded = verifyGithubGatewayPayload(value, secret);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const row = decoded as Record<string, unknown>;
  if (
    row.version !== 1
    || row.kind !== "github_oauth_session"
    || typeof row.nonce !== "string"
    || !/^[a-f0-9-]{16,80}$/i.test(row.nonce)
    || typeof row.state !== "string"
    || !/^[A-Za-z0-9_-]{32,120}$/.test(row.state)
    || typeof row.verifier !== "string"
    || !/^[A-Za-z0-9_-]{43,128}$/.test(row.verifier)
    || typeof row.issued_at !== "number"
    || typeof row.expires_at !== "number"
    || row.issued_at > now + 30_000
    || row.expires_at < now
    || row.expires_at - row.issued_at > 10 * 60_000
  ) return null;
  return row as unknown as OAuthSession;
}

async function readLimitedBytes(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > limit) throw httpError(413, "GitHub 响应超过网关限制", "github_response_too_large");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw httpError(413, "GitHub 响应超过网关限制", "github_response_too_large");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, total);
}

function githubHeaders(config: GithubGatewayConfig): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Basic ${Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString("base64")}`,
    "user-agent": "what-the-repo-github-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

async function githubRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  try {
    const signal = timeoutMs === undefined ? init.signal : AbortSignal.timeout(timeoutMs);
    return await fetchImpl(url, signal ? { ...init, signal } : init);
  } catch (error) {
    throw httpError(502, "GitHub 暂时不可用", "github_unavailable");
  }
}

async function revokeGithubToken(
  fetchImpl: typeof fetch,
  config: GithubGatewayConfig,
  accessToken: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await githubRequest(
        fetchImpl,
        `https://api.github.com/applications/${encodeURIComponent(config.githubClientId)}/token`,
        {
          method: "DELETE",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Basic ${Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString("base64")}`,
            "content-type": "application/json",
            "user-agent": "what-the-repo-github-gateway",
            "x-github-api-version": "2022-11-28",
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
        API_TIMEOUT_MS,
      );
      if (response.status === 204) return true;
      console.error("[github-gateway] transient OAuth token revocation was rejected", {
        attempt,
        status: response.status,
      });
    } catch (error) {
      console.error("[github-gateway] transient OAuth token revocation failed", {
        attempt,
        error_name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return false;
}

function clearOAuthCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_COOKIE, { path: "/oauth/github" });
}

function redirectTicket(
  reply: FastifyReply,
  config: GithubGatewayConfig,
  ticket: GithubGatewayIdentityTicket,
): FastifyReply {
  if (ticket.audience === "admin" && !config.adminCallbackUrl) throw httpError(503, "Admin callback unavailable", "admin_callback_unavailable");
  const target = new URL(ticket.audience === "admin" ? config.adminCallbackUrl! : config.applicationCallbackUrl);
  target.searchParams.set("ticket", signGithubGatewayPayload(ticket, config.sharedSecret));
  clearOAuthCookie(reply);
  return reply
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .code(303)
    .header("location", target.toString())
    .send();
}

function errorTicket(
  session: OAuthSession,
  error: "access_denied" | "github_unavailable" | "invalid_response",
  now: number,
): GithubGatewayIdentityTicket {
  return {
    version: 1,
    kind: "github_oauth_result",
    outcome: "error",
    audience: session.audience,
    nonce: session.nonce,
    ticket_id: randomUUID(),
    issued_at: now,
    expires_at: now + 60_000,
    error,
  };
}

export function buildGithubGateway(dependencies: GithubGatewayDependencies): FastifyInstance {
  const { config } = dependencies;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  void app.register(cookie);

  app.setErrorHandler((error, request, reply) => {
    const status = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    const code = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : status >= 500 ? "internal_error" : "invalid_request";
    if (status >= 500) {
      console.error("[github-gateway] request failed", {
        method: request.method,
        route: request.routeOptions.url,
        status,
        code,
      });
    }
    void reply
      .header("cache-control", "no-store")
      .code(status)
      .send({ detail: status >= 500 ? "GitHub 网关暂时不可用" : error instanceof Error ? error.message : "请求不正确", code });
  });

  app.get("/health", async () => ({ ok: true, service: "github-gateway" }));

  app.get("/oauth/github/start", async (request, reply) => {
    const query = request.query as { request?: string };
    const grant = parseGithubGatewayStartGrant(query.request ?? "", config.sharedSecret, now());
    if (grant?.audience === "admin" && !config.adminCallbackUrl) throw httpError(503, "Admin callback unavailable", "admin_callback_unavailable");
    if (!grant) throw httpError(400, "登录请求已失效", "invalid_oauth_start");
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const session: OAuthSession = {
      version: 1,
      kind: "github_oauth_session",
      audience: grant.audience,
      nonce: grant.nonce,
      state,
      verifier,
      issued_at: now(),
      expires_at: now() + 10 * 60_000,
    };
    reply.setCookie(OAUTH_COOKIE, signGithubGatewayPayload(session, config.sharedSecret), {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: "lax",
      path: "/oauth/github",
      maxAge: 600,
    });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.githubClientId);
    authorize.searchParams.set("redirect_uri", `${config.publicUrl}/oauth/github/callback`);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorize.searchParams.set("code_challenge_method", "S256");
    return reply.header("cache-control", "no-store").redirect(authorize.toString());
  });

  app.get("/oauth/github/callback", async (request, reply) => {
    const currentTime = now();
    const query = request.query as { code?: string; state?: string; error?: string };
    const session = parseOAuthSession(request.cookies[OAUTH_COOKIE] ?? "", config.sharedSecret, currentTime);
    if (!session || !query.state || query.state !== session.state) {
      clearOAuthCookie(reply);
      throw httpError(400, "GitHub 登录状态已失效", "invalid_oauth_state");
    }
    if (query.error) return redirectTicket(reply, config, errorTicket(session, "access_denied", currentTime));
    if (!query.code) return redirectTicket(reply, config, errorTicket(session, "invalid_response", currentTime));

    try {
      const tokenResponse = await githubRequest(fetchImpl, "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: config.githubClientId,
          client_secret: config.githubClientSecret,
          code: query.code,
          redirect_uri: `${config.publicUrl}/oauth/github/callback`,
          code_verifier: session.verifier,
        }),
      }, API_TIMEOUT_MS);
      const tokenPayload = JSON.parse((await readLimitedBytes(tokenResponse, 64 * 1024)).toString("utf8")) as { access_token?: unknown };
      if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
        return redirectTicket(reply, config, errorTicket(session, "invalid_response", currentTime));
      }

      let github: GithubUserResponse | null = null;
      let userFailure: unknown = null;
      let userStatus = 0;
      try {
        const userResponse = await githubRequest(fetchImpl, "https://api.github.com/user", {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${tokenPayload.access_token}`,
            "user-agent": "what-the-repo-github-gateway",
            "x-github-api-version": "2022-11-28",
          },
        }, API_TIMEOUT_MS);
        userStatus = userResponse.status;
        github = JSON.parse((await readLimitedBytes(userResponse, 256 * 1024)).toString("utf8")) as GithubUserResponse;
      } catch (error) {
        userFailure = error;
      }
      const revoked = await revokeGithubToken(fetchImpl, config, tokenPayload.access_token);
      if (!revoked) return redirectTicket(reply, config, errorTicket(session, "github_unavailable", currentTime));
      if (userFailure) throw userFailure;
      if (
        userStatus < 200
        || userStatus >= 300
        || !github
        || typeof github.id !== "number"
        || !Number.isSafeInteger(github.id)
        || github.id <= 0
        || typeof github.login !== "string"
      ) return redirectTicket(reply, config, errorTicket(session, "invalid_response", currentTime));

      return redirectTicket(reply, config, {
        version: 1,
        kind: "github_oauth_result",
        outcome: "success",
        audience: session.audience,
        nonce: session.nonce,
        ticket_id: randomUUID(),
        issued_at: currentTime,
        expires_at: currentTime + 60_000,
        github: {
          id: github.id,
          login: github.login,
          name: typeof github.name === "string" ? github.name.slice(0, 255) : null,
          avatar_url: typeof github.avatar_url === "string" ? github.avatar_url.slice(0, 2_048) : null,
        },
      });
    } catch (error) {
      console.error("[github-gateway] OAuth exchange failed", {
        error_name: error instanceof Error ? error.name : "unknown",
        error_code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null,
      });
      return redirectTicket(reply, config, errorTicket(session, "github_unavailable", currentTime));
    }
  });

  app.post("/v1/github/fetch", async (request, reply) => {
    requireRepositoryAuthorization(request, config.sharedSecret);
    const body = request.body as RepositoryFetchBody | null;
    const kind = body?.kind;
    if (!body || !["metadata", "commit", "tree", "readme", "archive"].includes(String(kind))) {
      throw httpError(400, "不支持的 GitHub 请求", "invalid_github_request");
    }
    if (!validOwner(body.owner) || !validRepo(body.repo)) {
      throw httpError(400, "GitHub 仓库名称不正确", "invalid_github_repository");
    }
    const typedKind = kind as RepositoryFetchKind;
    let url: string;
    if (typedKind === "metadata") {
      url = `https://api.github.com/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}`;
    } else if (typedKind === "readme") {
      url = `https://api.github.com/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}/readme`;
    } else if (typedKind === "commit") {
      if (!validRef(body.ref)) throw httpError(400, "GitHub ref 不正确", "invalid_github_ref");
      url = `https://api.github.com/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}/commits/${encodeURIComponent(body.ref)}`;
    } else if (typedKind === "tree") {
      if (!validSha(body.ref)) throw httpError(400, "GitHub commit 不正确", "invalid_github_commit");
      url = `https://api.github.com/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}/git/trees/${body.ref}?recursive=1`;
    } else {
      if (!validSha(body.ref)) throw httpError(400, "GitHub commit 不正确", "invalid_github_commit");
      url = `https://codeload.github.com/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}/zip/${body.ref}`;
    }

    const response = await githubRequest(fetchImpl, url, {
      headers: typedKind === "archive"
        ? { accept: "application/zip", "user-agent": "what-the-repo-github-gateway" }
        : githubHeaders(config),
    });
    const payload = await readLimitedBytes(response, typedKind === "archive" ? ARCHIVE_RESPONSE_LIMIT : JSON_RESPONSE_LIMIT);
    return reply
      .header("cache-control", "no-store")
      .header("content-type", response.headers.get("content-type") ?? (typedKind === "archive" ? "application/zip" : "application/json"))
      .code(response.status)
      .send(payload);
  });

  return app;
}
