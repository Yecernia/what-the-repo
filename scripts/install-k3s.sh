#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_release_file "infra/k8s/k3s-server-config.yaml"

config_target="/etc/rancher/k3s/config.yaml"
config_source="$WTR_RELEASE_ROOT/infra/k8s/k3s-server-config.yaml"
install -d -m 0755 /etc/rancher/k3s
airgap_changed=0

install_airgap_images() {
  local source="${INSTALL_K3S_AIRGAP_IMAGES_PATH:-}"
  local digest="${INSTALL_K3S_AIRGAP_IMAGES_SHA256:-}"
  local target

  if [[ -z "$source" ]]; then
    return
  fi
  require_regular_file "$source" "offline k3s air-gap image archive"
  if [[ ! "$digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "INSTALL_K3S_AIRGAP_IMAGES_SHA256 must be the official 64-character SHA-256" >&2
    exit 64
  fi
  printf '%s  %s\n' "$digest" "$source" | sha256sum -c -
  install -d -o root -g root -m 0755 /var/lib/rancher/k3s/agent/images
  target="/var/lib/rancher/k3s/agent/images/$(basename -- "$source")"
  if [[ ! -f "$target" ]] || ! cmp -s "$source" "$target"; then
    install -o root -g root -m 0644 "$source" "$target"
    airgap_changed=1
  fi
}

install_airgap_images

if command -v k3s >/dev/null 2>&1; then
  if [[ -f "$config_target" ]] && ! cmp -s "$config_source" "$config_target"; then
    echo "existing k3s configuration differs; inspect it before changing a running cluster" >&2
    exit 65
  fi
  if [[ "$airgap_changed" -eq 1 ]]; then
    systemctl restart k3s
  else
    systemctl is-active --quiet k3s
  fi
else
  install -m 0644 "$config_source" "$config_target"
    install -d -m 0700 "$WTR_K3S_DATA_ROOT" "$WTR_K3S_DATA_ROOT/migration"
    install -d -o 999 -g 999 -m 0700 "$WTR_K3S_DATA_ROOT/postgres" "$WTR_K3S_DATA_ROOT/redis"
  install -d -o 10001 -g 10001 -m 0750 "$WTR_K3S_DATA_ROOT/product-data"

  installer="$(mktemp)"
  trap 'rm -f -- "$installer"' EXIT
  curl --fail --location --silent --show-error https://get.k3s.io --output "$installer"
  chmod 0700 "$installer"
  if [[ -n "${INSTALL_K3S_BINARY_PATH:-}" ]]; then
    require_regular_file "$INSTALL_K3S_BINARY_PATH" "offline k3s binary"
    if [[ ! "${INSTALL_K3S_BINARY_SHA256:-}" =~ ^[0-9a-fA-F]{64}$ ]]; then
      echo "INSTALL_K3S_BINARY_SHA256 must be the official 64-character SHA-256" >&2
      exit 64
    fi
    printf '%s  %s\n' "$INSTALL_K3S_BINARY_SHA256" "$INSTALL_K3S_BINARY_PATH" | sha256sum -c -
    install -o root -g root -m 0755 "$INSTALL_K3S_BINARY_PATH" /usr/local/bin/k3s
    INSTALL_K3S_SKIP_DOWNLOAD=true \
      INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-v1.36.3+k3s1}" \
      INSTALL_K3S_EXEC="server" \
      sh "$installer"
  else
    INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-v1.36.3+k3s1}" \
      INSTALL_K3S_EXEC="server" \
      sh "$installer"
  fi
  rm -f -- "$installer"
  trap - EXIT
fi

require_k3s
node_name="$(kctl get nodes -o jsonpath='{.items[0].metadata.name}')"
kctl wait --for=condition=Ready "node/$node_name" --timeout=300s
kctl -n kube-system wait --for=condition=Available deployment/coredns --timeout=300s
kctl -n kube-system wait --for=condition=Available deployment/local-path-provisioner --timeout=300s
kctl get node
kctl -n kube-system get pods
echo "k3s is ready with Traefik, ServiceLB, and metrics-server disabled"
