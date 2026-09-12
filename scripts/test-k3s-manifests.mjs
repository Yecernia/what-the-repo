import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");

const k3sConfig = read("infra/k8s/k3s-server-config.yaml");
const storage = read("infra/k8s/10-storage.yaml");
const postgres = read("infra/k8s/20-postgres.yaml");
const redis = read("infra/k8s/30-redis.yaml");
const migration = read("infra/k8s/40-migration.yaml");
const application = read("infra/k8s/50-application.yaml");
const evolution = read("infra/k8s/55-evolution.yaml");
const backup = read("infra/k8s/60-postgres-backup.yaml");
const restore = read("infra/k8s/70-compose-restore.yaml");
const envExample = read(".env.k3s.example");
const common = read("scripts/lib/k3s-common.sh");
const installer = read("scripts/install-k3s.sh");
const secretInitializer = read("scripts/k3s-initialize-local-secrets.sh");
const bootstrap = read("scripts/k3s-bootstrap-services.sh");
const buildImages = read("scripts/k3s-build-images.sh");
const converge = read("scripts/k3s-converge.sh");
const applyApplication = read("scripts/k3s-apply-application.sh");
const cutover = read("scripts/k3s-cutover-from-compose.sh");
const edgeSwitch = read("scripts/k3s-switch-public-edge.sh");
const backupPolicy = read("infra/tencent/cam-postgres-backup-policy.template.json");
const postgresDockerfile = read("infra/docker/postgres-walg.Dockerfile");

const required = [
  [k3sConfig, "secrets-encryption: true", "k3s Secret encryption"],
  [k3sConfig, "- traefik", "disabled bundled Traefik"],
  [k3sConfig, "- servicelb", "disabled bundled ServiceLB"],
  [k3sConfig, "- metrics-server", "disabled bundled metrics server"],
  [k3sConfig, "nodeport-addresses=127.0.0.0/8", "loopback-only NodePorts"],
  [storage, "persistentVolumeReclaimPolicy: Retain", "retained single-node storage"],
  [storage, "/var/lib/what-the-repo/k3s/postgres", "PostgreSQL host path"],
  [storage, "/var/lib/what-the-repo/k3s/redis", "Redis host path"],
  [postgres, "replicas: 1", "one PostgreSQL replica"],
  [postgres, "max_connections=\"$POSTGRES_MAX_CONNECTIONS\"", "configured PostgreSQL connection ceiling"],
  [postgres, "runAsUser: 999", "PostgreSQL volume ownership"],
  [postgres, "WALG_S3_PREFIX", "PostgreSQL WAL-G object backend"],
  [postgres, "AWS_ENDPOINT", "PostgreSQL COS endpoint"],
  [postgres, "imagePullPolicy: Never", "locally imported PostgreSQL image"],
  [postgres, "automountServiceAccountToken: false", "PostgreSQL service-account token disabled"],
  [redis, "replicas: 1", "one Redis replica"],
  [redis, "automountServiceAccountToken: false", "Redis service-account token disabled"],
  [redis, "runAsUser: 999", "Redis volume ownership"],
  [migration, "bootstrap-postgres-runtime-role", "runtime-role bootstrap"],
  [migration, "DATABASE_URL_FILE", "file-backed migration database URL"],
  [migration, "GITHUB_OAUTH_CLIENT_ID\n              value: \"\"", "migration disables OAuth client ID"],
  [migration, "GITHUB_OAUTH_CALLBACK_URL\n              value: \"\"", "migration disables OAuth callback"],
  [migration, "WHAT_THE_REPO_GITHUB_GATEWAY_URL\n              value: \"\"", "migration disables GitHub gateway configuration"],
  [migration, "automountServiceAccountToken: false", "migration service-account token disabled"],
  [migration, "mountPath: /var/lib/what-the-repo", "migration temporary data directory"],
  [migration, "name: data-dir\n          emptyDir:", "migration temporary data volume"],
  [application, "name: api", "API Deployment"],
  [application, "name: analysis-worker", "analysis Worker Deployment"],
  [application, "name: web", "Web Deployment"],
  [application, "nodePort: 30080", "fixed loopback Web NodePort"],
  [application, "replicas: 1", "single-replica first-launch baseline"],
  [application, "readOnlyRootFilesystem: true", "read-only application root filesystems"],
  [application, "automountServiceAccountToken: false", "application service-account token disabled"],
  [application, "WHAT_THE_REPO_GITHUB_GATEWAY_SHARED_SECRET_FILE", "file-backed GitHub gateway secret"],
  [evolution, "name: evolution-worker", "global Evolution Worker Deployment"],
  [evolution, "replicas: 1", "single global Evolution Worker"],
  [evolution, "type: Recreate", "no overlapping Evolution Worker rollout"],
  [evolution, "automountServiceAccountToken: false", "no Kubernetes API token in Evolution Worker"],
  [evolution, "runAsUser: 10001", "non-root Evolution Worker user"],
  [evolution, "runAsGroup: 10001", "Evolution Worker product-data group"],
  [evolution, "supplementalGroups:\n          - 988", "Docker socket group access"],
  [evolution, "/var/run/docker.sock", "isolated host Docker boundary"],
  [evolution, "WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY_FILE", "file-backed Evolution Provider key"],
  [evolution, "what-the-repo-pi-sandbox:__WTR_IMAGE_TAG__", "release-pinned Evolution sandbox"],
  [evolution, "readOnlyRootFilesystem: true", "read-only Evolution root filesystem"],
  [backup, "kind: CronJob", "daily PostgreSQL backup CronJob"],
  [backup, "schedule: \"17 3 * * *\"", "daily backup schedule"],
  [backup, "timeZone: Asia/Shanghai", "backup timezone"],
  [backup, "automountServiceAccountToken: false", "backup service-account token disabled"],
  [backup, "WALG_S3_PREFIX", "backup WAL-G object backend"],
  [envExample, "WHAT_THE_REPO_COS_BUCKET=your-product-data-1234567890", "approved Guangzhou COS bucket"],
  [envExample, "POSTGRES_BACKUP_S3_PREFIX=s3://your-product-data-1234567890/postgresql/production", "same-bucket backup prefix"],
  [envExample, "WHAT_THE_REPO_GITHUB_GATEWAY_URL=https://github.example.com", "dedicated Singapore GitHub gateway"],
  [common, "assert_k3s_environment_is_nonsecret", "non-secret configuration guard"],
  [common, "docker.io/library/$image", "containerd canonical image-name support"],
  [installer, "v1.36.3+k3s1", "pinned k3s version"],
  [installer, "INSTALL_K3S_BINARY_PATH", "verified offline k3s binary path"],
  [installer, "INSTALL_K3S_BINARY_SHA256", "offline k3s binary digest"],
  [installer, "INSTALL_K3S_SKIP_DOWNLOAD=true", "official installer offline mode"],
  [installer, "INSTALL_K3S_AIRGAP_IMAGES_PATH", "verified offline k3s system images"],
  [installer, "INSTALL_K3S_AIRGAP_IMAGES_SHA256", "offline system image digest"],
  [installer, "condition=Available deployment/coredns", "CoreDNS availability gate"],
  [installer, "condition=Available deployment/local-path-provisioner", "local storage availability gate"],
  [secretInitializer, "postgres-admin-password 32", "generated PostgreSQL administrator password"],
  [secretInitializer, "session-secret 48", "generated session secret"],
  [secretInitializer, "github-gateway-shared-secret 48", "generated GitHub gateway shared secret"],
  [secretInitializer, "external credentials still required", "external credential boundary"],
  [secretInitializer, "evolution-provider-api-key", "authorized Evolution Provider key file"],
  [bootstrap, "k3s-build-images.sh", "local image import workflow"],
  [bootstrap, "WTR_K3S_SKIP_BUILD", "pre-imported image workflow"],
  [bootstrap, "pre-imported k3s image is missing", "pre-imported image fail-closed gate"],
  [bootstrap, "what-the-repo-evolution-worker:$tag", "pre-imported Evolution Worker image gate"],
  [bootstrap, "what-the-repo-pi-sandbox:$tag", "host Docker Evolution sandbox gate"],
  [buildImages, "infra/docker/evolution-worker.Dockerfile", "Evolution Worker image build"],
  [buildImages, "evolution/pi/sandbox", "Evolution sandbox image build"],
  [applyApplication, "for deployment in api analysis-worker web evolution-worker", "Evolution Worker rollout gate"],
  [converge, "k3s-bootstrap-services.sh", "shared converge image and service gate"],
  [cutover, "--cutover --fresh-start", "explicit fresh-start cutover guard"],
  [cutover, "verified empty k3s PostgreSQL, Redis and product-data directories", "empty disposable data gate"],
  [cutover, "k3s-run-migration.sh", "empty-database schema migration"],
  [cutover, "--skip-initial-backup", "development backup deferral"],
  [cutover, "patch cronjob wtr-postgres-backup", "development backup suspension"],
  [cutover, "legacy Compose containers remain stopped", "legacy stack boundary"],
  [edgeSwitch, "127.0.0.1:30080", "host Nginx k3s upstream"],
  [backupPolicy, "your-product-data-1234567890/postgresql/production/*", "same-bucket PostgreSQL backup policy"],
  [postgresDockerfile, "FROM ${POSTGRES_IMAGE}\n\n# The runtime stage must carry the trust store too;", "runtime PostgreSQL CA trust store"],
];

for (const [content, needle, label] of required) {
  if (!content.includes(needle)) throw new Error(`k3s manifest check failed: missing ${label}`);
}

for (const forbidden of ["pg_dump", "pg_restore", "legacy_product_data_source", "compose-latest.dump"]) {
  if (cutover.includes(forbidden)) {
    throw new Error(`k3s manifest check failed: fresh-start cutover still migrates legacy data via ${forbidden}`);
  }
}

for (const [label, content] of [
  ["storage", storage],
  ["postgres", postgres],
  ["redis", redis],
  ["migration", migration],
  ["application", application],
  ["evolution", evolution],
  ["backup", backup],
  ["restore", restore],
]) {
  if (/(^|\n)(stringData|data):/m.test(content)) {
    throw new Error(`k3s manifest check failed: ${label} must not contain embedded Secret data`);
  }
}

for (const forbidden of ["scheduler", "prometheus", "alertmanager", "grafana"]) {
  if (application.includes(forbidden) || backup.includes(forbidden)) {
    throw new Error(`k3s manifest check failed: first-launch resource unexpectedly includes ${forbidden}`);
  }
}

for (const [label, content] of [["application", application], ["backup", backup], ["migration", migration]]) {
  if (content.includes("/var/run/docker.sock")) {
    throw new Error(`k3s manifest check failed: ${label} must not receive the host Docker socket`);
  }
}

if (backupPolicy.includes("ap-shanghai") || backupPolicy.includes("REPLACE_BACKUP_BUCKET")) {
  throw new Error("k3s manifest check failed: first launch backup policy must not require a Shanghai bucket");
}

for (const forbidden of ["PASSWORD=", "SECRET=", "API_KEY=", "DATABASE_URL=", "_TOKEN=", "COS_SECRET_ID=", "COS_SECRET_KEY="]) {
  if (envExample.includes(forbidden)) {
    throw new Error(`k3s manifest check failed: non-secret example contains ${forbidden}`);
  }
}

process.stdout.write(`k3s manifest checks passed (${required.length} assertions)\n`);
