import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nginx = readFileSync(resolve(root, "infra/docker/web.nginx.conf"), "utf8");
const headers = readFileSync(resolve(root, "infra/docker/nginx-security-headers.conf"), "utf8");
const dockerfile = readFileSync(resolve(root, "infra/docker/web.Dockerfile"), "utf8");
const publicEdge = readFileSync(resolve(root, "infra/docker/public-edge.nginx.conf.template"), "utf8");
const gitAttributes = readFileSync(resolve(root, ".gitattributes"), "utf8");

const required = [
  [publicEdge, "server_name __DOMAIN__;", "generic TLS domain placeholder"],
  [publicEdge, "proxy_pass http://__APP_UPSTREAM__;", "generic edge upstream"],
  [publicEdge, "proxy_buffering off;", "edge SSE streaming"],
  [headers, "frame-ancestors 'none'", "CSP frame policy"],
  [headers, 'X-Content-Type-Options "nosniff"', "MIME sniffing protection"],
  [headers, 'Referrer-Policy "strict-origin-when-cross-origin"', "referrer policy"],
  [headers, 'Permissions-Policy "camera=(), microphone=(), geolocation=()"', "permissions policy"],
  [nginx, "include /etc/nginx/nginx-security-headers.conf;", "server security headers include"],
  [nginx, "limit_req_zone $binary_remote_addr zone=api_per_ip:10m rate=30r/s;", "API rate-limit zone"],
  [nginx, "limit_req_status 429;", "rate-limit status"],
  [nginx, "server api:8307;", "portable API service discovery"],
  [nginx, "their own internal DNS", "portable service DNS rationale"],
  [nginx, "least_conn;", "API replica balancing"],
  [nginx, "proxy_pass http://what_the_repo_api;", "API upstream group"],
  [nginx, "proxy_next_upstream_tries 2;", "API failover attempt"],
  [nginx, "limit_req zone=api_per_ip burst=60 nodelay;", "API burst limit"],
  [nginx, "limit_req zone=api_per_ip burst=10 nodelay;", "SSE burst limit"],
  [nginx, "location ~ ^/api/projects/[^/]+/messages/stream$", "SSE location"],
  [nginx, "proxy_buffering off;", "SSE buffering disabled"],
  [nginx, "proxy_request_buffering off;", "SSE request buffering disabled"],
  [nginx, "proxy_read_timeout 300s;", "SSE timeout"],
  [nginx, "set_real_ip_from 127.0.0.1;", "local proxy trust"],
  [nginx, "real_ip_header X-Forwarded-For;", "forwarded client address"],
  [nginx, "real_ip_recursive on;", "recursive forwarded client address"],
  [nginx, 'Cache-Control "public, max-age=31536000, immutable"', "hashed asset cache"],
  [nginx, 'Cache-Control "no-cache"', "HTML shell cache"],
  [dockerfile, "COPY infra/docker/nginx-security-headers.conf /etc/nginx/nginx-security-headers.conf", "runtime header file"],
  [gitAttributes, "*.sh text eol=lf", "Shell archive line endings"],
  [gitAttributes, "infra/postgres/wtr-* text eol=lf", "PostgreSQL shell archive line endings"],
];

for (const [content, needle, label] of required) {
  if (!content.includes(needle)) throw new Error(`web gateway check failed: missing ${label}`);
}

if (nginx.indexOf("location ~ ^/api/projects/[^/]+/messages/stream$") > nginx.indexOf("location /api/")) {
  throw new Error("web gateway check failed: SSE regex location must precede the generic API location");
}

process.stdout.write(`web gateway checks passed (${required.length} assertions)\n`);
