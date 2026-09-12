import http from "node:http";
import https from "node:https";
import process from "node:process";

const domain = process.argv[2] || "github.example.com";
const connectHost = process.argv[3] || domain;
const timeoutMs = 15_000;

function request(path, protocol = "https:") {
  const client = protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol,
      host: connectHost,
      port: protocol === "https:" ? 443 : 80,
      servername: protocol === "https:" ? domain : undefined,
      rejectUnauthorized: true,
      method: "GET",
      path,
      headers: { host: domain },
      timeout: timeoutMs,
    }, (res) => {
      const certificate = protocol === "https:" ? res.socket?.getPeerCertificate() || null : null;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        certificate,
      }));
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await request("/health");
requireCondition(health.status === 200, `health returned ${health.status}`);
const healthPayload = JSON.parse(health.body);
requireCondition(healthPayload.ok === true && healthPayload.service === "github-gateway", "unexpected health payload");
requireCondition(health.headers["strict-transport-security"] === "max-age=31536000", "missing HSTS");
requireCondition(health.certificate?.subjectaltname?.includes(`DNS:${domain}`), "certificate SAN mismatch");

const unknown = await request("/not-an-endpoint");
requireCondition(unknown.status === 404, `unknown route returned ${unknown.status}`);
const repository = await request("/v1/github/fetch");
requireCondition(repository.status === 403, `public repository route returned ${repository.status}`);
const invalidStart = await request("/oauth/github/start");
requireCondition(invalidStart.status === 400, `invalid OAuth start returned ${invalidStart.status}`);
const redirect = await request("/health?from=http", "http:");
requireCondition(redirect.status === 301, `HTTP redirect returned ${redirect.status}`);
requireCondition(redirect.headers.location === `https://${domain}/health?from=http`, "HTTP redirect target mismatch");

console.log(JSON.stringify({
  ok: true,
  target: { domain, connect_host: connectHost },
  checks: {
    health: healthPayload,
    certificate_sans: health.certificate.subjectaltname,
    unknown_status: unknown.status,
    public_repository_status: repository.status,
    invalid_oauth_start_status: invalidStart.status,
    http_redirect: redirect.headers.location,
  },
}, null, 2));
