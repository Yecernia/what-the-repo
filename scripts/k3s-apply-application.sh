#!/usr/bin/env bash
set -Eeuo pipefail

skip_initial_backup=0
for argument in "$@"; do
  case "$argument" in
    --skip-initial-backup) skip_initial_backup=1 ;;
    *) echo "unknown argument: $argument" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
apply_manifest "infra/k8s/50-application.yaml"
apply_manifest "infra/k8s/55-evolution.yaml"
apply_manifest "infra/k8s/60-postgres-backup.yaml"

for deployment in api analysis-worker web evolution-worker; do
  kctl -n "$WTR_K3S_NAMESPACE" rollout status "deployment/$deployment" --timeout=300s
done

health="$(curl --fail --silent --show-error --max-time 20 http://127.0.0.1:30080/api/health)"
if ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$health" \
  || ! grep -Eq '"storage"[[:space:]]*:[[:space:]]*"postgres"' <<<"$health" \
  || ! grep -Eq '"model_configured"[[:space:]]*:[[:space:]]*true' <<<"$health"; then
  echo "k3s Web NodePort did not return healthy PostgreSQL/model configuration" >&2
  exit 1
fi

if [[ "$skip_initial_backup" -eq 0 ]]; then
  job_name="wtr-postgres-backup-initial-$(date -u +%Y%m%d%H%M%S)"
  kctl -n "$WTR_K3S_NAMESPACE" create job "$job_name" --from=cronjob/wtr-postgres-backup
  if ! kctl -n "$WTR_K3S_NAMESPACE" wait --for=condition=complete "job/$job_name" --timeout=600s; then
    kctl -n "$WTR_K3S_NAMESPACE" logs "job/$job_name" --all-containers=true || true
    exit 1
  fi
fi

echo "k3s application is healthy on loopback NodePort 30080"
