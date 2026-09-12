#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
bash "$SCRIPT_DIR/k3s-apply-config.sh"
bash "$SCRIPT_DIR/k3s-apply-secrets.sh"

if [[ "${WTR_K3S_SKIP_BUILD:-0}" -eq 1 ]]; then
  tag="$(release_tag)"
  required_images=(
    "what-the-repo-postgres-walg:$tag"
    "what-the-repo-server:$tag"
    "what-the-repo-web:$tag"
    "what-the-repo-evolution-worker:$tag"
    "redis:7.4-alpine"
  )
  for image in "${required_images[@]}"; do
    if ! k3s_image_present "$image"; then
      echo "pre-imported k3s image is missing: $image" >&2
      exit 65
    fi
  done
  if ! docker image inspect "what-the-repo-pi-sandbox:$tag" >/dev/null 2>&1; then
    echo "pre-built Evolution sandbox image is missing: what-the-repo-pi-sandbox:$tag" >&2
    exit 65
  fi
  echo "using pre-imported k3s images for release $tag"
else
  bash "$SCRIPT_DIR/k3s-build-images.sh"
fi

apply_manifest "infra/k8s/10-storage.yaml"
apply_manifest "infra/k8s/20-postgres.yaml"
apply_manifest "infra/k8s/30-redis.yaml"

kctl -n "$WTR_K3S_NAMESPACE" rollout status statefulset/postgres --timeout=300s
kctl -n "$WTR_K3S_NAMESPACE" rollout status deployment/redis --timeout=180s
echo "k3s PostgreSQL and Redis are ready"
