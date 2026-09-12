#!/usr/bin/env bash
set -Eeuo pipefail

WTR_INSTALL_ROOT="${WTR_INSTALL_ROOT:-/opt/what-the-repo}"
WTR_RELEASE_ROOT="${WTR_RELEASE_ROOT:-$WTR_INSTALL_ROOT/current}"
WTR_ENV_FILE="${WTR_ENV_FILE:-$WTR_INSTALL_ROOT/shared/production.env}"
WTR_SECRET_ROOT="${WTR_SECRET_ROOT:-$WTR_INSTALL_ROOT/shared/secrets}"
WTR_OPERATIONS_ROOT="${WTR_OPERATIONS_ROOT:-/var/lib/what-the-repo-operations}"
WTR_PROJECT_NAME="${WTR_PROJECT_NAME:-what-the-repo}"

require_regular_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing $label: $path" >&2
    return 66
  fi
}

require_regular_file "$WTR_ENV_FILE" "production environment file"
require_regular_file "$WTR_RELEASE_ROOT/compose.yaml" "base Compose file"
require_regular_file "$WTR_RELEASE_ROOT/compose.production.yaml" "production Compose file"

release_target="$(readlink -f -- "$WTR_RELEASE_ROOT")"
release_tag="${WTR_IMAGE_TAG:-$(basename -- "$release_target")}"
if [[ ! "$release_tag" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "release image tag contains unsupported characters" >&2
  exit 64
fi

export WTR_IMAGE_TAG="$release_tag"
export WTR_SECRET_ROOT WTR_OPERATIONS_ROOT

compose() {
  docker compose \
    --ansi never \
    --project-name "$WTR_PROJECT_NAME" \
    --env-file "$WTR_ENV_FILE" \
    -f "$WTR_RELEASE_ROOT/compose.yaml" \
    -f "$WTR_RELEASE_ROOT/compose.production.yaml" \
    "$@"
}

env_value() {
  local key="$1"
  awk -v wanted="$key" '
    /^[[:space:]]*#/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      split_at = index(line, "=")
      if (split_at < 2) next
      name = substr(line, 1, split_at - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != wanted) next
      value = substr(line, split_at + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$WTR_ENV_FILE"
}

prepare_operations_directories() {
  install -d -m 0755 "$WTR_OPERATIONS_ROOT" "$WTR_OPERATIONS_ROOT/metrics"
  install -d -m 0700 "$WTR_OPERATIONS_ROOT/reports"
}

metric_value() {
  local path="$1"
  local metric="$2"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  awk -v wanted="$metric" '$1 == wanted { print $2; exit }' "$path"
}

write_metrics() {
  local name="$1"
  local body="$2"
  local target="$WTR_OPERATIONS_ROOT/metrics/$name.prom"
  local temporary="$target.tmp.$$"
  printf '%s\n' "$body" > "$temporary"
  chmod 0644 "$temporary"
  mv -f -- "$temporary" "$target"
}

json_report() {
  local name="$1"
  local body="$2"
  local target="$WTR_OPERATIONS_ROOT/reports/$name.json"
  local temporary="$target.tmp.$$"
  printf '%s\n' "$body" > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$target"
  printf '%s\n' "$target"
}

postgres_scalar() {
  local service="$1"
  local sql="$2"
  local database="${3:-$(env_value POSTGRES_DB)}"
  local user="${4:-$(env_value POSTGRES_USER)}"
  database="${database:-what_the_repo}"
  user="${user:-what_the_repo}"
  compose --profile operations exec -T "$service" psql -X -qAt -v ON_ERROR_STOP=1 -U "$user" -d "$database" -c "$sql"
}
