#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${1:-}" != "--install" ]]; then
  echo "usage: $0 --install [email]" >&2
  exit 64
fi

# Set these in private deployment configuration before running --install:
# WTR_GITHUB_GATEWAY_DOMAIN and WTR_GITHUB_GATEWAY_GUANGZHOU_IP.
EMAIL="${2:-}"
DOMAIN="${WTR_GITHUB_GATEWAY_DOMAIN:-}"
GUANGZHOU_IP="${WTR_GITHUB_GATEWAY_GUANGZHOU_IP:-}"
UPSTREAM="${WTR_GITHUB_GATEWAY_UPSTREAM:-127.0.0.1:8408}"
RELEASE_ROOT="${WTR_GITHUB_GATEWAY_RELEASE_ROOT:-/opt/what-the-repo-github-gateway/current}"
TEMPLATE="$RELEASE_ROOT/infra/nginx/github-gateway.nginx.conf.template"
SITE_PATH="/etc/nginx/sites-available/what-the-repo-github-gateway"
ENABLED_PATH="/etc/nginx/sites-enabled/what-the-repo-github-gateway"
LIMITS_PATH="/etc/nginx/conf.d/what-the-repo-github-gateway-limits.conf"
CHALLENGE_ROOT="/var/www/letsencrypt"

valid_hostname() {
  local label
  local -a labels
  [[ ${#1} -le 253 && "$1" == *.* && "$1" != *. ]] || return 1
  IFS='.' read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || return 1
  done
  [[ "${labels[-1]}" =~ [A-Za-z] ]]
}

valid_ipv4() {
  local octet
  local -a octets
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS='.' read -r -a octets <<< "$1"
  for octet in "${octets[@]}"; do
    [[ "$octet" == 0 || "$octet" != 0* ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

if [[ -z "$DOMAIN" || -z "$GUANGZHOU_IP" ]]; then
  echo "set WTR_GITHUB_GATEWAY_DOMAIN and WTR_GITHUB_GATEWAY_GUANGZHOU_IP in private deployment configuration" >&2
  exit 64
fi
if ! valid_hostname "$DOMAIN"; then
  echo "invalid GitHub gateway hostname" >&2
  exit 64
fi
if ! valid_ipv4 "$GUANGZHOU_IP"; then
  echo "invalid Guangzhou IPv4 address" >&2
  exit 64
fi
if [[ ! "$UPSTREAM" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]]; then
  echo "invalid loopback upstream" >&2
  exit 64
fi
if (( 10#${BASH_REMATCH[1]} < 1 || 10#${BASH_REMATCH[1]} > 65535 )); then
  echo "invalid loopback upstream port" >&2
  exit 64
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 77
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "missing Nginx template: $TEMPLATE" >&2
  exit 66
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade --yes
apt-get install --yes --no-install-recommends nginx certbot curl ca-certificates

install -d -o www-data -g www-data -m 0755 "$CHALLENGE_ROOT"
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > "$LIMITS_PATH" <<'EOF'
limit_req_zone $binary_remote_addr zone=wtr_gateway_public:1m rate=60r/m;
limit_req_zone $binary_remote_addr zone=wtr_gateway_oauth:2m rate=20r/m;
limit_req_zone $binary_remote_addr zone=wtr_gateway_repository:1m rate=120r/m;
EOF

cat > "$SITE_PATH" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root $CHALLENGE_ROOT;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 200 "certificate bootstrap\n"; }
}
EOF
ln -sfn "$SITE_PATH" "$ENABLED_PATH"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

certbot_args=(certonly --webroot -w "$CHALLENGE_ROOT" --cert-name "$DOMAIN" -d "$DOMAIN" --agree-tos --non-interactive --keep-until-expiring)
if [[ -n "$EMAIL" ]]; then
  certbot_args+=(--email "$EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi
certbot "${certbot_args[@]}"

sed \
  -e "s/__DOMAIN__/$DOMAIN/g" \
  -e "s/__GUANGZHOU_IP__/$GUANGZHOU_IP/g" \
  -e "s|__UPSTREAM__|$UPSTREAM|g" \
  "$TEMPLATE" > "$SITE_PATH"
cat > /etc/letsencrypt/renewal-hooks/deploy/what-the-repo-github-gateway-nginx-reload.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/what-the-repo-github-gateway-nginx-reload.sh

nginx -t
systemctl reload nginx
curl --fail --silent --show-error --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" >/dev/null
echo "GitHub gateway HTTPS edge is healthy for $DOMAIN and repository fetch is limited to $GUANGZHOU_IP"
