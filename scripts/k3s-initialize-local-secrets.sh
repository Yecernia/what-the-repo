#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--initialize" || $# -ne 1 ]]; then
  echo "usage: $0 --initialize" >&2
  echo "Creates only local random deployment secrets; it never creates cloud or Provider credentials." >&2
  exit 64
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/k3s-common.sh
source "$SCRIPT_DIR/lib/k3s-common.sh"

require_root
umask 077
install -d -o root -g root -m 0700 "$WTR_SECRET_ROOT"

create_random_secret() {
  local name="$1"
  local bytes="$2"
  local path="$WTR_SECRET_ROOT/$name"
  local temporary

  if [[ -s "$path" ]]; then
    return
  fi
  if [[ -e "$path" ]]; then
    echo "refusing to replace an empty or non-regular secret path: $path" >&2
    exit 65
  fi

  temporary="$(mktemp "$WTR_SECRET_ROOT/.${name}.XXXXXX")"
  trap 'rm -f -- "$temporary"' RETURN
  openssl rand -hex "$bytes" > "$temporary"
  chown root:root "$temporary"
  chmod 0400 "$temporary"
  mv -- "$temporary" "$path"
  trap - RETURN
}

write_database_url() {
  local name="$1"
  local user="$2"
  local password_file="$3"
  local path="$WTR_SECRET_ROOT/$name"
  local expected temporary

  expected="postgresql://${user}:$(<"$WTR_SECRET_ROOT/$password_file")@postgres:5432/what_the_repo"
  if [[ -s "$path" ]]; then
    if [[ "$(<"$path")" != "$expected" ]]; then
      echo "existing $name does not match $password_file" >&2
      exit 65
    fi
    return
  fi
  if [[ -e "$path" ]]; then
    echo "refusing to replace an empty or non-regular secret path: $path" >&2
    exit 65
  fi

  temporary="$(mktemp "$WTR_SECRET_ROOT/.${name}.XXXXXX")"
  trap 'rm -f -- "$temporary"' RETURN
  printf '%s\n' "$expected" > "$temporary"
  chown root:root "$temporary"
  chmod 0400 "$temporary"
  mv -- "$temporary" "$path"
  trap - RETURN
}

create_random_secret postgres-admin-password 32
create_random_secret postgres-runtime-password 32
create_random_secret session-secret 48
create_random_secret key-encryption-secret 48
create_random_secret mcp-token 32
create_random_secret github-gateway-shared-secret 48

write_database_url postgres-admin-database-url what_the_repo postgres-admin-password
write_database_url postgres-runtime-database-url what_the_repo_runtime postgres-runtime-password

external=(
  free-provider-api-key
  feedback-provider-api-key
  evolution-provider-api-key
  cos-secret-id
  cos-secret-key
  postgres-backup-access-key-id
  postgres-backup-secret-access-key
)
missing=()
for name in "${external[@]}"; do
  if [[ ! -s "$WTR_SECRET_ROOT/$name" ]]; then
    missing+=("$name")
  fi
done

echo "initialized local random k3s secrets without printing their contents"
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "external credentials still required:"
  printf '  %s\n' "${missing[@]}"
fi
