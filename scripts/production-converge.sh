#!/usr/bin/env bash
set -Eeuo pipefail

skip_build=0
skip_backup=0
for argument in "$@"; do
  case "$argument" in
    --skip-build) skip_build=1 ;;
    --skip-backup) skip_backup=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/production-common.sh
source "$SCRIPT_DIR/lib/production-common.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run production convergence as root" >&2
  exit 77
fi

"$SCRIPT_DIR/production-preflight.sh"

if [[ "$skip_build" -eq 0 ]]; then
  compose build postgres migration api analysis-worker scheduler web
fi

if [[ "$skip_backup" -eq 0 ]]; then
  "$SCRIPT_DIR/run-production-backup.sh"
fi

api_replicas="${WTR_API_REPLICAS:-2}"
worker_replicas="${WTR_ANALYSIS_WORKER_REPLICAS:-2}"
if [[ ! "$api_replicas" =~ ^[1-9][0-9]*$ || ! "$worker_replicas" =~ ^[1-9][0-9]*$ ]]; then
  echo "production replica counts must be positive integers" >&2
  exit 64
fi

compose --profile monitoring up \
  -d \
  --wait \
  --wait-timeout 600 \
  --scale "api=$api_replicas" \
  --scale "analysis-worker=$worker_replicas"

actual_api="$(compose ps -q api | awk 'NF { count += 1 } END { print count + 0 }')"
actual_workers="$(compose ps -q analysis-worker | awk 'NF { count += 1 } END { print count + 0 }')"
if [[ "$actual_api" -ne "$api_replicas" || "$actual_workers" -ne "$worker_replicas" ]]; then
  echo "production replica count mismatch: api=$actual_api worker=$actual_workers" >&2
  exit 1
fi

api_id="$(compose ps -q api | head -n 1)"
worker_id="$(compose ps -q analysis-worker | head -n 1)"
web_id="$(compose ps -q web | head -n 1)"
if [[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$api_id")" != "true" \
   || "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$worker_id")" != "true" \
   || "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$web_id")" != "true" ]]; then
  echo "one or more production application containers are not using a read-only root filesystem" >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.Config.User}}' "$web_id")" != "101:101" ]]; then
  echo "production Web gateway is not running as the expected non-root user" >&2
  exit 1
fi

api_environment="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api_id")"
if grep -Eq '^(DATABASE_URL|GITHUB_OAUTH_CLIENT_SECRET|WHAT_THE_REPO_(SESSION_SECRET|KEY_ENCRYPTION_SECRET|FREE_PROVIDER_API_KEY|FEEDBACK_PROVIDER_API_KEY|COS_SECRET_ID|COS_SECRET_KEY|MCP_TOKEN|MCP_TOKENS_JSON|METRICS_TOKEN))=.+' <<<"$api_environment"; then
  echo "a production secret or database URL is present in the API environment" >&2
  exit 1
fi
unset api_environment

port_bindings="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$api_id")"
if [[ "$port_bindings" != "null" && "$port_bindings" != "{}" ]]; then
  echo "production API unexpectedly publishes a host port" >&2
  exit 1
fi

evolution_count="$(docker ps -q \
  --filter "label=com.docker.compose.project=$WTR_PROJECT_NAME" \
  --filter "label=com.docker.compose.service=evolution-worker" | awk 'NF { count += 1 } END { print count + 0 }')"
if [[ "$evolution_count" -ne 0 ]]; then
  echo "Evolution Worker is running without production authorization" >&2
  exit 1
fi

"$SCRIPT_DIR/run-production-public-probe.sh"
compose ps
echo "production convergence completed with api=$actual_api and analysis-worker=$actual_workers"
