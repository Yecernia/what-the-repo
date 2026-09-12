#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /absolute/path/to/previous-nginx-site.conf" >&2
  exit 64
fi
backup_path="$1"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 77
fi
if [[ ! -f "$backup_path" ]]; then
  echo "missing edge backup: $backup_path" >&2
  exit 66
fi

site_path="/etc/nginx/sites-available/what-the-repo"
install -m 0644 "$backup_path" "$site_path"
nginx -t
systemctl reload nginx
echo "restored the previous public edge configuration"
