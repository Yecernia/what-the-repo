#!/usr/bin/env bash
set -Eeuo pipefail

WTR_INSTALL_ROOT="${WTR_INSTALL_ROOT:-/opt/what-the-repo}"
WTR_RELEASE_ROOT="${WTR_RELEASE_ROOT:-$WTR_INSTALL_ROOT/current}"
WTR_K3S_ENV_FILE="${WTR_K3S_ENV_FILE:-$WTR_INSTALL_ROOT/shared/k3s.env}"
WTR_SECRET_ROOT="${WTR_SECRET_ROOT:-$WTR_INSTALL_ROOT/shared/secrets}"
WTR_K3S_NAMESPACE="${WTR_K3S_NAMESPACE:-what-the-repo}"
WTR_K3S_DATA_ROOT="${WTR_K3S_DATA_ROOT:-/var/lib/what-the-repo/k3s}"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run this script as root" >&2
    exit 77
  fi
}

require_regular_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing $label: $path" >&2
    exit 66
  fi
}

require_release_file() {
  local relative="$1"
  require_regular_file "$WTR_RELEASE_ROOT/$relative" "release file"
}

require_k3s() {
  if ! command -v k3s >/dev/null 2>&1; then
    echo "k3s is not installed" >&2
    exit 69
  fi
}

kctl() {
  k3s kubectl "$@"
}

k3s_image_present() {
  local image="$1"
  local canonical="$image"
  if [[ "$image" != */* ]]; then
    canonical="docker.io/library/$image"
  fi
  k3s ctr images list --quiet | grep -Fxq -e "$image" -e "$canonical"
}

release_target() {
  readlink -f -- "$WTR_RELEASE_ROOT"
}

release_tag() {
  local tag="${WTR_K3S_IMAGE_TAG:-$(basename -- "$(release_target)")}"
  if [[ ! "$tag" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "release image tag contains unsupported characters" >&2
    exit 64
  fi
  printf '%s\n' "$tag"
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
  ' "$WTR_K3S_ENV_FILE"
}

require_env_value() {
  local key="$1"
  local value
  value="$(env_value "$key")"
  if [[ -z "$value" || "$value" == replace-with-* ]]; then
    echo "missing real value for $key in $WTR_K3S_ENV_FILE" >&2
    exit 64
  fi
  printf '%s\n' "$value"
}

require_secret_file() {
  local name="$1"
  local path="$WTR_SECRET_ROOT/$name"
  if [[ ! -f "$path" || ! -s "$path" ]]; then
    echo "missing non-empty secret file: $path" >&2
    exit 66
  fi
  printf '%s\n' "$path"
}

render_manifest() {
  local relative="$1"
  local tag
  tag="$(release_tag)"
  require_release_file "$relative"
  sed "s/__WTR_IMAGE_TAG__/$tag/g" "$WTR_RELEASE_ROOT/$relative"
}

apply_manifest() {
  local relative="$1"
  local rendered
  rendered="$(mktemp)"
  trap 'rm -f -- "$rendered"' RETURN
  render_manifest "$relative" > "$rendered"
  if grep -q '__WTR_IMAGE_TAG__' "$rendered"; then
    echo "manifest still contains an image-tag placeholder: $relative" >&2
    exit 65
  fi
  kctl apply -f "$rendered"
  rm -f -- "$rendered"
  trap - RETURN
}

assert_k3s_environment_is_nonsecret() {
  local forbidden
  forbidden="$(awk -F= '
    /^[[:space:]]*#/ { next }
    NF < 2 { next }
    $1 ~ /(PASSWORD|SECRET|API_KEY|DATABASE_URL|_TOKEN|COS_SECRET_ID|COS_SECRET_KEY)$/ { print $1 }
  ' "$WTR_K3S_ENV_FILE")"
  if [[ -n "$forbidden" ]]; then
    echo "k3s.env contains credential values; move these names to root-only secret files:" >&2
    printf '%s\n' "$forbidden" >&2
    exit 65
  fi
}
