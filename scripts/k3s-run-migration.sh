#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
kctl -n "$WTR_K3S_NAMESPACE" delete job wtr-migrate --ignore-not-found --wait=true
apply_manifest "infra/k8s/40-migration.yaml"
if ! kctl -n "$WTR_K3S_NAMESPACE" wait --for=condition=complete job/wtr-migrate --timeout=300s; then
  kctl -n "$WTR_K3S_NAMESPACE" logs job/wtr-migrate --all-containers=true || true
  exit 1
fi
echo "k3s PostgreSQL role bootstrap and schema migration completed"
