#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
require_k3s

apply_secret() {
  local name="$1"
  shift
  local arguments=()
  local mapping key file
  for mapping in "$@"; do
    key="${mapping%%:*}"
    file="${mapping#*:}"
    require_secret_file "$file" >/dev/null
    arguments+=("--from-file=$key=$WTR_SECRET_ROOT/$file")
  done
  kctl -n "$WTR_K3S_NAMESPACE" create secret generic "$name" \
    "${arguments[@]}" \
    --dry-run=client \
    --output=yaml \
    | kctl apply -f -
}

apply_secret wtr-postgres-init \
  postgres-admin-password:postgres-admin-password
apply_secret wtr-role-bootstrap \
  postgres-admin-password:postgres-admin-password \
  postgres-runtime-password:postgres-runtime-password
apply_secret wtr-backup-secrets \
  postgres-admin-password:postgres-admin-password \
  access-key-id:postgres-backup-access-key-id \
  secret-access-key:postgres-backup-secret-access-key
apply_secret wtr-migration-secrets \
  database-admin-url:postgres-admin-database-url \
  key-encryption-secret:key-encryption-secret \
  cos-secret-id:cos-secret-id \
  cos-secret-key:cos-secret-key
apply_secret wtr-api-secrets \
  database-runtime-url:postgres-runtime-database-url \
  github-gateway-shared-secret:github-gateway-shared-secret \
  session-secret:session-secret \
  key-encryption-secret:key-encryption-secret \
  free-provider-api-key:free-provider-api-key \
  feedback-provider-api-key:feedback-provider-api-key \
  cos-secret-id:cos-secret-id \
  cos-secret-key:cos-secret-key \
  mcp-token:mcp-token
apply_secret wtr-worker-secrets \
  database-runtime-url:postgres-runtime-database-url \
  key-encryption-secret:key-encryption-secret \
  free-provider-api-key:free-provider-api-key \
  github-gateway-shared-secret:github-gateway-shared-secret \
  cos-secret-id:cos-secret-id \
  cos-secret-key:cos-secret-key
apply_secret wtr-evolution-secrets \
  database-runtime-url:postgres-runtime-database-url \
  evolution-provider-api-key:evolution-provider-api-key
echo "applied k3s Secret objects from root-only files without printing their contents"
