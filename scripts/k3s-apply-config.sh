#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
require_regular_file "$WTR_K3S_ENV_FILE" "k3s environment file"
assert_k3s_environment_is_nonsecret

required=(
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_RUNTIME_USER
  POSTGRES_BACKUP_S3_PREFIX
  POSTGRES_BACKUP_AWS_ENDPOINT
  POSTGRES_BACKUP_AWS_REGION
  WHAT_THE_REPO_REDIS_URL
  WHAT_THE_REPO_COS_BUCKET
  WHAT_THE_REPO_COS_REGION
  WHAT_THE_REPO_COS_PREFIX
  WHAT_THE_REPO_GITHUB_GATEWAY_URL
  WHAT_THE_REPO_WEB_URL
  WHAT_THE_REPO_PUBLIC_DOMAIN
  WHAT_THE_REPO_FREE_PROVIDER_BASE_URL
  WHAT_THE_REPO_FREE_PROVIDER_MODEL
  WHAT_THE_REPO_FEEDBACK_PROVIDER_BASE_URL
  WHAT_THE_REPO_FEEDBACK_PROVIDER_MODEL
  WHAT_THE_REPO_EVOLUTION_PROVIDER_ID
  WHAT_THE_REPO_EVOLUTION_PROVIDER_BASE_URL
  WHAT_THE_REPO_EVOLUTION_PROVIDER_MODEL
  WHAT_THE_REPO_EVOLUTION_TASK_LIMIT
  WHAT_THE_REPO_EVOLUTION_DB_POOL_MAX
)
for key in "${required[@]}"; do
  require_env_value "$key" >/dev/null
done

domain="$(require_env_value WHAT_THE_REPO_PUBLIC_DOMAIN)"
gateway_url="$(require_env_value WHAT_THE_REPO_GITHUB_GATEWAY_URL)"
web_url="$(require_env_value WHAT_THE_REPO_WEB_URL)"
bucket="$(require_env_value WHAT_THE_REPO_COS_BUCKET)"
prefix="$(require_env_value WHAT_THE_REPO_COS_PREFIX)"
backup_prefix="$(require_env_value POSTGRES_BACKUP_S3_PREFIX)"
backup_file_prefix="$(env_value POSTGRES_BACKUP_FILE_PREFIX)"
backup_endpoint="$(require_env_value POSTGRES_BACKUP_AWS_ENDPOINT)"
backup_region="$(require_env_value POSTGRES_BACKUP_AWS_REGION)"
cos_region="$(require_env_value WHAT_THE_REPO_COS_REGION)"
if [[ "$gateway_url" != "https://github.$domain" || "$web_url" != "https://$domain" ]]; then
  echo "GitHub gateway and Web URL must match the configured public domain" >&2
  exit 65
fi
if [[ ! "$bucket" =~ ^[a-z0-9][a-z0-9-]*-[0-9]+$ || "$bucket" == your-* || "$prefix" != "what-the-repo/production" ]]; then
  echo "configure your COS bucket with its numeric APPID suffix and the dedicated production prefix" >&2
  exit 65
fi
if [[ "$backup_prefix" != "s3://$bucket/postgresql/production" ]]; then
  echo "PostgreSQL backup prefix must remain isolated inside the configured Guangzhou bucket" >&2
  exit 65
fi
if [[ -n "$backup_file_prefix" || "$backup_endpoint" != "https://cos.ap-guangzhou.myqcloud.com" || "$backup_region" != "ap-guangzhou" || "$cos_region" != "ap-guangzhou" ]]; then
  echo "first launch must use Guangzhou COS with no local PostgreSQL backup backend" >&2
  exit 65
fi
if [[ "$(require_env_value WHAT_THE_REPO_EVOLUTION_TASK_LIMIT)" != "1" \
  || "$(require_env_value WHAT_THE_REPO_EVOLUTION_DB_POOL_MAX)" != "2" ]]; then
  echo "first launch must keep one Evolution task and a two-connection database pool" >&2
  exit 65
fi

apply_manifest "infra/k8s/00-namespace.yaml"
kctl -n "$WTR_K3S_NAMESPACE" create configmap wtr-config \
  --from-env-file="$WTR_K3S_ENV_FILE" \
  --dry-run=client \
  --output=yaml \
  | kctl apply -f -
echo "applied non-secret k3s configuration"
