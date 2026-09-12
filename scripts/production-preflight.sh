#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-common.sh
source "$SCRIPT_DIR/lib/production-common.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run the production preflight as root so it can verify secret permissions" >&2
  exit 77
fi

prepare_operations_directories

required_secrets=(
  postgres-admin-password
  postgres-runtime-password
  postgres-admin-database-url
  postgres-runtime-database-url
  github-oauth-client-secret
  session-secret
  key-encryption-secret
  free-provider-api-key
  feedback-provider-api-key
  cos-secret-id
  cos-secret-key
  mcp-token
  metrics-token
  grafana-admin-password
  alertmanager.yml
  postgres-backup-access-key-id
  postgres-backup-secret-access-key
)

if [[ ! -d "$WTR_SECRET_ROOT" ]]; then
  echo "missing production secret directory: $WTR_SECRET_ROOT" >&2
  exit 66
fi
secret_directory_mode="$(stat -c '%a' -- "$WTR_SECRET_ROOT")"
if (( (8#$secret_directory_mode & 077) != 0 )); then
  echo "production secret directory must not be accessible by group or other users" >&2
  exit 77
fi

for name in "${required_secrets[@]}"; do
  path="$WTR_SECRET_ROOT/$name"
  require_regular_file "$path" "production secret"
  if [[ ! -s "$path" ]]; then
    echo "production secret is empty: $name" >&2
    exit 65
  fi
  mode="$(stat -c '%a' -- "$path")"
  if [[ "$mode" != "444" ]]; then
    echo "production Secret files must be root-owned mode 0444 inside the root-only 0700 directory: $name" >&2
    exit 77
  fi
  if [[ "$(stat -c '%u' -- "$path")" -ne 0 ]]; then
    echo "production secret must be owned by root: $name" >&2
    exit 77
  fi
done

env_mode="$(stat -c '%a' -- "$WTR_ENV_FILE")"
if (( (8#$env_mode & 077) != 0 )); then
  echo "production environment file must not be readable by group or other users" >&2
  exit 77
fi
if [[ "$(stat -c '%u' -- "$WTR_ENV_FILE")" -ne 0 ]]; then
  echo "production environment file must be owned by root" >&2
  exit 77
fi

required_values=(
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_RUNTIME_USER
  POSTGRES_BACKUP_S3_PREFIX
  POSTGRES_BACKUP_AWS_ENDPOINT
  POSTGRES_BACKUP_AWS_REGION
  WHAT_THE_REPO_COS_BUCKET
  WHAT_THE_REPO_COS_REGION
  WHAT_THE_REPO_COS_PREFIX
  GITHUB_OAUTH_CLIENT_ID
  GITHUB_OAUTH_CALLBACK_URL
  WHAT_THE_REPO_WEB_URL
  WHAT_THE_REPO_PUBLIC_DOMAIN
  WHAT_THE_REPO_FREE_PROVIDER_BASE_URL
  WHAT_THE_REPO_FREE_PROVIDER_MODEL
  WHAT_THE_REPO_FEEDBACK_PROVIDER_BASE_URL
  WHAT_THE_REPO_FEEDBACK_PROVIDER_MODEL
  WHAT_THE_REPO_MCP_OWNER_ID
)
for key in "${required_values[@]}"; do
  if [[ -z "$(env_value "$key")" ]]; then
    echo "production environment is missing $key" >&2
    exit 64
  fi
done

raw_secret_keys=(
  POSTGRES_PASSWORD
  POSTGRES_RUNTIME_PASSWORD
  DATABASE_URL
  DATABASE_ADMIN_URL
  GITHUB_OAUTH_CLIENT_SECRET
  WHAT_THE_REPO_SESSION_SECRET
  WHAT_THE_REPO_KEY_ENCRYPTION_SECRET
  WHAT_THE_REPO_FREE_PROVIDER_API_KEY
  WHAT_THE_REPO_FEEDBACK_PROVIDER_API_KEY
  WHAT_THE_REPO_COS_SECRET_ID
  WHAT_THE_REPO_COS_SECRET_KEY
  WHAT_THE_REPO_COS_SECURITY_TOKEN
  WHAT_THE_REPO_MCP_TOKEN
  WHAT_THE_REPO_MCP_TOKENS_JSON
  WHAT_THE_REPO_METRICS_TOKEN
  GRAFANA_ADMIN_PASSWORD
  POSTGRES_BACKUP_AWS_ACCESS_KEY_ID
  POSTGRES_BACKUP_AWS_SECRET_ACCESS_KEY
  POSTGRES_BACKUP_AWS_SESSION_TOKEN
  WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY
  WHAT_THE_REPO_EVOLUTION_PROVIDER_API_KEY_FILE
)
for key in "${raw_secret_keys[@]}"; do
  if [[ -n "$(env_value "$key")" ]]; then
    echo "production environment must not contain raw secret $key" >&2
    exit 64
  fi
done

domain="$(env_value WHAT_THE_REPO_PUBLIC_DOMAIN)"
callback="$(env_value GITHUB_OAUTH_CALLBACK_URL)"
web_url="$(env_value WHAT_THE_REPO_WEB_URL)"
if [[ "$callback" != "https://$domain/api/auth/github/callback" ]]; then
  echo "GitHub OAuth callback must exactly match the public HTTPS callback" >&2
  exit 64
fi
if [[ "$web_url" != "https://$domain" ]]; then
  echo "WHAT_THE_REPO_WEB_URL must exactly match the public HTTPS origin" >&2
  exit 64
fi
if [[ "$(env_value GITHUB_OAUTH_CLIENT_ID)" == *replace* ]]; then
  echo "production GitHub OAuth Client ID is still a placeholder" >&2
  exit 64
fi
if [[ ! "$(env_value WHAT_THE_REPO_MCP_OWNER_ID)" =~ ^github:[0-9]+$ ]]; then
  echo "production MCP owner must use the numeric GitHub owner id" >&2
  exit 64
fi
if [[ "$(env_value WHAT_THE_REPO_COS_PREFIX)" != "what-the-repo/production" ]]; then
  echo "production COS objects must use the dedicated what-the-repo/production prefix" >&2
  exit 64
fi
if [[ "$(env_value POSTGRES_BACKUP_FILE_PREFIX)" != "" ]]; then
  echo "production must disable the same-server WAL-G file backend" >&2
  exit 64
fi
if [[ "$(env_value POSTGRES_BACKUP_S3_SSE)" != "AES256" ]]; then
  echo "production PostgreSQL backups must request COS server-side encryption" >&2
  exit 64
fi

product_bucket="$(env_value WHAT_THE_REPO_COS_BUCKET)"
backup_prefix="$(env_value POSTGRES_BACKUP_S3_PREFIX)"
if [[ ! "$backup_prefix" =~ ^s3://([^/]+)/.+$ ]]; then
  echo "POSTGRES_BACKUP_S3_PREFIX must include a bucket and a dedicated prefix" >&2
  exit 64
fi
backup_bucket="${BASH_REMATCH[1]}"
if [[ "$backup_bucket" == "$product_bucket" ]]; then
  echo "database backups must use a bucket separate from live product objects" >&2
  exit 64
fi
if [[ ! "$backup_bucket" =~ ^[a-z0-9][a-z0-9-]*-[0-9]+$ ]]; then
  echo "backup bucket name must include the numeric Tencent COS APPID suffix" >&2
  exit 64
fi
product_region="$(env_value WHAT_THE_REPO_COS_REGION)"
backup_region="$(env_value POSTGRES_BACKUP_AWS_REGION)"
if [[ "$backup_region" == "$product_region" ]]; then
  echo "database backup bucket must be in a region different from live product objects" >&2
  exit 64
fi
if [[ "$(env_value POSTGRES_BACKUP_AWS_ENDPOINT)" != "https://cos.$backup_region.myqcloud.com" ]]; then
  echo "PostgreSQL backup endpoint does not match its configured Tencent COS region" >&2
  exit 64
fi
if [[ "$(env_value POSTGRES_BACKUP_AWS_FORCE_PATH_STYLE)" != "false" ]]; then
  echo "Tencent COS WAL-G access must use virtual-hosted S3 addressing" >&2
  exit 64
fi

check_minimum_length() {
  local name="$1"
  local minimum="$2"
  local value
  value="$(tr -d '\r\n' < "$WTR_SECRET_ROOT/$name")"
  if (( ${#value} < minimum )); then
    echo "production secret is shorter than required: $name" >&2
    exit 64
  fi
}
check_minimum_length postgres-admin-password 24
check_minimum_length postgres-runtime-password 24
check_minimum_length session-secret 32
check_minimum_length key-encryption-secret 32
check_minimum_length mcp-token 32
check_minimum_length metrics-token 32
check_minimum_length grafana-admin-password 16

admin_password="$(tr -d '\r\n' < "$WTR_SECRET_ROOT/postgres-admin-password")"
runtime_password="$(tr -d '\r\n' < "$WTR_SECRET_ROOT/postgres-runtime-password")"
if [[ ! "$admin_password" =~ ^[A-Za-z0-9._~-]+$ || ! "$runtime_password" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  echo "PostgreSQL passwords must be URL-safe because database URLs contain them" >&2
  exit 64
fi
database="$(env_value POSTGRES_DB)"
admin_user="$(env_value POSTGRES_USER)"
runtime_user="$(env_value POSTGRES_RUNTIME_USER)"
expected_admin_url="postgresql://$admin_user:$admin_password@postgres:5432/$database"
expected_runtime_url="postgresql://$runtime_user:$runtime_password@postgres:5432/$database"
actual_admin_url="$(tr -d '\r\n' < "$WTR_SECRET_ROOT/postgres-admin-database-url")"
actual_runtime_url="$(tr -d '\r\n' < "$WTR_SECRET_ROOT/postgres-runtime-database-url")"
if [[ "$actual_admin_url" != "$expected_admin_url" || "$actual_runtime_url" != "$expected_runtime_url" ]]; then
  echo "database URL secret files do not match the configured users, database and password files" >&2
  exit 64
fi
unset admin_password runtime_password expected_admin_url expected_runtime_url actual_admin_url actual_runtime_url

alertmanager_config="$WTR_SECRET_ROOT/alertmanager.yml"
if ! grep -Eq '^[[:space:]]+(email_configs|webhook_configs|wechat_configs|telegram_configs|slack_configs|msteams_configs|discord_configs|sns_configs):' "$alertmanager_config"; then
  echo "Alertmanager production config has no external receiver" >&2
  exit 64
fi
if ! grep -Eq 'send_resolved:[[:space:]]*true' "$alertmanager_config"; then
  echo "Alertmanager external receiver must send resolved notifications" >&2
  exit 64
fi

compose --profile monitoring --profile operations config --quiet
if [[ -e "$WTR_SECRET_ROOT/evolution-provider-api-key" ]]; then
  echo "production secret directory must not contain an Evolution Provider key without separate authorization" >&2
  exit 64
fi

docker run --rm \
  --entrypoint /bin/amtool \
  -v "$alertmanager_config:/tmp/alertmanager.yml:ro" \
  prom/alertmanager:v0.33.1 \
  check-config /tmp/alertmanager.yml >/dev/null

echo "production preflight passed for $domain (image tag $WTR_IMAGE_TAG)"
