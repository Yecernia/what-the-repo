#!/usr/bin/env bash
set -euo pipefail

# Install the host Nginx edge and obtain/renew a certificate without putting
# certificate material in the repository. Run as root (or through sudo).
DOMAIN="${1:-example.com}"
EMAIL="${2:-}"
APP_UPSTREAM="${3:-127.0.0.1:5307}"
ROOT_DIR="${WHAT_THE_REPO_ROOT:-/opt/what-the-repo/current}"
TEMPLATE="$ROOT_DIR/infra/docker/public-edge.nginx.conf.template"
SITE_NAME="what-the-repo"
SITE_PATH="/etc/nginx/sites-available/$SITE_NAME"
ENABLED_PATH="/etc/nginx/sites-enabled/$SITE_NAME"
CHALLENGE_ROOT="/var/www/letsencrypt"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run this script as root (for example: sudo bash scripts/install-public-edge.sh)" >&2
  exit 1
fi
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid domain" >&2
  exit 1
fi
if [[ ! "$APP_UPSTREAM" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  echo "invalid application upstream" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "missing edge template: $TEMPLATE" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends nginx certbot

install -d -o www-data -g www-data -m 0755 "$CHALLENGE_ROOT"
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy

# First install an HTTP-only config so ACME HTTP-01 can reach the challenge.
cat > "$SITE_PATH" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root $CHALLENGE_ROOT;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 200 "certificate bootstrap\\n"; }
}
EOF
ln -sfn "$SITE_PATH" "$ENABLED_PATH"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

certbot_args=(certonly --webroot -w "$CHALLENGE_ROOT" --cert-name "$DOMAIN" -d "$DOMAIN" -d "www.$DOMAIN" --agree-tos --non-interactive --keep-until-expiring --expand)
if [[ -n "$EMAIL" ]]; then
  certbot_args+=(--email "$EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi
certbot "${certbot_args[@]}"

sed \
  -e "s/__DOMAIN__/$DOMAIN/g" \
  -e "s|__APP_UPSTREAM__|$APP_UPSTREAM|g" \
  "$TEMPLATE" > "$SITE_PATH"
cat > /etc/letsencrypt/renewal-hooks/deploy/what-the-repo-nginx-reload.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
/usr/sbin/nginx -t
/bin/systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/what-the-repo-nginx-reload.sh

nginx -t
systemctl reload nginx
echo "public Nginx edge installed for $DOMAIN"
