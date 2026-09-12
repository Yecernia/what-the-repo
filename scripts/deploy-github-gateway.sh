#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--deploy" || $# -ne 1 ]]; then
  echo "usage: $0 --deploy" >&2
  echo "Builds and starts only the dedicated GitHub gateway container." >&2
  exit 64
fi

INSTALL_ROOT="${WTR_GITHUB_GATEWAY_INSTALL_ROOT:-/opt/what-the-repo-github-gateway}"
RELEASE_ROOT="${WTR_GITHUB_GATEWAY_RELEASE_ROOT:-$INSTALL_ROOT/current}"
ENV_FILE="${WTR_GITHUB_GATEWAY_ENV_FILE:-$INSTALL_ROOT/shared/gateway.env}"
SECRET_ROOT="${WTR_GITHUB_GATEWAY_SECRET_ROOT:-$INSTALL_ROOT/shared/secrets}"
RUNTIME_SECRET_ROOT="$INSTALL_ROOT/runtime-secrets"
SERVICE_PATH="/etc/systemd/system/wtr-github-gateway.service"
CONTAINER_NAME="wtr-github-gateway"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 77
fi
for command in docker curl systemctl awk install readlink; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing required command: $command" >&2
    exit 69
  fi
done
for path in \
  "$RELEASE_ROOT/infra/docker/github-gateway.Dockerfile" \
  "$RELEASE_ROOT/infra/docker/github-gateway/package.json" \
  "$RELEASE_ROOT/infra/docker/github-gateway/package-lock.json" \
  "$RELEASE_ROOT/server/package.json" \
  "$RELEASE_ROOT/server/package-lock.json" \
  "$ENV_FILE"; do
  if [[ ! -f "$path" ]]; then
    echo "missing required file: $path" >&2
    exit 66
  fi
done

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
      print value
      exit
    }
  ' "$ENV_FILE"
}

required_env=(
  GITHUB_GATEWAY_PUBLIC_URL
  GITHUB_GATEWAY_APPLICATION_CALLBACK_URL
  GITHUB_OAUTH_CLIENT_ID
)
for key in "${required_env[@]}"; do
  value="$(env_value "$key")"
  if [[ -z "$value" || "$value" == replace-with-* ]]; then
    echo "missing real value for $key in $ENV_FILE" >&2
    exit 64
  fi
done
if [[ "$(env_value GITHUB_GATEWAY_PUBLIC_URL)" != "https://github.example.com" \
  || "$(env_value GITHUB_GATEWAY_APPLICATION_CALLBACK_URL)" != "https://example.com/api/auth/github/callback" ]]; then
  echo "gateway public and application callback URLs do not match the approved production domains" >&2
  exit 65
fi
if grep -Eq '^[[:space:]]*(GITHUB_GATEWAY_SHARED_SECRET|GITHUB_OAUTH_CLIENT_SECRET)=' "$ENV_FILE"; then
  echo "gateway.env must not contain credentials; use root-only secret files" >&2
  exit 65
fi

for name in github-oauth-client-secret github-gateway-shared-secret; do
  path="$SECRET_ROOT/$name"
  if [[ ! -f "$path" || ! -s "$path" ]]; then
    echo "missing non-empty secret file: $path" >&2
    exit 66
  fi
done

release_target="$(readlink -f -- "$RELEASE_ROOT")"
tag="$(git -C "$release_target" rev-parse --short=12 HEAD 2>/dev/null || basename -- "$release_target")"
if [[ ! "$tag" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "release tag contains unsupported characters" >&2
  exit 64
fi
image="what-the-repo-github-gateway:$tag"

docker build --tag "$image" --file "$release_target/infra/docker/github-gateway.Dockerfile" "$release_target"

umask 077
install -d -o root -g root -m 0700 "$RUNTIME_SECRET_ROOT"
for name in github-oauth-client-secret github-gateway-shared-secret; do
  install -o 10002 -g 10002 -m 0400 "$SECRET_ROOT/$name" "$RUNTIME_SECRET_ROOT/$name"
done

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=what-the-repo GitHub gateway
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
Restart=always
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=30
ExecStartPre=-/usr/bin/docker rm -f $CONTAINER_NAME
ExecStart=/usr/bin/docker run --rm --name $CONTAINER_NAME \
  --publish 127.0.0.1:8408:8408 \
  --env-file $ENV_FILE \
  --env GITHUB_OAUTH_CLIENT_SECRET_FILE=/run/secrets/github-oauth-client-secret \
  --env GITHUB_GATEWAY_SHARED_SECRET_FILE=/run/secrets/github-gateway-shared-secret \
  --mount type=bind,src=$RUNTIME_SECRET_ROOT/github-oauth-client-secret,dst=/run/secrets/github-oauth-client-secret,readonly \
  --mount type=bind,src=$RUNTIME_SECRET_ROOT/github-gateway-shared-secret,dst=/run/secrets/github-gateway-shared-secret,readonly \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 128 \
  --cpus 1 \
  --memory 512m \
  --memory-swap 768m \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  $image
ExecStop=-/usr/bin/docker stop --time 20 $CONTAINER_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wtr-github-gateway.service
systemctl restart wtr-github-gateway.service

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8408/health >/dev/null; then
    echo "GitHub gateway is healthy on loopback port 8408 using image $image"
    exit 0
  fi
  sleep 2
done

systemctl status wtr-github-gateway.service --no-pager || true
docker logs --tail 100 "$CONTAINER_NAME" || true
echo "GitHub gateway did not become healthy" >&2
exit 1
