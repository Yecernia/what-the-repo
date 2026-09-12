#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 77
fi

INSTALL_ROOT="${WTR_INSTALL_ROOT:-/opt/what-the-repo}"
ENV_FILE="${WTR_ENV_FILE:-$INSTALL_ROOT/shared/production.env}"
SECRET_ROOT="${WTR_SECRET_ROOT:-$INSTALL_ROOT/shared/secrets}"

required=(
  postgres-admin-password
  postgres-runtime-password
  postgres-admin-database-url
  postgres-runtime-database-url
  github-oauth-client-secret
  session-secret
  key-encryption-secret
  free-provider-api-key
  feedback-provider-api-key
  cos-secret-id
  cos-secret-key
  mcp-token
  metrics-token
  grafana-admin-password
  alertmanager.yml
  postgres-backup-access-key-id
  postgres-backup-secret-access-key
)

install -d -o root -g root -m 0700 "$SECRET_ROOT"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing production environment file: $ENV_FILE" >&2
  exit 66
fi
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

for name in "${required[@]}"; do
  path="$SECRET_ROOT/$name"
  if [[ ! -s "$path" ]]; then
    echo "missing or empty production Secret: $name" >&2
    exit 66
  fi
  chown root:root "$path"
  chmod 0444 "$path"
done

echo "production Secret directory and file permissions prepared"
