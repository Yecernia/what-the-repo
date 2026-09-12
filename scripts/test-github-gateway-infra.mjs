import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const envExample = read(".env.github-gateway.example");
const dockerfile = read("infra/docker/github-gateway.Dockerfile");
const runtimePackage = read("infra/docker/github-gateway/package.json");
const nginx = read("infra/nginx/github-gateway.nginx.conf.template");
const deploy = read("scripts/deploy-github-gateway.sh");
const edge = read("scripts/install-github-gateway-edge.sh");
const application = read("infra/k8s/50-application.yaml");
const secrets = read("scripts/k3s-apply-secrets.sh");

const required = [
  [envExample, "GITHUB_GATEWAY_PUBLIC_URL=https://github.example.com", "gateway public URL"],
  [envExample, "GITHUB_GATEWAY_APPLICATION_CALLBACK_URL=https://example.com/api/auth/github/callback", "application callback"],
  [runtimePackage, '"fastify": "5.12.0"', "minimal Fastify runtime"],
  [dockerfile, "COPY --from=build /source/server/dist/github-gateway ./dist/github-gateway", "gateway-only compiled source"],
  [dockerfile, "USER 10002:10002", "non-root gateway user"],
  [nginx, "location = /oauth/github/start", "public OAuth start route"],
  [nginx, "location = /oauth/github/callback", "public OAuth callback route"],
  [nginx, "location = /v1/github/fetch", "bounded repository route"],
  [nginx, "allow __GUANGZHOU_IP__;", "Guangzhou source allowlist"],
  [nginx, "location / {\n        return 404;", "default deny route"],
  [deploy, "--read-only", "read-only container root"],
  [deploy, "--cap-drop ALL", "empty Linux capabilities"],
  [deploy, "--publish 127.0.0.1:8408:8408", "loopback-only container port"],
  [deploy, "github-oauth-client-secret", "file-backed OAuth secret"],
  [deploy, "github-gateway-shared-secret", "file-backed shared secret"],
  [edge, "apt-get upgrade --yes", "host security updates"],
  [application, "WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET_FILE", "k3s gateway client secret mount"],
  [secrets, "github-gateway-shared-secret:github-gateway-shared-secret", "shared secret distribution"],
];

for (const [content, needle, label] of required) {
  if (!content.includes(needle)) throw new Error(`GitHub gateway infrastructure check failed: missing ${label}`);
}

for (const forbidden of [
  "GITHUB_OAUTH_CLIENT_SECRET=",
  "GITHUB_GATEWAY_SHARED_SECRET=",
  "WHAT_THE_REPO_FREE_PROVIDER",
  "WHAT_THE_REPO_FEEDBACK_PROVIDER",
  "WHAT_THE_REPO_EVOLUTION_PROVIDER",
  "WHAT_THE_REPO_COS_",
  "DATABASE_URL",
]) {
  if (envExample.includes(forbidden)) {
    throw new Error(`GitHub gateway infrastructure check failed: gateway env contains ${forbidden}`);
  }
}

if (!nginx.includes("proxy_buffering off;") || nginx.includes("proxy_pass http://$http")) {
  throw new Error("GitHub gateway infrastructure check failed: repository proxy is not a fixed streaming upstream");
}

process.stdout.write(`GitHub gateway infrastructure checks passed (${required.length} assertions)\n`);
