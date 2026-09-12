#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s
require_release_file "infra/docker/server.Dockerfile"
require_release_file "infra/docker/web.Dockerfile"
require_release_file "infra/docker/postgres-walg.Dockerfile"
require_release_file "infra/docker/evolution-worker.Dockerfile"
require_release_file "evolution/pi/sandbox/Dockerfile"

tag="$(release_tag)"
k3s_images=(
  "what-the-repo-postgres-walg:$tag"
  "what-the-repo-server:$tag"
  "what-the-repo-web:$tag"
  "what-the-repo-evolution-worker:$tag"
  "redis:7.4-alpine"
)
sandbox_image="what-the-repo-pi-sandbox:$tag"

if ! docker image inspect redis:7.4-alpine >/dev/null 2>&1; then
  docker pull redis:7.4-alpine
fi

docker build --tag "${k3s_images[0]}" --file "$WTR_RELEASE_ROOT/infra/docker/postgres-walg.Dockerfile" "$WTR_RELEASE_ROOT"
docker build --tag "${k3s_images[1]}" --file "$WTR_RELEASE_ROOT/infra/docker/server.Dockerfile" "$WTR_RELEASE_ROOT"
docker build --build-arg "VITE_ICP_RECORD=$(env_value VITE_ICP_RECORD)" --tag "${k3s_images[2]}" --file "$WTR_RELEASE_ROOT/infra/docker/web.Dockerfile" "$WTR_RELEASE_ROOT"
docker build --tag "${k3s_images[3]}" --file "$WTR_RELEASE_ROOT/infra/docker/evolution-worker.Dockerfile" "$WTR_RELEASE_ROOT"
docker build --tag "$sandbox_image" "$WTR_RELEASE_ROOT/evolution/pi/sandbox"

for image in "${k3s_images[@]}"; do
  docker save "$image" | k3s ctr images import -
done

for image in "${k3s_images[@]}"; do
  if ! k3s_image_present "$image"; then
    echo "k3s image import is missing $image" >&2
    exit 65
  fi
done
docker image inspect "$sandbox_image" >/dev/null
echo "built and imported k3s images and retained the host Docker sandbox image for release $tag"
