import http from "node:http";
import https from "node:https";
import process from "node:process";

const domain = process.argv[2] || "example.com";
const connectHost = process.argv[3] || domain;
const total = parsePositiveInt(process.env.PUBLIC_EDGE_REQUESTS, 180);
const concurrency = Math.min(total, parsePositiveInt(process.env.PUBLIC_EDGE_CONCURRENCY, 60));
const timeoutMs = parsePositiveInt(process.env.PUBLIC_EDGE_TIMEOUT_MS, 10_000);
const agent = new https.Agent({ keepAlive: true, maxSockets: concurrency });

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid positive integer: ${value}`);
  }
  return parsed;
}

function request({ protocol = "https:", servername = domain, hostHeader = domain, path = "/", headers = {} }) {
  const client = protocol === "https:" ? https : http;
  const startedAt = performance.now();

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol,
      host: connectHost,
      port: protocol === "https:" ? 443 : 80,
      servername: protocol === "https:" ? servername : undefined,
      rejectUnauthorized: true,
      agent: protocol === "https:" ? agent : undefined,
      method: "GET",
      path,
      headers: { host: hostHeader, connection: "keep-alive", ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const ttfbMs = performance.now() - startedAt;
      const certificate = protocol === "https:" ? res.socket?.getPeerCertificate() || null : null;
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 16_384) chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          ttfbMs,
          totalMs: performance.now() - startedAt,
          certificate,
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end();
  });
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2));
}

async function runBurst() {
  const results = [];
  let next = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= total) return;
      try {
        const response = await request({
          path: "/api/health",
          headers: { "x-forwarded-for": `203.0.113.${(index % 200) + 1}` },
        });
        results.push({ status: response.status, ttfbMs: response.ttfbMs, totalMs: response.totalMs });
      } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

const root = await request({});
requireCondition(root.status === 200, `root returned ${root.status}`);
requireCondition(root.headers["strict-transport-security"] === "max-age=31536000", "missing HSTS");
requireCondition(Boolean(root.headers["content-security-policy"]), "missing CSP");
requireCondition(root.certificate?.subjectaltname?.includes(`DNS:${domain}`), "root certificate SAN mismatch");

const health = await request({ path: "/api/health" });
requireCondition(health.status === 200, `health returned ${health.status}`);
const healthPayload = JSON.parse(health.body);
requireCondition(healthPayload.ok === true && healthPayload.storage === "postgres", "unexpected health payload");

const httpRedirect = await request({ protocol: "http:", path: "/edge-smoke?from=http" });
requireCondition(httpRedirect.status === 301, `HTTP redirect returned ${httpRedirect.status}`);
requireCondition(httpRedirect.headers.location === `https://${domain}/edge-smoke?from=http`, "HTTP redirect target mismatch");

const wwwRedirect = await request({
  servername: `www.${domain}`,
  hostHeader: `www.${domain}`,
  path: "/edge-smoke?from=www",
});
requireCondition(wwwRedirect.status === 301, `www redirect returned ${wwwRedirect.status}`);
requireCondition(wwwRedirect.headers.location === `https://${domain}/edge-smoke?from=www`, "www redirect target mismatch");
requireCondition(wwwRedirect.certificate?.subjectaltname?.includes(`DNS:www.${domain}`), "www certificate SAN mismatch");

await new Promise((resolve) => setTimeout(resolve, 2_000));
const burst = await runBurst();
const statuses = Object.create(null);
const errors = [];
const ttfb = [];
const totalTimes = [];
for (const result of burst) {
  if (result.error) {
    errors.push(result.error);
    continue;
  }
  statuses[result.status] = (statuses[result.status] || 0) + 1;
  ttfb.push(result.ttfbMs);
  totalTimes.push(result.totalMs);
}

const unexpectedStatuses = Object.keys(statuses).filter((status) => status !== "200" && status !== "429");
requireCondition(errors.length === 0, `burst had ${errors.length} request errors`);
requireCondition(unexpectedStatuses.length === 0, `unexpected burst statuses: ${unexpectedStatuses.join(", ")}`);
requireCondition((statuses[200] || 0) > 0, "burst had no successful requests");
requireCondition((statuses[429] || 0) > 0, "spoofed X-Forwarded-For bypassed or did not reach the rate limit");

console.log(JSON.stringify({
  ok: true,
  target: { domain, connect_host: connectHost },
  checks: {
    root_status: root.status,
    health: healthPayload,
    http_redirect: httpRedirect.headers.location,
    www_redirect: wwwRedirect.headers.location,
    certificate_sans: root.certificate.subjectaltname,
  },
  burst: {
    requests: total,
    concurrency,
    statuses,
    errors: errors.length,
    ttfb_ms: { p50: percentile(ttfb, 0.5), p95: percentile(ttfb, 0.95), p99: percentile(ttfb, 0.99) },
    total_ms: { p50: percentile(totalTimes, 0.5), p95: percentile(totalTimes, 0.95), p99: percentile(totalTimes, 0.99) },
  },
}, null, 2));
