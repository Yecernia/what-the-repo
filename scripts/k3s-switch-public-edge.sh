#!/usr/bin/env bash
set -Eeuo pipefail

backup_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      backup_path="${2:-}"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_regular_file "$WTR_K3S_ENV_FILE" "k3s environment file"
require_release_file "infra/docker/public-edge.nginx.conf.template"
domain="$(require_env_value WHAT_THE_REPO_PUBLIC_DOMAIN)"
if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid public domain" >&2
  exit 64
fi

site_path="/etc/nginx/sites-available/what-the-repo"
if [[ ! -f "$site_path" ]]; then
  echo "missing existing public edge configuration: $site_path" >&2
  exit 66
fi

if [[ -z "$backup_path" ]]; then
  backup_dir="$WTR_INSTALL_ROOT/shared/backups/k3s-edge"
  install -d -m 0700 "$backup_dir"
  backup_path="$backup_dir/what-the-repo-before-k3s-$(date -u +%Y%m%dT%H%M%SZ).conf"
fi
if [[ "$(dirname -- "$backup_path")" != /* ]]; then
  echo "edge backup path must be absolute" >&2
  exit 64
fi
install -d -m 0700 "$(dirname -- "$backup_path")"
cp --preserve=mode "$site_path" "$backup_path"

rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
sed \
  -e "s/__DOMAIN__/$domain/g" \
  -e 's|__APP_UPSTREAM__|127.0.0.1:30080|g' \
  "$WTR_RELEASE_ROOT/infra/docker/public-edge.nginx.conf.template" > "$rendered"
install -m 0644 "$rendered" "$site_path"
nginx -t
systemctl reload nginx
echo "public edge now targets k3s loopback NodePort; previous configuration: $backup_path"
