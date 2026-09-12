import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const production = read("compose.production.yaml");
const compose = read("compose.yaml");
const example = read(".env.production.example");
const preflight = read("scripts/production-preflight.sh");
const backup = read("scripts/run-production-backup.sh");
const restore = read("scripts/run-production-restore-drill.sh");
const probe = read("scripts/run-production-public-probe.sh");
const installer = read("scripts/install-production-operations.sh");
const secretPermissions = read("scripts/prepare-production-secret-permissions.sh");
const converge = read("scripts/production-converge.sh");
const productionPrometheus = read("infra/monitoring/prometheus.production.yml");
const productionRules = read("infra/monitoring/rules-production/what-the-repo-production.yml");
const serverDockerfile = read("infra/docker/server.Dockerfile");

const required = [
  [compose, "DATABASE_URL_FILE: ${DATABASE_URL_FILE:-}", "database URL file support"],
  [compose, "GITHUB_OAUTH_CLIENT_SECRET_FILE", "GitHub OAuth secret file support"],
  [compose, "WHAT_THE_REPO_SESSION_SECRET_FILE", "session secret file support"],
  [compose, "WHAT_THE_REPO_COS_SECRET_ID_FILE", "COS SecretId file support"],
  [compose, "WHAT_THE_REPO_METRICS_TOKEN_FILE", "metrics token file support"],
  [production, "ports: !reset []", "production API host-port removal"],
  [production, 'user: "101:101"', "non-root production Web gateway"],
  [production, "DATABASE_URL_FILE: /run/secrets/postgres_runtime_database_url", "runtime database URL secret"],
  [production, "DATABASE_URL_FILE: /run/secrets/postgres_admin_database_url", "migration database URL secret"],
  [production, "POSTGRES_PASSWORD_FILE: /run/secrets/postgres_admin_password", "PostgreSQL password secret"],
  [production, "image: prom/node-exporter:v1.12.1", "pinned node exporter"],
  [production, 'profiles: ["operations"]', "isolated restore profile"],
  [example, "POSTGRES_BACKUP_FILE_PREFIX=", "same-server backup disabled"],
  [example, "POSTGRES_BACKUP_S3_SSE=AES256", "backup server-side encryption"],
  [example, "WHAT_THE_REPO_COS_PREFIX=what-the-repo/production", "production object prefix"],
  [preflight, "database backups must use a bucket separate from live product objects", "backup bucket isolation"],
  [preflight, "must not contain an Evolution Provider key", "Evolution key exclusion"],
  [backup, "what_the_repo_postgres_backup_last_success_unixtime", "backup success metric"],
  [restore, "post-backup WAL marker", "post-backup WAL restore verification"],
  [restore, "com.docker.compose.volume", "restore volume ownership check"],
  [probe, '"model_configured"', "configured-model public probe"],
  [installer, "what-the-repo-postgres-backup.timer", "backup timer"],
  [installer, "what-the-repo-postgres-restore-drill.timer", "restore timer"],
  [installer, "what-the-repo-public-probe.timer", "public probe timer"],
  [secretPermissions, 'chmod 0444 "$path"', "Compose Secret file permissions"],
  [secretPermissions, 'chmod 0600 "$ENV_FILE"', "production environment permissions"],
  [converge, '--scale "api=$api_replicas"', "API replicas"],
  [converge, '--scale "analysis-worker=$worker_replicas"', "analysis worker replicas"],
  [converge, "Evolution Worker is running without production authorization", "Evolution runtime guard"],
  [productionPrometheus, "node-exporter:9100", "host metrics scrape"],
  [productionRules, "WhatTheRepoPostgresBackupStale", "stale backup alert"],
  [productionRules, "WhatTheRepoRestoreDrillFailed", "restore failure alert"],
  [productionRules, "WhatTheRepoPublicHttpsProbeFailed", "public probe alert"],
  [productionRules, "WhatTheRepoTlsCertificateExpiring", "TLS expiry alert"],
  [serverDockerfile, "apt-get -o Acquire::Retries=5 upgrade --yes", "runtime operating-system security updates"],
  [serverDockerfile, "for attempt in 1 2 3 4 5", "runtime package mirror retries"],
  [serverDockerfile, "rm -rf /usr/local/lib/node_modules/npm", "runtime package-manager removal"],
];

for (const [content, needle, label] of required) {
  if (!content.includes(needle)) throw new Error(`production operations check failed: missing ${label}`);
}

if (production.includes("EVOLUTION_PROVIDER_API_KEY_FILE: /run/secrets")) {
  throw new Error("production operations check failed: production overlay mounts an Evolution Provider key");
}
if (!example.includes("POSTGRES_BACKUP_S3_PREFIX=s3://replace-with-cross-region-backup-bucket/")) {
  throw new Error("production operations check failed: backup example is not explicitly cross-region");
}

process.stdout.write(`production operations checks passed (${required.length + 2} assertions)\n`);
