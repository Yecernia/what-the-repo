#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 || "$1" != "--cutover" || "$2" != "--fresh-start" ]]; then
  echo "usage: $0 --cutover --fresh-start" >&2
  echo "The first launch intentionally starts k3s with empty disposable development data." >&2
  exit 64
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
require_regular_file "$WTR_K3S_ENV_FILE" "k3s environment file"

legacy_project="${WTR_LEGACY_COMPOSE_PROJECT:-what-the-repo}"
legacy_services=(web api analysis-worker scheduler evolution-worker postgres redis prometheus alertmanager grafana)
legacy_containers=()
edge_backup=""
edge_switched=0

recover_legacy() {
  local status="$?"
  if [[ "$edge_switched" -eq 1 && -n "$edge_backup" ]]; then
    bash "$SCRIPT_DIR/k3s-restore-public-edge.sh" "$edge_backup" || true
  fi
  for deployment in api analysis-worker web evolution-worker; do
    kctl -n "$WTR_K3S_NAMESPACE" scale "deployment/$deployment" --replicas=0 >/dev/null 2>&1 || true
  done
  kctl -n "$WTR_K3S_NAMESPACE" patch cronjob wtr-postgres-backup \
    --type=merge --patch '{"spec":{"suspend":true}}' >/dev/null 2>&1 || true
  if [[ "${#legacy_containers[@]}" -gt 0 ]]; then
    docker start "${legacy_containers[@]}" >/dev/null 2>&1 || true
  fi
  echo "fresh k3s start failed; legacy Compose was restarted and k3s application writers remain stopped" >&2
  exit "$status"
}
trap recover_legacy ERR

for service in "${legacy_services[@]}"; do
  container_id="$(docker ps -q --filter "label=com.docker.compose.project=$legacy_project" --filter "label=com.docker.compose.service=$service" | head -n 1)"
  if [[ -n "$container_id" ]]; then
    legacy_containers+=("$container_id")
  fi
done
if [[ "${#legacy_containers[@]}" -eq 0 ]]; then
  echo "no running legacy Compose containers were found" >&2
  exit 66
fi

if kctl -n "$WTR_K3S_NAMESPACE" get deployment api >/dev/null 2>&1; then
  echo "fresh start: existing k3s application resources will be recreated with empty data"
fi

# The old Compose database and product snapshots are disposable development
# fixtures. Stop both stacks' writers; this first-launch path only accepts empty
# k3s directories and never deletes data implicitly.
docker stop "${legacy_containers[@]}" || true
for deployment in api analysis-worker web evolution-worker; do
  kctl -n "$WTR_K3S_NAMESPACE" scale "deployment/$deployment" --replicas=0 >/dev/null 2>&1 || true
done
kctl -n "$WTR_K3S_NAMESPACE" scale deployment/redis --replicas=0 >/dev/null 2>&1 || true
kctl -n "$WTR_K3S_NAMESPACE" scale statefulset/postgres --replicas=0 >/dev/null 2>&1 || true
kctl -n "$WTR_K3S_NAMESPACE" delete pod postgres-0 --ignore-not-found --wait=true >/dev/null 2>&1 || true
kctl -n "$WTR_K3S_NAMESPACE" delete pod -l app.kubernetes.io/name=redis --ignore-not-found --wait=true >/dev/null 2>&1 || true
kctl -n "$WTR_K3S_NAMESPACE" delete job wtr-compose-restore wtr-migrate --ignore-not-found --wait=true >/dev/null 2>&1 || true

for directory in postgres redis product-data; do
  target="$WTR_K3S_DATA_ROOT/$directory"
  if [[ ! -d "$target" || "$target" != "$WTR_K3S_DATA_ROOT/$directory" ]]; then
    echo "missing or unsafe fresh-start data directory: $target" >&2
    exit 65
  fi
  if find "$target" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "fresh-start data directory is not empty; refusing implicit deletion: $target" >&2
    exit 65
  fi
done
install -d -o 999 -g 999 -m 0700 "$WTR_K3S_DATA_ROOT/postgres" "$WTR_K3S_DATA_ROOT/redis"
install -d -o 10001 -g 10001 -m 0750 "$WTR_K3S_DATA_ROOT/product-data"
echo "fresh start: verified empty k3s PostgreSQL, Redis and product-data directories"

bash "$SCRIPT_DIR/k3s-bootstrap-services.sh"
bash "$SCRIPT_DIR/k3s-run-migration.sh"
bash "$SCRIPT_DIR/k3s-apply-application.sh" --skip-initial-backup
# PostgreSQL data is disposable during development; defer the backup CronJob.
# Product COS snapshots remain enabled for real repository analyses.
kctl -n "$WTR_K3S_NAMESPACE" patch cronjob wtr-postgres-backup \
  --type=merge --patch '{"spec":{"suspend":true}}' >/dev/null

edge_backup="$WTR_INSTALL_ROOT/shared/backups/k3s-edge/what-the-repo-before-k3s-cutover.conf"
bash "$SCRIPT_DIR/k3s-switch-public-edge.sh" --backup "$edge_backup"
edge_switched=1

domain="$(require_env_value WHAT_THE_REPO_PUBLIC_DOMAIN)"
public_health="$(curl --fail --silent --show-error --max-time 30 "https://$domain/api/health")"
if ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$public_health" \
  || ! grep -Eq '"storage"[[:space:]]*:[[:space:]]*"postgres"' <<<"$public_health" \
  || ! grep -Eq '"model_configured"[[:space:]]*:[[:space:]]*true' <<<"$public_health"; then
  echo "public edge did not return a healthy configured product after the fresh k3s switch" >&2
  exit 1
fi

trap - ERR
echo "fresh Compose-to-k3s cutover completed; legacy test data was intentionally not migrated"
echo "legacy Compose containers remain stopped and are not deleted"
